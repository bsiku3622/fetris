import { Game } from "./game.js";
import type { InputCommands } from "./game.js";
import type { Handling, RuleSet } from "./types.js";

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
// 검증용 제출(참가자별 입력 로그)은 어디까지나 재료다. 사람이 다시 보고 싶은
// 것은 "그 판"이지 한 사람의 키 로그가 아니므로, 참가자들의 로그를 한 파일로
// 묶어 모든 보드를 나란히 재생할 수 있게 한다.
//
// 각 참가자의 보드는 자기 시드·키·받은 가비지만으로 독립적으로 재현되므로,
// 재생기는 N개를 같은 프레임으로 함께 진행하기만 하면 된다.
// ============================================================================

/** 매치 리플레이 포맷 버전 */
export const MATCH_REPLAY_FORMAT = 2;

/** 매치 리플레이 안의 참가자 한 명 */
export interface MatchReplayPlayerEntry {
  id: string;
  nick: string;
  /** 이 판에서의 순위(1 = 우승). 미확정이면 없음 */
  placement?: number;
  seed: number;
  /**
   * 이 사람이 쓴 핸들링(DAS/ARR 등). 감도는 마우스 감도처럼 개인 설정이라
   * 참가자마다 다를 수 있고, 다르면 같은 키 로그도 다르게 전개된다.
   * 없으면 파일 공통값을 쓴다(옛 기록 호환).
   */
  handling?: Handling;
  frames: number;
  keys: ReplayKeys;
  garbage?: ReplayGarbage;
  fingerprint: string;
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
}

/** 여러 보드를 같은 프레임으로 함께 돌리는 재생기 */
export class MatchReplayPlayer {
  /** 참가자별 재생기 — players와 같은 순서 */
  readonly boards: ReplayPlayer[];
  /** 가장 오래 버틴 사람 기준 총 프레임 */
  readonly frames: number;

  constructor(file: MatchReplayFile) {
    this.boards = file.players.map(
      (p) =>
        new ReplayPlayer({
          rule: file.rule,
          handling: p.handling ?? file.handling,
          seed: p.seed,
          keys: p.keys,
          garbage: p.garbage,
          frames: p.frames,
          simRate: file.simRate,
        }),
    );
    this.frames = this.boards.reduce((m, b) => Math.max(m, b.frames), 0);
  }

  get frame(): number {
    return this.boards.reduce((m, b) => Math.max(m, b.frame), 0);
  }

  get done(): boolean {
    return this.boards.every((b) => b.done);
  }

  /** 한 프레임 진행. 이미 끝난 보드는 그 자리에 멈춰 있다 */
  step(): boolean {
    let moved = false;
    for (const b of this.boards) {
      if (b.step()) {
        b.game.events.length = 0;
        moved = true;
      }
    }
    return moved;
  }

  seek(target: number): void {
    for (const b of this.boards) b.seek(target);
  }

  reset(): void {
    for (const b of this.boards) b.reset();
  }
}

/** 매치 파일의 참가자별 무결성 검사 */
export function verifyMatchReplayFile(
  file: MatchReplayFile,
): { id: string; nick: string; ok: boolean; actual: string }[] {
  return file.players.map((p) => {
    const { ok, actual } = verifyReplay(
      {
        rule: file.rule,
        handling: p.handling ?? file.handling,
        seed: p.seed,
        keys: p.keys,
        garbage: p.garbage,
        frames: p.frames,
        simRate: file.simRate,
      },
      p.fingerprint,
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
