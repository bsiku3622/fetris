import { Piece, Rot, SpinType, LastAction } from "./types";
import type { Handling, RuleSet, Stats, ClearResult } from "./types";
import { Board } from "./board";
import { Randomizer, Queue } from "./randomizer";
import type { QueueSnapshot } from "./randomizer";
import { shapeOf, spawnX, ALL_PIECES } from "./pieces";
import { getKickset } from "./srs";
import { detectSpin } from "./spin";
import { finesseFault } from "./finesse";
import { B2BSurge } from "./scoring";
import { HandlingController, softDropGravity } from "./handling";

// ============================================================================
// Game — 결정론적 코어. update(dtFrames, input)로 한 시뮬 스텝 진행.
// 렌더/오디오는 events 버퍼를 드레인해 반응한다 (게임은 그리기를 모른다).
// ============================================================================

export const enum Phase {
  Ready = 0, // 시작 카운트다운
  Playing = 1,
  LineClear = 2, // 라인클리어 딜레이
  Are = 3, // 스폰 딜레이
  GameOver = 4,
  Paused = 5,
}

export const enum EventType {
  Spawn,
  Move,
  Rotate,
  HardDrop,
  SoftLock,
  Hold,
  LineClear,
  Spin,
  SpinDetect, // 회전으로 스핀이 성립한 순간(즉시 사운드용)
  PerfectClear,
  LevelUp,
  TopOut,
  Hit, // 벽/바닥 충돌(이동 실패)
  Combo,
  B2B,
}

export interface GameEvent {
  type: EventType;
  // 다목적 페이로드 (할당 최소화를 위해 평탄 필드)
  a?: number;
  b?: number;
  piece?: Piece;
  spin?: SpinType;
  clear?: ClearResult;
  cells?: number[]; // 보이는 영역 [col,row, ...] (락 플래시용)
}

/** 한 시뮬 틱에 게임에 들어오는 입력 명령 */
export interface InputCommands {
  rotateCW: boolean;
  rotateCCW: boolean;
  rotate180: boolean;
  hardDrop: boolean;
  hold: boolean;
  softDropHeld: boolean;
  // 좌우 이동은 HandlingController가 직접 관리하므로 여기엔 없음
}

/** 전체 게임 상태 직렬화(Zen 이어하기 저장용) */
export interface GameSnapshot {
  grid: number[];
  cur: Piece;
  rot: Rot;
  px: number;
  py: number;
  hold: Piece;
  canHold: boolean;
  queue: QueueSnapshot; // 버퍼 + 랜더마이저 내부 상태(가방 desync 방지)
  buf?: Piece[]; // 레거시 호환(구버전 저장)
  scoring: { b2b: number; combo: number; surge: number };
  stats: Stats;
}

/** undo 스냅샷 — 피스 한 턴 시작 시점의 상태 */
interface UndoSnap {
  grid: Int8Array;
  cur: Piece;
  rot: Rot;
  px: number;
  py: number;
  hold: Piece;
  canHold: boolean;
  queue: QueueSnapshot;
  scoring: { b2b: number; combo: number; surge: number };
  stats: Stats;
}

const EMPTY_CMD: InputCommands = {
  rotateCW: false,
  rotateCCW: false,
  rotate180: false,
  hardDrop: false,
  hold: false,
  softDropHeld: false,
};

export class Game {
  rule: RuleSet;
  board: Board;
  handling: HandlingController;
  private queue: Queue;
  private rand: Randomizer;
  private kickset = getKickset("SRS+");
  scoring: B2BSurge;
  stats: Stats;

  // 액티브 피스
  cur: Piece = Piece.None;
  rot: Rot = Rot.Spawn;
  px = 0;
  py = 0;
  holdPiece: Piece = Piece.None;
  canHold = true;
  softActive = false; // 소프트드롭 중 여부(렌더 반투명용)

  phase: Phase = Phase.Ready;
  private gravityAccum = 0;
  private lockTimer = 0;
  private lockResetCount = 0;
  private grounded = false;
  private lastAction: LastAction = LastAction.None;
  private usedKickIndex = 0;
  private pieceInputs = 0; // 현재 피스에 쓴 이동/회전 입력 수(finesse용)
  private phaseTimer = 0; // ARE/LineClear/Ready 카운트다운(프레임)
  private clearedRows: number[] = [];

  events: GameEvent[] = [];
  seed: number;
  gravityOverride: number | null = null; // 모드(BLITZ 등)가 중력을 덮어쓸 때
  undoEnabled = false; // Zen 등 샌드박스에서 Ctrl+Z 되돌리기 허용
  topOutResets = false; // Zen: 막히면 게임오버 대신 필드 리셋
  private undoStack: UndoSnap[] = [];

  constructor(rule: RuleSet, handling: Handling, seed: number) {
    this.rule = rule;
    this.seed = seed >>> 0;
    this.board = new Board(rule.cols, rule.rows, rule.bufferRows);
    this.rand = new Randomizer(rule.randomizer, this.seed);
    this.queue = new Queue(this.rand, Math.max(rule.nextCount, 5));
    this.kickset = getKickset(rule.kickset);
    this.scoring = new B2BSurge(rule);
    this.handling = new HandlingController(handling);
    this.stats = this.freshStats();
    this.phaseTimer = 60; // 1초 Ready
  }

  private freshStats(): Stats {
    return {
      score: 0,
      lines: 0,
      piecesPlaced: 0,
      attack: 0,
      startTime: -1,
      frame: 0,
      maxB2b: 0,
      maxCombo: 0,
      perfectClears: 0,
      holds: 0,
      finesseFaults: 0,
    };
  }

  reset(seed?: number): void {
    if (seed !== undefined) this.seed = seed >>> 0;
    this.board.clearGrid();
    this.queue.reset(this.seed);
    this.scoring.reset();
    this.handling.reset();
    this.undoStack.length = 0;
    this.stats = this.freshStats();
    this.cur = Piece.None;
    this.holdPiece = Piece.None;
    this.canHold = true;
    this.phase = Phase.Ready;
    this.phaseTimer = 60;
    this.gravityAccum = 0;
    this.lockTimer = 0;
    this.lockResetCount = 0;
    this.grounded = false;
    this.events.length = 0;
  }

  setHandling(h: Handling): void {
    this.handling.setHandling(h);
  }

  /** Zen/4-Wide/Combo 톱아웃 시 필드 리셋 — 보드·스코어·홀드·가방까지 깨끗이 초기화.
   *  (홀드 orphan/가방 꼬임 방지: 새 시드로 가방을 새로 채운다) */
  private resetField(): void {
    this.board.clearGrid();
    this.scoring.reset();
    this.undoStack.length = 0;
    this.holdPiece = Piece.None;
    this.canHold = true;
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    this.queue.reset(this.seed);
  }

  private push(type: EventType, ev?: Partial<GameEvent>): void {
    this.events.push({ type, ...ev });
  }

  // ---- 피스 생성/이동/회전 ------------------------------------------------

  private spawn(piece?: Piece): void {
    const p = piece ?? this.queue.shift();
    this.cur = p;
    this.rot = Rot.Spawn;
    this.px = spawnX(p, this.rule.cols);
    // 가이드라인 표준: 가시 영역 위(버퍼)에 스폰. 렌더러가 스폰존을 보여줌.
    this.py = this.rule.bufferRows - 2;
    this.gravityAccum = 0;
    this.lockTimer = 0;
    this.lockResetCount = 0;
    this.pieceInputs = 0;
    this.grounded = false;
    this.lastAction = LastAction.None;
    this.handling.onRotateOrSpawn();

    const shape = shapeOf(p, this.rot);
    // 스폰 위치 충돌 → 한 칸 위로 시도, 그래도 충돌이면 톱아웃
    if (this.board.collides(shape, this.px, this.py)) {
      if (!this.board.collides(shape, this.px, this.py - 1)) {
        this.py -= 1;
      } else if (this.rule.topOutEnabled || this.topOutResets) {
        if (this.topOutResets) {
          // Zen: 게임오버 대신 필드 리셋 후 계속(홀드·가방까지 초기화)
          this.resetField();
          this.py = this.rule.bufferRows - 2;
          this.push(EventType.TopOut); // 이펙트/사운드용(리셋 신호)
        } else {
          this.phase = Phase.GameOver;
          this.push(EventType.TopOut);
          return;
        }
      }
    }
    this.push(EventType.Spawn, { piece: p });
    this.pushUndo();
  }

  private pushUndo(): void {
    if (!this.undoEnabled) return;
    this.undoStack.push({
      grid: this.board.grid.slice(),
      cur: this.cur,
      rot: this.rot,
      px: this.px,
      py: this.py,
      hold: this.holdPiece,
      canHold: this.canHold,
      queue: this.queue.snapshot(),
      scoring: this.scoring.snapshot(),
      stats: { ...this.stats },
    });
    if (this.undoStack.length > 300) this.undoStack.shift();
  }

  /** Ctrl+Z: 마지막 피스 배치를 취소하고 직전 상태로 복원. 성공 시 true. */
  undo(): boolean {
    if (!this.undoEnabled || this.undoStack.length < 2) return false;
    this.undoStack.pop(); // 현재 피스 스냅샷 버림
    const s = this.undoStack[this.undoStack.length - 1]; // 직전 = 복원 대상
    this.board.grid.set(s.grid);
    this.cur = s.cur;
    this.rot = s.rot;
    this.px = s.px;
    this.py = s.py;
    this.holdPiece = s.hold;
    this.canHold = s.canHold;
    this.queue.restore(s.queue);
    this.scoring.restoreFrom(s.scoring);
    this.stats = { ...s.stats };
    // 피스 진행 상태 초기화
    this.gravityAccum = 0;
    this.lockTimer = 0;
    this.lockResetCount = 0;
    this.pieceInputs = 0;
    this.grounded = false;
    this.lastAction = LastAction.None;
    this.phase = Phase.Playing;
    this.push(EventType.Spawn, { piece: this.cur });
    return true;
  }

  /** 전체 상태 직렬화 (Zen 이어하기 등). 보드+현재피스+큐+홀드+B2B+통계 */
  serialize(): GameSnapshot {
    return {
      grid: Array.from(this.board.grid),
      cur: this.cur,
      rot: this.rot,
      px: this.px,
      py: this.py,
      hold: this.holdPiece,
      canHold: this.canHold,
      queue: this.queue.snapshot(),
      scoring: this.scoring.snapshot(),
      stats: { ...this.stats },
    };
  }

  /** 직렬화 상태 복원 → 즉시 재개(Playing). 큐/B2B/홀드/현재피스 모두 복원. */
  deserialize(s: GameSnapshot): void {
    if (!s || !Array.isArray(s.grid) || s.grid.length !== this.board.grid.length) return;
    this.board.grid.set(s.grid);
    this.cur = s.cur;
    this.rot = s.rot;
    this.px = s.px;
    this.py = s.py;
    this.holdPiece = s.hold;
    this.canHold = s.canHold;
    if (s.queue && Array.isArray(s.queue.buf) && s.queue.rand) this.queue.restore(s.queue);
    else if (Array.isArray(s.buf)) this.queue.restoreBuffer(s.buf); // 레거시 저장 호환
    if (s.scoring) this.scoring.restoreFrom(s.scoring);
    if (s.stats) this.stats = { ...s.stats };
    this.gravityAccum = 0;
    this.lockTimer = 0;
    this.lockResetCount = 0;
    this.grounded = false;
    this.lastAction = LastAction.None;
    this.undoStack.length = 0;
    this.phase = Phase.Playing; // 즉시 재개
  }

  private currentShape(): readonly number[] {
    return shapeOf(this.cur, this.rot);
  }

  tryMove(dx: number, dy: number): boolean {
    if (this.board.collides(this.currentShape(), this.px + dx, this.py + dy)) return false;
    this.px += dx;
    this.py += dy;
    if (dx !== 0) {
      this.lastAction = LastAction.Move;
      this.onMoveReset();
    }
    return true;
  }

  /** 수평 이동 명령(handling이 만든 셀 수). 충돌 전까지 이동, 실제 이동량 반환. */
  private moveHorizontal(cells: number): void {
    if (cells === 0) return;
    const dir = cells > 0 ? 1 : -1;
    let moved = 0;
    const n = Math.abs(cells);
    for (let i = 0; i < n; i++) {
      if (this.board.collides(this.currentShape(), this.px + dir, this.py)) break;
      this.px += dir;
      moved++;
    }
    if (moved > 0) {
      this.lastAction = LastAction.Move;
      this.onMoveReset();
      this.push(EventType.Move, { a: dir });
    } else if (n > 0) {
      this.push(EventType.Hit, { a: dir });
    }
  }

  private rotate(dir: 1 | -1 | 2): void {
    if (this.cur === Piece.O) return;
    if (dir === 2 && !this.rule.allow180) return;
    const from = this.rot;
    const to = ((from + (dir === 2 ? 2 : dir) + 4) % 4) as Rot;
    const kicks = this.kickset.get(this.cur, from, to);
    const shape = shapeOf(this.cur, to);

    for (let i = 0; i < kicks.length; i += 2) {
      const kx = kicks[i];
      // 킥은 y-up 표기 → 보드 y-down이므로 dy 부호 반전
      const ky = -kicks[i + 1];
      if (!this.board.collides(shape, this.px + kx, this.py + ky)) {
        this.px += kx;
        this.py += ky;
        this.rot = to;
        this.lastAction = LastAction.Rotate;
        this.usedKickIndex = i / 2;
        this.handling.onRotateOrSpawn();
        this.onMoveReset();
        this.push(EventType.Rotate, { a: dir });
        // 회전 직후 스핀 성립 여부 → 즉시 사운드용 이벤트
        const spinNow = detectSpin(this.board, this.cur, this.rot, this.px, this.py, true, this.usedKickIndex, this.rule.spinBonus);
        if (spinNow !== SpinType.None) this.push(EventType.SpinDetect, { piece: this.cur, spin: spinNow });
        return;
      }
    }
    this.push(EventType.Hit);
  }

  /** 이동/회전 시 lock delay 리셋 (grounded 상태에서만, 횟수 제한) */
  private onMoveReset(): void {
    if (this.grounded && this.lockResetCount < this.rule.lockResets) {
      this.lockTimer = 0;
      this.lockResetCount++;
    }
  }

  private hold(): void {
    if (!this.rule.holdEnabled) return;
    if (!this.canHold && !this.rule.infiniteHold) return;
    const prev = this.holdPiece;
    this.holdPiece = this.cur;
    this.canHold = this.rule.infiniteHold;
    this.stats.holds++;
    this.push(EventType.Hold, { piece: this.cur });
    if (prev === Piece.None) {
      this.spawn();
    } else {
      this.spawn(prev);
    }
  }

  private hardDrop(): void {
    if (!this.rule.allowHardDrop) return;
    let dist = 0;
    while (!this.board.collides(this.currentShape(), this.px, this.py + 1)) {
      this.py++;
      dist++;
    }
    this.stats.score += dist * 2;
    // 트레일용 컬럼 범위
    const shape = this.currentShape();
    let minX = 99;
    let maxX = -1;
    for (let i = 0; i < 8; i += 2) {
      const cx = this.px + shape[i];
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
    }
    this.push(EventType.HardDrop, { a: dist, cells: [minX, maxX + 1] });
    this.lockPiece();
  }

  private lockPiece(): void {
    const shape = this.currentShape();
    // 락 플래시용: 놓인 피스의 보드-행 좌표(렌더러가 화면 좌표로 매핑)
    const flashCells: number[] = [];
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < 8; i += 2) {
      flashCells.push(this.px + shape[i], this.py + shape[i + 1]);
      sumX += this.px + shape[i];
      sumY += this.py + shape[i + 1];
    }
    const centroid: [number, number] = [sumX / 4, sumY / 4]; // 보드 좌표 중심(스파이크 위치)
    // finesse fault (락 직전 위치 기준)
    const fault = finesseFault(this.cur, this.pieceInputs, this.px, this.rot, this.rule.cols);
    if (fault > 0) this.stats.finesseFaults += fault;
    // 스핀 판정 (락 직전)
    const spin = detectSpin(this.board, this.cur, this.rot, this.px, this.py, this.lastAction === LastAction.Rotate, this.usedKickIndex, this.rule.spinBonus);

    // 락아웃 판정 — 클리어 없이 피스 전체가 가시 영역 위(버퍼)에서 잠기면 톱아웃
    let lockedAllAbove = true;
    for (let i = 0; i < 8; i += 2) {
      if (this.py + shape[i + 1] >= this.board.bufferRows) {
        lockedAllAbove = false;
        break;
      }
    }

    this.board.place(shape, this.px, this.py, this.cur);
    this.stats.piecesPlaced++;

    const cleared = this.board.clearLines(this.clearedRows);

    // 락아웃 처리 (클리어 0 + 전부 위 + topOut 활성 또는 Zen 리셋)
    if (cleared === 0 && lockedAllAbove && (this.rule.topOutEnabled || this.topOutResets)) {
      this.canHold = true;
      this.cur = Piece.None;
      if (this.topOutResets) {
        this.resetField();
        this.push(EventType.TopOut);
        this.phase = Phase.Are;
        this.phaseTimer = this.rule.are;
      } else {
        this.phase = Phase.GameOver;
        this.push(EventType.TopOut);
      }
      return;
    }
    const isPC = cleared > 0 && this.board.isEmpty();
    const result = this.scoring.process(cleared, spin, this.cur, isPC, this.rule);

    this.stats.lines += cleared;
    this.stats.attack += result.attack;
    if (result.b2b > this.stats.maxB2b) this.stats.maxB2b = result.b2b;
    if (result.combo > this.stats.maxCombo) this.stats.maxCombo = result.combo;
    if (isPC) this.stats.perfectClears++;

    if (spin !== SpinType.None) {
      this.push(EventType.Spin, { piece: this.cur, spin, a: cleared });
    }
    if (cleared > 0) {
      this.push(EventType.LineClear, { a: cleared, clear: result, spin, piece: this.cur, cells: centroid });
      if (isPC) this.push(EventType.PerfectClear);
      if (result.combo > 1) this.push(EventType.Combo, { a: result.combo });
      if (result.b2bEligible && result.b2b > 1) this.push(EventType.B2B, { a: result.b2b });
      this.push(EventType.SoftLock, { cells: flashCells });
      this.phase = Phase.LineClear;
      this.phaseTimer = this.rule.lineClearAre;
    } else {
      this.push(EventType.SoftLock, { cells: flashCells });
      this.phase = Phase.Are;
      this.phaseTimer = this.rule.are;
    }
    this.canHold = true;
    this.cur = Piece.None;
  }

  // ---- 메인 스텝 ----------------------------------------------------------

  /**
   * 한 시뮬 틱 진행.
   * @param dtFrames 60Hz 기준 프레임 수 (보통 1.0)
   * @param cmd 이번 틱 입력
   * @param now performance.now() (startTime 기록용)
   */
  update(dtFrames: number, cmd: InputCommands = EMPTY_CMD, now = 0): void {
    // 실제 플레이 중에만 프레임 카운트 (Ready/GameOver/Paused 제외 → 타이머 정확)
    if (this.phase === Phase.Playing || this.phase === Phase.LineClear || this.phase === Phase.Are) {
      this.stats.frame += dtFrames;
    }

    switch (this.phase) {
      case Phase.Ready:
        this.phaseTimer -= dtFrames;
        if (this.phaseTimer <= 0) {
          this.phase = Phase.Playing;
          this.stats.startTime = now;
          this.spawn();
        }
        return;
      case Phase.LineClear:
      case Phase.Are:
        this.phaseTimer -= dtFrames;
        if (this.phaseTimer <= 0) {
          this.phase = Phase.Playing;
          this.spawn();
        }
        return;
      case Phase.GameOver:
      case Phase.Paused:
        return;
    }

    // Playing
    if (this.cur === Piece.None) {
      this.spawn();
      if (this.phase !== Phase.Playing) return;
    }
    this.softActive = cmd.softDropHeld; // 소프트드롭 중(반투명 렌더)

    // 1) 회전/홀드 (이산 입력)
    if (cmd.hold) this.hold();
    if (this.cur === Piece.None) return; // 홀드로 재스폰 중 톱아웃 등
    if (cmd.rotateCW) {
      this.pieceInputs++;
      this.rotate(1);
    }
    if (cmd.rotateCCW) {
      this.pieceInputs++;
      this.rotate(-1);
    }
    if (cmd.rotate180) {
      this.pieceInputs++;
      this.rotate(2);
    }

    // 1.5) 하드드롭 — 즉시 락하고 종료 (safelock은 입력단의 키-릴리즈 게이트로 처리)
    if (cmd.hardDrop) {
      this.hardDrop();
      return;
    }

    // 2/3) 수평 이동 + 중력 — preferSoftDrop이면 소프트드롭을 이동보다 먼저
    const baseG = this.gravityOverride ?? this.rule.gravity;
    let g = baseG * dtFrames;
    if (cmd.softDropHeld) {
      const sg = softDropGravity(baseG, this.handling.h.sdf);
      g = isFinite(sg) ? Math.max(g, sg * dtFrames) : 9999;
    }
    const doMove = () => {
      const hmove = this.handling.update(dtFrames);
      if (hmove !== 0) this.moveHorizontal(hmove);
    };
    const doGravity = () => this.applyGravity(g, cmd.softDropHeld);

    if (this.handling.h.preferSoftDrop && cmd.softDropHeld) {
      doGravity();
      doMove();
    } else {
      doMove();
      doGravity();
    }

    // 4) lock delay
    this.updateLock(dtFrames);
  }

  private applyGravity(g: number, soft: boolean): void {
    if (g <= 0) return;
    this.gravityAccum += g;
    let dropped = 0;
    while (this.gravityAccum >= 1) {
      if (this.board.collides(this.currentShape(), this.px, this.py + 1)) {
        this.gravityAccum = 0;
        break;
      }
      this.py++;
      dropped++;
      this.gravityAccum -= 1;
      // 떨어지면 lock reset 카운트 초기화(공중에 떴으므로)
      this.lockResetCount = 0;
    }
    if (soft && dropped > 0) this.stats.score += dropped; // 소프트드롭 1점/칸
  }

  private updateLock(dtFrames: number): void {
    const onGround = this.board.collides(this.currentShape(), this.px, this.py + 1);
    if (onGround) {
      if (!this.grounded) {
        this.grounded = true;
        this.lockTimer = 0;
      }
      this.lockTimer += dtFrames;
      if (this.lockTimer >= this.rule.lockDelay) {
        this.lockPiece();
      }
    } else {
      this.grounded = false;
      this.lockTimer = 0;
    }
  }

  // ---- 외부 입력 진입점 (handling press/release는 직접 호출) ---------------

  pressDir(dir: -1 | 1): void {
    // finesse: 활성 피스가 있을 때의 방향 입력만 카운트
    if (this.phase === Phase.Playing && this.cur !== Piece.None) this.pieceInputs++;
    this.handling.press(dir);
  }
  releaseDir(dir: -1 | 1): void {
    this.handling.release(dir);
  }

  pause(): void {
    if (this.phase === Phase.Playing) this.phase = Phase.Paused;
  }
  resume(): void {
    if (this.phase === Phase.Paused) this.phase = Phase.Playing;
  }

  /** Ready 페이즈 남은 프레임(없으면 -1). 카운트다운 표시용. */
  get readyTimer(): number {
    return this.phase === Phase.Ready ? this.phaseTimer : -1;
  }

  /** 부드러운 낙하용 sub-cell 오프셋(0..1). 바닥에 닿으면 0. */
  get subCellFall(): number {
    if (this.cur === Piece.None) return 0;
    if (this.board.collides(this.currentShape(), this.px, this.py + 1)) return 0;
    return this.gravityAccum < 1 ? this.gravityAccum : 0;
  }

  /** 고스트 피스 y 위치 계산 */
  ghostY(): number {
    if (this.cur === Piece.None) return this.py;
    let y = this.py;
    const shape = this.currentShape();
    while (!this.board.collides(shape, this.px, y + 1)) y++;
    return y;
  }

  nextPieces(count: number): Piece[] {
    return this.queue.peek(count);
  }

  isGameOver(): boolean {
    return this.phase === Phase.GameOver;
  }
}

export { ALL_PIECES };
