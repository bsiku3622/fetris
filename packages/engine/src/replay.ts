import { Game } from "./game.js";
import type { GameSnapshot, InputCommands } from "./game.js";
import type { Handling, RuleSet, PlanGhost } from "./types.js";

// ============================================================================
// 리플레이 — 원시 키 입력을 프레임 단위로 기록하고, 같은 조건에서 재현한다.
//
// 서버 사이드 검증의 토대다. 클라이언트가 제출한 입력 로그를 서버가 이 함수로
// 다시 돌려 최종 상태를 대조하면, 보드를 직접 들여다보지 않고도 결과가
// 조작됐는지 판별할 수 있다.
//
// 재현이 성립하는 이유: Game.pressDir/releaseDir은 상태만 바꾸고 실제 이동은
// update()에서 일어난다. 즉 프레임 중간에 누른 키의 효과는 어차피 다음
// update부터 나타나므로, "프레임 F의 update 직전에 적용"으로 기록하면
// 원본과 정확히 같은 전개가 나온다.
//
// 주의: simRate가 다르면 결과도 다르다(update(1) 한 번 ≠ update(0.5) 두 번).
// 반드시 기록 당시의 simRate로 재현해야 한다.
// ============================================================================

/** 로그에 담기는 입력 종류 */
export const enum ReplayAction {
  MoveLeft = 0,
  MoveRight = 1,
  SoftDrop = 2,
  RotateCW = 3,
  RotateCCW = 4,
  Rotate180 = 5,
  Hold = 6,
  HardDrop = 7,
}

/**
 * 입력 로그의 평탄 인코딩 — [frame, action, down, frame, action, down, ...].
 * 배열 하나로 직렬화되므로 JSON 페이로드가 작다.
 */
export type ReplayKeys = number[];

/**
 * 받은 가비지 로그 — [frame, n, hole0..holeN-1, frame, n, ...].
 *
 * 대전에서는 키 입력만으로 판이 결정되지 않는다. 상대가 보낸 가비지는 바깥에서
 * 들어오는 입력이라, 이걸 같이 기록해야 재현이 성립한다.
 *
 * 주의: 이 로그는 제출자가 스스로 신고하는 값이다. 서버 검증은 "제출한 입력이
 * 정말 그 결과를 만드는가"를 보는 것이지, 받은 가비지가 진짜인지까지 보증하지는
 * 않는다(서버는 게임 페이로드를 해석하지 않고 중계만 한다).
 */
export type ReplayGarbage = number[];

export interface ReplayOptions {
  rule: RuleSet;
  handling: Handling;
  seed: number;
  keys: ReplayKeys;
  /** 대전에서 받은 가비지(싱글이면 없음) */
  garbage?: ReplayGarbage;
  /** 시뮬레이션한 총 프레임 수 */
  frames: number;
  /** 기록 당시의 simRate(60/120/240) */
  simRate: number;
}

const EMPTY_CMD: InputCommands = {
  rotateCW: false,
  rotateCCW: false,
  rotate180: false,
  hardDrop: false,
  hold: false,
  softDropHeld: false,
};

/**
 * 프레임 단위 재생기 — 뷰어가 재생/정지/탐색을 할 수 있도록 한 스텝씩 진행한다.
 * `runReplay`는 이 클래스를 끝까지 돌리는 얇은 래퍼다.
 */
export class ReplayPlayer {
  readonly game: Game;
  /** 총 프레임 수 */
  readonly frames: number;
  /** 지금까지 진행한 프레임 */
  frame = 0;

  private opts: ReplayOptions;
  private dt: number;
  private cmd: InputCommands = { ...EMPTY_CMD };
  private softHeld = false;
  private ki = 0;
  private gi = 0;

  constructor(opts: ReplayOptions) {
    this.opts = opts;
    this.frames = opts.frames;
    this.dt = 60 / opts.simRate;
    this.game = new Game(opts.rule, opts.handling, opts.seed);
  }

  get done(): boolean {
    return this.frame >= this.frames;
  }

  /** 한 프레임 진행. 끝에 도달했으면 false */
  step(): boolean {
    if (this.done) return false;
    const { keys } = this.opts;
    const cmd = this.cmd;

    cmd.rotateCW = false;
    cmd.rotateCCW = false;
    cmd.rotate180 = false;
    cmd.hardDrop = false;
    cmd.hold = false;

    // 이번 프레임에 들어온 입력을 순서대로 적용
    while (this.ki + 2 < keys.length && keys[this.ki] === this.frame) {
      const action = keys[this.ki + 1];
      const down = keys[this.ki + 2] === 1;
      switch (action) {
        case ReplayAction.MoveLeft:
          if (down) this.game.pressDir(-1);
          else this.game.releaseDir(-1);
          break;
        case ReplayAction.MoveRight:
          if (down) this.game.pressDir(1);
          else this.game.releaseDir(1);
          break;
        case ReplayAction.SoftDrop:
          this.softHeld = down;
          break;
        case ReplayAction.RotateCW:
          if (down) cmd.rotateCW = true;
          break;
        case ReplayAction.RotateCCW:
          if (down) cmd.rotateCCW = true;
          break;
        case ReplayAction.Rotate180:
          if (down) cmd.rotate180 = true;
          break;
        case ReplayAction.Hold:
          if (down) cmd.hold = true;
          break;
        case ReplayAction.HardDrop:
          if (down) cmd.hardDrop = true;
          break;
      }
      this.ki += 3;
    }

    // 이번 프레임에 도착한 가비지를 큐에 적재(실제 판에서도 update 직전에 쌓였다)
    const garbage = this.opts.garbage;
    if (garbage) {
      while (this.gi + 1 < garbage.length && garbage[this.gi] === this.frame) {
        const n = garbage[this.gi + 1];
        // 손상된 로그가 무한 루프를 만들지 않도록 막는다
        if (!Number.isInteger(n) || n <= 0 || this.gi + 2 + n > garbage.length) {
          this.gi = garbage.length;
          break;
        }
        this.game.receiveGarbage({ holes: garbage.slice(this.gi + 2, this.gi + 2 + n) });
        this.gi += 2 + n;
      }
    }

    cmd.softDropHeld = this.softHeld;
    this.game.update(this.dt, cmd, 0);
    this.frame++;
    return true;
  }

  /**
   * 특정 프레임으로 이동한다. 뒤로 가려면 처음부터 다시 돌리는 수밖에 없다 —
   * 시뮬레이션에는 되감기가 없기 때문이다(상태 스냅샷을 쌓으면 빨라지지만,
   * 몇 천 프레임 재현은 수십 ms라 그럴 만큼 비싸지 않다).
   */
  seek(target: number): void {
    const goal = Math.max(0, Math.min(this.frames, Math.floor(target)));
    if (goal < this.frame) this.reset();
    while (this.frame < goal && this.step()) {
      this.game.events.length = 0;
    }
  }

  /** 처음으로 되돌린다 */
  reset(): void {
    this.game.reset(this.opts.seed);
    this.frame = 0;
    this.ki = 0;
    this.gi = 0;
    this.softHeld = false;
    this.cmd = { ...EMPTY_CMD };
  }
}

/** 입력 로그를 그대로 재생해 최종 Game 상태를 만든다 */
export function runReplay(opts: ReplayOptions): Game {
  const player = new ReplayPlayer(opts);
  while (player.step()) {
    player.game.events.length = 0;
  }
  return player.game;
}

/**
 * 상태 지문 — 스냅샷 전체를 주고받지 않고 한 문자열로 대조한다.
 * FNV-1a 32비트. 암호학적 강도는 필요 없다(위조가 아니라 불일치 탐지가 목적).
 *
 * stats.startTime만 빼고 해시한다 — performance.now() 기준 벽시계라 재현본과
 * 같아질 수가 없다. 나머지 stats는 전부 시뮬레이션에서 나온 값이다.
 */
export function fingerprint(game: Game): string {
  const raw = game.serialize();
  const snap = JSON.stringify({ ...raw, stats: { ...raw.stats, startTime: 0 } });
  let h = 0x811c9dc5;
  for (let i = 0; i < snap.length; i++) {
    h ^= snap.charCodeAt(i);
    // 32비트 곱셈을 오버플로 없이 — Math.imul은 명세가 정확한 값을 강제한다
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 로그를 재현해 지문까지 계산한다(서버 검증의 단일 진입점) */
export function verifyReplay(opts: ReplayOptions, expected: string): {
  ok: boolean;
  actual: string;
} {
  const game = runReplay(opts);
  const actual = fingerprint(game);
  return { ok: actual === expected, actual };
}

/** 리플레이 파일 포맷 버전 — 구조가 바뀌면 올린다 */
export const REPLAY_FORMAT = 1;

/**
 * 내려받는 리플레이 파일.
 *
 * 재생에 필요한 것을 전부 담는다 — 시드·룰·핸들링·simRate가 하나라도 빠지면
 * 같은 판을 다시 만들 수 없다. `runReplay`에 그대로 넘길 수 있는 형태다.
 */
export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  game: "fetris";
  /** ISO 8601 */
  recordedAt: string;
  match: {
    /** 방 코드(로컬 판이면 없음) */
    code?: string;
    matchId: number;
  };
  player: {
    /** 방 안에서의 고유 id — 닉은 겹칠 수 있어서 이걸로 구분한다 */
    id?: string;
    nick: string;
    /** 이 판에서의 순위(1 = 우승). 미확정이면 없음 */
    placement?: number;
  };
  /** runReplay에 그대로 넘기는 조건들 */
  rule: RuleSet;
  handling: Handling;
  simRate: number;
  seed: number;
  frames: number;
  keys: ReplayKeys;
  /** 대전에서 받은 가비지(싱글 판이면 없음) */
  garbage?: ReplayGarbage;
  /** 최종 상태 지문 — 재생 결과와 대조해 파일이 온전한지 확인한다 */
  fingerprint: string;
  /** 참고용 최종 성적(재생에는 쓰이지 않는다) */
  stats?: {
    piecesPlaced: number;
    lines: number;
    attack: number;
  };
}

// ============================================================================
// 매치 리플레이 — 판 하나를 통째로.
//
// 판을 다시 보는 근거는 두 가지고, 둘 다 담는다.
//
//  1. 서버 녹화(timeline) — 서버가 중계하면서 받아 적은 보드 스냅샷들.
//     참가자가 아무것도 내주지 않아도 남으므로 이게 바닥이다. 매끄러움은
//     스냅샷 주기만큼이라, 관전자가 실시간으로 보던 것과 같은 수준이다.
//
//  2. 입력 로그(keys) — 낸 참가자에 한해 60Hz로 정확히 다시 돌릴 수 있다.
//     검증에 쓰는 그 로그이고, 있으면 재생이 매끄러워진다.
//
// 그래서 재생기는 참가자마다 둘 중 가능한 쪽을 골라 같은 시계 위에서 굴린다.
// ============================================================================

/** 매치 리플레이 포맷 버전 */
export const MATCH_REPLAY_FORMAT = 3;

/**
 * 서버 녹화의 한 장면 — 어느 시점에 누구 보드가 어떠했는지.
 * 표시 전용 계획 고스트도 같은 시간축에 섞여 들어온다.
 */
export interface MatchReplayFrame {
  /** 판 시작 후 경과 ms */
  ms: number;
  id: string;
  snap?: GameSnapshot;
  /** 봇이 띄운 계획 고스트(빈 배열이면 그 시점에 지운 것) */
  plan?: PlanGhost[];
}

/** 매치 리플레이 안의 참가자 한 명 */
export interface MatchReplayPlayerEntry {
  id: string;
  nick: string;
  /** 이 판에서의 순위(1 = 우승). 미확정이면 없음 */
  placement?: number;
  /** 입력 로그가 있을 때만 — 없으면 서버 녹화로 재생한다 */
  seed?: number;
  /**
   * 이 사람이 쓴 핸들링(DAS/ARR 등). 감도는 마우스 감도처럼 개인 설정이라
   * 참가자마다 다를 수 있고, 다르면 같은 키 로그도 다르게 전개된다.
   * 없으면 파일 공통값을 쓴다(옛 기록 호환).
   */
  handling?: Handling;
  frames?: number;
  keys?: ReplayKeys;
  garbage?: ReplayGarbage;
  fingerprint?: string;
  /** 참고용 최종 성적(재생에는 쓰이지 않는다) */
  stats?: { piecesPlaced: number; lines: number; attack: number };
}

export interface MatchReplayFile {
  format: typeof MATCH_REPLAY_FORMAT;
  game: "fetris";
  /** ISO 8601 */
  recordedAt: string;
  match: {
    code?: string;
    matchId: number;
    /** 우승자 id(무승부면 없음) */
    winnerId?: string;
  };
  /** 방이 정한 공통 조건 */
  rule: RuleSet;
  /** 핸들링을 따로 남기지 않은 참가자에게 쓰는 기본값 */
  handling: Handling;
  simRate: number;
  /** 순위 순으로 담는다(1위가 앞) */
  players: MatchReplayPlayerEntry[];
  /** 서버 녹화 — 입력 로그가 없는 참가자는 이걸로 재생한다 */
  timeline?: MatchReplayFrame[];
  /** 녹화가 상한에 걸려 뒷부분이 잘렸는지 */
  truncated?: boolean;
}

/**
 * 입력 로그가 없는 참가자의 보드 — 서버가 남긴 스냅샷을 시간에 맞춰 얹는다.
 * 시뮬레이션이 아니라 재생이므로 스냅샷 사이는 그대로 멈춰 있다.
 */
class SnapshotBoard {
  readonly game: Game;
  /** 이 사람 몫만 시간순으로 추린 스냅샷 */
  private shots: MatchReplayFrame[];
  private idx = 0;

  constructor(rule: RuleSet, handling: Handling, shots: MatchReplayFrame[]) {
    this.game = new Game(rule, handling, 0);
    this.shots = shots;
  }

  /** 경과 ms 시점의 상태로 맞춘다 */
  applyAt(ms: number): void {
    // 뒤로 갔으면 처음부터 다시 훑는다(스냅샷은 상태 그 자체라 되감기가 싸다)
    if (this.idx > 0 && this.shots[this.idx - 1].ms > ms) this.idx = 0;
    let applied = -1;
    while (this.idx < this.shots.length && this.shots[this.idx].ms <= ms) {
      applied = this.idx;
      this.idx++;
    }
    const snap = applied >= 0 ? this.shots[applied].snap : undefined;
    if (snap) this.game.deserialize(snap);
  }

  reset(): void {
    this.idx = 0;
  }
}

/**
 * 여러 보드를 같은 시계 위에서 함께 돌리는 재생기.
 *
 * 입력 로그가 있는 참가자는 60Hz로 다시 시뮬레이션하고, 없는 참가자는 서버
 * 녹화 스냅샷을 시간에 맞춰 얹는다. 둘이 섞여 있어도 같은 프레임으로 흐른다.
 */
export class MatchReplayPlayer {
  /** 참가자별 보드(players와 같은 순서) */
  readonly boards: { game: Game }[];
  /** 판 전체 길이(프레임) */
  readonly frames: number;
  /** 지금까지 진행한 프레임 */
  frame = 0;

  private sims: (ReplayPlayer | null)[];
  private shots: (SnapshotBoard | null)[];
  /**
   * 참가자별 계획 고스트 — 게임 상태가 아니라 그 시점에 화면에 떠 있던 표시다.
   * 입력 로그로 재현하는 보드에도 붙는다(입력에서 유도할 수 없는 정보라 녹화에만 있다).
   */
  private planShots: MatchReplayFrame[][];
  private planIdx: number[];
  private planNow: (PlanGhost[] | undefined)[];

  constructor(file: MatchReplayFile) {
    const timeline = file.timeline ?? [];
    this.sims = [];
    this.shots = [];
    this.boards = file.players.map((p) => {
      // 입력 로그가 있으면 정확히 다시 돌린다
      if (p.keys && p.frames && p.seed !== undefined) {
        const sim = new ReplayPlayer({
          rule: file.rule,
          handling: p.handling ?? file.handling,
          seed: p.seed,
          keys: p.keys,
          garbage: p.garbage,
          frames: p.frames,
          simRate: file.simRate,
        });
        this.sims.push(sim);
        this.shots.push(null);
        return sim;
      }
      const board = new SnapshotBoard(
        file.rule,
        p.handling ?? file.handling,
        timeline.filter((f) => f.id === p.id && f.snap),
      );
      this.sims.push(null);
      this.shots.push(board);
      return board;
    });

    this.planShots = file.players.map((p) => timeline.filter((f) => f.id === p.id && f.plan));
    this.planIdx = file.players.map(() => 0);
    this.planNow = file.players.map(() => undefined);

    const simFrames = this.sims.reduce((m, s) => Math.max(m, s?.frames ?? 0), 0);
    const lastMs = timeline.length > 0 ? timeline[timeline.length - 1].ms : 0;
    this.frames = Math.max(simFrames, Math.ceil((lastMs / 1000) * 60));
  }

  get done(): boolean {
    return this.frame >= this.frames;
  }

  /** 한 프레임 진행. 이미 끝난 보드는 그 자리에 멈춰 있다 */
  step(): boolean {
    if (this.done) return false;
    this.frame++;
    for (const sim of this.sims) {
      if (sim && sim.step()) sim.game.events.length = 0;
    }
    const ms = (this.frame / 60) * 1000;
    for (const shot of this.shots) shot?.applyAt(ms);
    this.applyPlansAt(ms);
    return true;
  }

  /** 그 시점에 떠 있던 계획 고스트(없으면 undefined) */
  planOf(index: number): PlanGhost[] | undefined {
    return this.planNow[index];
  }

  /** 계획은 상태가 아니라 "그때 이게 떠 있었다"는 기록이라 되감기가 싸다 */
  private applyPlansAt(ms: number): void {
    for (let i = 0; i < this.planShots.length; i++) {
      const shots = this.planShots[i];
      if (shots.length === 0) continue;
      if (this.planIdx[i] > 0 && shots[this.planIdx[i] - 1].ms > ms) {
        this.planIdx[i] = 0;
        this.planNow[i] = undefined;
      }
      while (this.planIdx[i] < shots.length && shots[this.planIdx[i]].ms <= ms) {
        const plan = shots[this.planIdx[i]].plan;
        this.planNow[i] = plan && plan.length > 0 ? plan : undefined;
        this.planIdx[i]++;
      }
    }
  }

  seek(target: number): void {
    const goal = Math.max(0, Math.min(this.frames, Math.floor(target)));
    for (const sim of this.sims) sim?.seek(goal);
    const ms = (goal / 60) * 1000;
    for (const shot of this.shots) shot?.applyAt(ms);
    this.applyPlansAt(ms);
    this.frame = goal;
  }

  reset(): void {
    for (const sim of this.sims) sim?.reset();
    for (const shot of this.shots) shot?.reset();
    this.planIdx = this.planIdx.map(() => 0);
    this.planNow = this.planNow.map(() => undefined);
    this.frame = 0;
  }
}

/** 매치 파일의 참가자별 무결성 검사 */
export function verifyMatchReplayFile(
  file: MatchReplayFile,
): { id: string; nick: string; ok: boolean; actual: string }[] {
  // 입력 로그를 낸 사람만 대조할 수 있다. 서버 녹화만 있는 참가자는 상태를
  // 그대로 받아 적은 것이라 "재현해서 맞춰본다"는 개념 자체가 없다.
  return file.players
    .filter((p) => p.keys && p.frames && p.seed !== undefined && p.fingerprint)
    .map((p) => {
      const { ok, actual } = verifyReplay(
        {
          rule: file.rule,
          handling: p.handling ?? file.handling,
          seed: p.seed as number,
          keys: p.keys as ReplayKeys,
          garbage: p.garbage,
          frames: p.frames as number,
          simRate: file.simRate,
        },
        p.fingerprint as string,
      );
      return { id: p.id, nick: p.nick, ok, actual };
    });
}

/** 파일을 재생해 지문이 맞는지 확인한다(열어볼 때 무결성 검사) */
export function verifyReplayFile(file: ReplayFile): { ok: boolean; actual: string } {
  return verifyReplay(
    {
      rule: file.rule,
      handling: file.handling,
      seed: file.seed,
      keys: file.keys,
      garbage: file.garbage,
      frames: file.frames,
      simRate: file.simRate,
    },
    file.fingerprint,
  );
}

/**
 * 입력 기록기 — 클라이언트가 프레임 번호와 함께 키 변화를 쌓는다.
 * 게임 루프의 hot path에서 쓰이므로 배열 하나에 밀어 넣기만 한다.
 */
export class ReplayRecorder {
  readonly keys: ReplayKeys = [];
  /** 대전에서 받은 가비지 — 키만으로는 판이 결정되지 않는다 */
  readonly garbage: ReplayGarbage = [];
  /** 시뮬레이션이 진행한 프레임 수(정수로 누적) */
  frame = 0;

  /** 아직 반영되지 않은 입력 — 다음 프레임 경계에서 기록된다 */
  private pending: { action: ReplayAction; down: boolean }[] = [];
  private pendingGarbage: number[][] = [];

  push(action: ReplayAction, down: boolean): void {
    this.pending.push({ action, down });
  }

  /** 상대에게서 가비지를 받았을 때 — Game.receiveGarbage와 같은 자리에서 부른다 */
  pushGarbage(holes: readonly number[]): void {
    if (holes.length === 0) return;
    this.pendingGarbage.push(holes.slice());
  }

  /** 한 시뮬 스텝을 시작하기 직전에 호출 — 대기 중인 입력을 이번 프레임으로 확정한다 */
  commitFrame(): void {
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      this.keys.push(this.frame, p.action, p.down ? 1 : 0);
    }
    this.pending.length = 0;
    for (let i = 0; i < this.pendingGarbage.length; i++) {
      const holes = this.pendingGarbage[i];
      this.garbage.push(this.frame, holes.length, ...holes);
    }
    this.pendingGarbage.length = 0;
    this.frame++;
  }

  reset(): void {
    this.keys.length = 0;
    this.garbage.length = 0;
    this.pending.length = 0;
    this.pendingGarbage.length = 0;
    this.frame = 0;
  }
}
