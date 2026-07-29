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

export interface ReplayOptions {
  rule: RuleSet;
  handling: Handling;
  seed: number;
  keys: ReplayKeys;
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
 */
export function fingerprint(game: Game): string {
  const snap = JSON.stringify(game.serialize());
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
  /** 최종 상태 지문 — 재생 결과와 대조해 파일이 온전한지 확인한다 */
  fingerprint: string;
  /** 참고용 최종 성적(재생에는 쓰이지 않는다) */
  stats?: {
    piecesPlaced: number;
    lines: number;
    attack: number;
  };
}

/** 파일을 재생해 지문이 맞는지 확인한다(열어볼 때 무결성 검사) */
export function verifyReplayFile(file: ReplayFile): { ok: boolean; actual: string } {
  return verifyReplay(
    {
      rule: file.rule,
      handling: file.handling,
      seed: file.seed,
      keys: file.keys,
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
  /** 시뮬레이션이 진행한 프레임 수(정수로 누적) */
  frame = 0;

  /** 아직 반영되지 않은 입력 — 다음 프레임 경계에서 기록된다 */
  private pending: { action: ReplayAction; down: boolean }[] = [];

  push(action: ReplayAction, down: boolean): void {
    this.pending.push({ action, down });
  }

  /** 한 시뮬 스텝을 시작하기 직전에 호출 — 대기 중인 입력을 이번 프레임으로 확정한다 */
  commitFrame(): void {
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      this.keys.push(this.frame, p.action, p.down ? 1 : 0);
    }
    this.pending.length = 0;
    this.frame++;
  }

  reset(): void {
    this.keys.length = 0;
    this.pending.length = 0;
    this.frame = 0;
  }
}
