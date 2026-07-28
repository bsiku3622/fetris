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

/** 입력 로그를 그대로 재생해 최종 Game 상태를 만든다 */
export function runReplay(opts: ReplayOptions): Game {
  const game = new Game(opts.rule, opts.handling, opts.seed);
  const dt = 60 / opts.simRate;
  const cmd: InputCommands = { ...EMPTY_CMD };
  let softHeld = false;
  let ki = 0;

  for (let f = 0; f < opts.frames; f++) {
    cmd.rotateCW = false;
    cmd.rotateCCW = false;
    cmd.rotate180 = false;
    cmd.hardDrop = false;
    cmd.hold = false;

    // 이번 프레임에 들어온 입력을 순서대로 적용
    while (ki + 2 < opts.keys.length && opts.keys[ki] === f) {
      const action = opts.keys[ki + 1];
      const down = opts.keys[ki + 2] === 1;
      switch (action) {
        case ReplayAction.MoveLeft:
          if (down) game.pressDir(-1);
          else game.releaseDir(-1);
          break;
        case ReplayAction.MoveRight:
          if (down) game.pressDir(1);
          else game.releaseDir(1);
          break;
        case ReplayAction.SoftDrop:
          softHeld = down;
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
      ki += 3;
    }

    cmd.softDropHeld = softHeld;
    game.update(dt, cmd, 0);
    game.events.length = 0;
  }

  return game;
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
