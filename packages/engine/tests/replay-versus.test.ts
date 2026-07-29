import { describe, it, expect } from "vitest";
import { Game } from "../src/game.js";
import type { InputCommands } from "../src/game.js";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "../src/config.js";
import { runReplay, fingerprint, ReplayRecorder, ReplayAction } from "../src/replay.js";

// ============================================================================
// 대전 리플레이 — 키 입력만으로는 판이 결정되지 않는다.
//
// 상대가 보낸 가비지는 바깥에서 들어오는 입력이라, 기록에 함께 담기지 않으면
// 재현이 어긋난다(= 정상 플레이가 전부 replay-mismatch로 잡힌다).
// ============================================================================

const RULE = { ...STANDARD_RULESET, garbageEnabled: true };
const HANDLING = { ...DEFAULT_HANDLING };
const SEED = 777;
const FRAMES = 300;

/** 프레임 f에 도착하는 가비지(없으면 null) — 결정적으로 만든다 */
function garbageAt(f: number): number[] | null {
  if (f === 40) return [3, 3];
  if (f === 95) return [7, 7, 7, 7];
  if (f === 180) return [0];
  if (f === 181) return [5, 5, 5];
  return null;
}

/** 실제 대전 클라이언트가 하는 일을 흉내낸다 — 입력과 수신 가비지를 함께 기록 */
function playVersus(): { game: Game; recorder: ReplayRecorder } {
  const game = new Game(RULE, HANDLING, SEED);
  const recorder = new ReplayRecorder();
  const cmd: InputCommands = {
    rotateCW: false, rotateCCW: false, rotate180: false,
    hardDrop: false, hold: false, softDropHeld: false,
  };

  for (let f = 0; f < FRAMES; f++) {
    cmd.rotateCW = false;
    cmd.hardDrop = false;
    cmd.hold = false;

    // 가비지 수신은 네트워크 콜백에서 일어난다 — update 전에 즉시 반영되고,
    // 기록기에는 대기로 쌓였다가 다음 commitFrame에서 이번 프레임으로 확정된다.
    const holes = garbageAt(f);
    if (holes) {
      game.receiveGarbage({ holes });
      recorder.pushGarbage(holes);
    }

    if (f % 11 === 0) {
      recorder.push(ReplayAction.MoveRight, true);
      game.pressDir(1);
    }
    if (f % 11 === 5) {
      recorder.push(ReplayAction.MoveRight, false);
      game.releaseDir(1);
    }
    if (f % 8 === 3) {
      recorder.push(ReplayAction.RotateCW, true);
      cmd.rotateCW = true;
    }
    if (f % 13 === 6) {
      recorder.push(ReplayAction.HardDrop, true);
      cmd.hardDrop = true;
    }

    recorder.commitFrame();
    game.update(1, cmd, 9999.5); // 실제 판처럼 벽시계를 넘긴다
    game.events.length = 0;
  }
  return { game, recorder };
}

const opts = (rec: ReplayRecorder, garbage?: number[]) => ({
  rule: RULE,
  handling: HANDLING,
  seed: SEED,
  keys: rec.keys,
  garbage: garbage ?? rec.garbage,
  frames: FRAMES,
  simRate: 60,
});

describe("대전 리플레이", () => {
  it("받은 가비지까지 기록하면 그대로 재현된다", () => {
    const { game, recorder } = playVersus();
    expect(recorder.garbage.length).toBeGreaterThan(0);
    expect(game.stats.piecesPlaced).toBeGreaterThan(0);

    expect(fingerprint(runReplay(opts(recorder)))).toBe(fingerprint(game));
  });

  it("가비지 로그가 빠지면 재현이 어긋난다", () => {
    const { game, recorder } = playVersus();
    expect(fingerprint(runReplay(opts(recorder, [])))).not.toBe(fingerprint(game));
  });

  it("가비지를 줄여서 신고하면 잡힌다", () => {
    const { game, recorder } = playVersus();
    // 첫 청크(=[frame, n, ...holes])만 들어낸 로그
    const n = recorder.garbage[1];
    const trimmed = recorder.garbage.slice(2 + n);
    expect(fingerprint(runReplay(opts(recorder, trimmed)))).not.toBe(fingerprint(game));
  });

  it("기록기는 가비지를 프레임 경계에 맞춰 평탄하게 쌓는다", () => {
    const rec = new ReplayRecorder();
    rec.pushGarbage([2, 2]);
    rec.commitFrame(); // frame 0
    rec.commitFrame(); // frame 1 — 수신 없음
    rec.pushGarbage([4]);
    rec.pushGarbage([9, 9, 9]);
    rec.commitFrame(); // frame 2

    expect(rec.frame).toBe(3);
    expect(rec.garbage).toEqual([
      0, 2, 2, 2,
      2, 1, 4,
      2, 3, 9, 9, 9,
    ]);
  });

  it("손상된 가비지 로그를 만나도 재생이 멈추지 않는다", () => {
    const { recorder } = playVersus();
    // 길이 필드가 남은 배열보다 큰 경우 — 무한 루프나 예외 없이 끝나야 한다
    const broken = [10, 999, 1, 2, 3];
    expect(() => runReplay(opts(recorder, broken))).not.toThrow();
  });
});
