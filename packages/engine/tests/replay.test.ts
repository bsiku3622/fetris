import { describe, it, expect } from "vitest";
import { Game, READY_FRAMES } from "../src/game.js";
import type { InputCommands } from "../src/game.js";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "../src/config.js";
import { runReplay, verifyReplay, fingerprint, ReplayRecorder, ReplayAction } from "../src/replay.js";

// ============================================================================
// 리플레이 검증 — 서버가 클라이언트의 판을 그대로 다시 돌릴 수 있어야 한다.
// ============================================================================

const RULE = { ...STANDARD_RULESET };
const HANDLING = { ...DEFAULT_HANDLING };
const SEED = 4242;
// 이 입력 패턴은 판이 열린 뒤 264프레임쯤 톱아웃한다. 게임오버 뒤 입력은 결과에
// 영향을 주지 않아 변조 탐지를 검증할 수 없으므로, 살아 있는 구간만 다룬다.
// 앞의 Ready 구간은 아직 판이 열리기 전이라 그만큼 더 돌려야 한다.
const FRAMES = READY_FRAMES + 200;

/** 프레임 번호로부터 결정적으로 입력을 만든다(재현 가능한 시퀀스) */
function actionsAt(frame: number): { action: ReplayAction; down: boolean }[] {
  const out: { action: ReplayAction; down: boolean }[] = [];
  if (frame % 13 === 0) out.push({ action: ReplayAction.MoveLeft, down: true });
  if (frame % 13 === 5) out.push({ action: ReplayAction.MoveLeft, down: false });
  if (frame % 19 === 0) out.push({ action: ReplayAction.MoveRight, down: true });
  if (frame % 19 === 7) out.push({ action: ReplayAction.MoveRight, down: false });
  if (frame % 11 === 3) out.push({ action: ReplayAction.RotateCW, down: true });
  if (frame % 29 === 4) out.push({ action: ReplayAction.Hold, down: true });
  if (frame % 17 === 9) out.push({ action: ReplayAction.HardDrop, down: true });
  if (frame % 23 === 0) out.push({ action: ReplayAction.SoftDrop, down: true });
  if (frame % 23 === 6) out.push({ action: ReplayAction.SoftDrop, down: false });
  return out;
}

/**
 * 클라이언트가 실제로 하는 일을 흉내낸다 — 입력이 들어오면 즉시 Game에 반영하고
 * (방향키) 이산 명령은 다음 update로 넘긴다. 동시에 기록기에도 쌓는다.
 */
function playAndRecord(): { game: Game; recorder: ReplayRecorder } {
  const game = new Game(RULE, HANDLING, SEED);
  const recorder = new ReplayRecorder();
  const cmd: InputCommands = {
    rotateCW: false, rotateCCW: false, rotate180: false,
    hardDrop: false, hold: false, softDropHeld: false,
  };
  let softHeld = false;

  for (let f = 0; f < FRAMES; f++) {
    cmd.rotateCW = false;
    cmd.rotateCCW = false;
    cmd.rotate180 = false;
    cmd.hardDrop = false;
    cmd.hold = false;

    for (const { action, down } of actionsAt(f)) {
      recorder.push(action, down);
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
        case ReplayAction.Hold:
          if (down) cmd.hold = true;
          break;
        case ReplayAction.HardDrop:
          if (down) cmd.hardDrop = true;
          break;
      }
    }

    cmd.softDropHeld = softHeld;
    recorder.commitFrame();
    game.update(1, cmd, 0);
    game.events.length = 0;
  }

  return { game, recorder };
}

describe("리플레이", () => {
  it("기록한 입력을 재현하면 같은 상태가 나온다", () => {
    const { game, recorder } = playAndRecord();
    expect(recorder.frame).toBe(FRAMES);
    expect(recorder.keys.length).toBeGreaterThan(0);

    const replayed = runReplay({
      rule: RULE, handling: HANDLING, seed: SEED,
      keys: recorder.keys, frames: FRAMES, simRate: 60,
    });

    expect(fingerprint(replayed)).toBe(fingerprint(game));
  });

  it("올바른 지문은 통과하고 조작된 지문은 걸린다", () => {
    const { game, recorder } = playAndRecord();
    const opts = {
      rule: RULE, handling: HANDLING, seed: SEED,
      keys: recorder.keys, frames: FRAMES, simRate: 60,
    };

    const good = verifyReplay(opts, fingerprint(game));
    expect(good.ok).toBe(true);

    // "사실은 더 높은 점수였다"고 주장하는 경우
    const forged = verifyReplay(opts, "deadbeef");
    expect(forged.ok).toBe(false);
    expect(forged.actual).toBe(fingerprint(game));
  });

  it("입력을 하나라도 지우면 지문이 달라진다", () => {
    const { game, recorder } = playAndRecord();
    // 게임이 살아서 진행됐어야 의미 있는 대조가 된다
    expect(game.stats.piecesPlaced).toBeGreaterThan(0);
    expect(game.isGameOver()).toBe(false);

    /*
      판이 열린 뒤의 입력 하나를 들어낸다.

      앞의 Ready 구간에 눌린 키는 아직 조각이 없어 결과를 바꾸지 못하고, 맨 뒤
      입력은 이어지는 시뮬이 없어 마찬가지다 — 둘 다 변조 탐지에 쓸 수 없다.
    */
    const live: number[] = [];
    for (let i = 0; i < recorder.keys.length; i += 3) {
      if (recorder.keys[i] >= READY_FRAMES) live.push(i);
    }
    expect(live.length).toBeGreaterThan(2);
    const mid = live[Math.floor(live.length / 2)];
    const tampered = [...recorder.keys.slice(0, mid), ...recorder.keys.slice(mid + 3)];
    const replayed = runReplay({
      rule: RULE, handling: HANDLING, seed: SEED,
      keys: tampered, frames: FRAMES, simRate: 60,
    });
    expect(fingerprint(replayed)).not.toBe(fingerprint(game));
  });

  it("시드가 다르면 같은 입력이어도 결과가 갈린다", () => {
    const { recorder } = playAndRecord();
    const base = runReplay({
      rule: RULE, handling: HANDLING, seed: SEED,
      keys: recorder.keys, frames: FRAMES, simRate: 60,
    });
    const other = runReplay({
      rule: RULE, handling: HANDLING, seed: SEED + 1,
      keys: recorder.keys, frames: FRAMES, simRate: 60,
    });
    expect(fingerprint(other)).not.toBe(fingerprint(base));
  });

  it("simRate가 다르면 재현이 어긋난다 (반드시 기록 당시 값으로 돌려야 한다)", () => {
    const { game, recorder } = playAndRecord();
    const wrongRate = runReplay({
      rule: RULE, handling: HANDLING, seed: SEED,
      keys: recorder.keys, frames: FRAMES, simRate: 120,
    });
    expect(fingerprint(wrongRate)).not.toBe(fingerprint(game));
  });

  it("재현은 몇 번을 돌려도 같은 결과를 낸다", () => {
    const { recorder } = playAndRecord();
    const opts = {
      rule: RULE, handling: HANDLING, seed: SEED,
      keys: recorder.keys, frames: FRAMES, simRate: 60,
    };
    expect(fingerprint(runReplay(opts))).toBe(fingerprint(runReplay(opts)));
  });

  it("지문은 벽시계(startTime)에 흔들리지 않는다", () => {
    // 실제 판은 update(dt, cmd, performance.now())로 돌고 재현은 now=0으로 돈다.
    // 지문이 startTime을 물고 있으면 정상 플레이도 전부 불일치로 잡힌다.
    const live = new Game(RULE, HANDLING, SEED);
    const replayed = new Game(RULE, HANDLING, SEED);
    // startTime은 판이 실제로 열릴 때 찍힌다 — Ready를 넘겨야 대조할 값이 생긴다
    for (let f = 0; f < READY_FRAMES + 120; f++) {
      live.update(1, undefined, 123456.789);
      replayed.update(1, undefined, 0);
      live.events.length = 0;
      replayed.events.length = 0;
    }
    expect(live.stats.startTime).not.toBe(replayed.stats.startTime);
    expect(fingerprint(live)).toBe(fingerprint(replayed));
  });

  it("기록기는 입력을 프레임 경계에 맞춰 쌓는다", () => {
    const rec = new ReplayRecorder();
    rec.push(ReplayAction.MoveLeft, true);
    rec.commitFrame(); // frame 0
    rec.commitFrame(); // frame 1 — 입력 없음
    rec.push(ReplayAction.HardDrop, true);
    rec.commitFrame(); // frame 2

    expect(rec.frame).toBe(3);
    expect(rec.keys).toEqual([
      0, ReplayAction.MoveLeft, 1,
      2, ReplayAction.HardDrop, 1,
    ]);
  });
});
