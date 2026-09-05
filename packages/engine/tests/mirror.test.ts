import { describe, it, expect } from "vitest";
import { Game } from "../src/game.js";
import { BoardMirror } from "../src/mirror.js";
import { ReplayAction, ReplayRecorder, fingerprint, snapshotFingerprint } from "../src/replay.js";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "../src/config.js";

// ============================================================================
// BoardMirror — 남의 입력을 받아 그 사람 판을 내 쪽에서 다시 돌린다.
//
// 대전 화면이 통째로 여기 걸려 있다. 한 프레임이라도 어긋나면 그 뒤로 계속
// 벌어지므로, "비슷하다"가 아니라 지문이 같은지를 본다.
// ============================================================================

const RULE = { ...STANDARD_RULESET, garbageEnabled: true, garbageMessiness: 0 };
const SEED = 31337;

const EMPTY = {
  rotateCW: false,
  rotateCCW: false,
  rotate180: false,
  hardDrop: false,
  hold: false,
  softDropHeld: false,
};

/**
 * 한 판을 돌리면서 세션과 똑같이 입력을 기록한다.
 * 돌아오는 recorder가 그대로 네트워크로 흘려보낼 스트림이다.
 */
function playSource(frames: number): { game: Game; rec: ReplayRecorder } {
  const game = new Game(RULE, DEFAULT_HANDLING, SEED);
  const rec = new ReplayRecorder();
  for (let i = 0; i < frames; i++) {
    const drop = i > 60 && i % 19 === 0;
    if (drop) rec.push(ReplayAction.HardDrop, true);
    if (i > 60 && i % 27 === 4) {
      rec.push(ReplayAction.MoveRight, true);
      game.pressDir(1);
    }
    if (i > 60 && i % 27 === 9) {
      rec.push(ReplayAction.MoveRight, false);
      game.releaseDir(1);
    }
    // 중간에 가비지도 한 번 맞는다 — 키만으로는 판이 결정되지 않는다
    if (i === 100) {
      game.receiveGarbage({ holes: [3, 3] });
      rec.pushGarbage([3, 3]);
    }
    rec.commitFrame();
    game.update(1, drop ? { ...EMPTY, hardDrop: true } : EMPTY, 0);
    game.events.length = 0;
  }
  return { game, rec };
}

function newMirror(): BoardMirror {
  return new BoardMirror({ rule: RULE, handling: DEFAULT_HANDLING, seed: SEED, simRate: 60 });
}

/** 미러를 더 진행할 수 없을 때까지 돌린다 */
function drain(mirror: BoardMirror, maxTicks = 5000): void {
  for (let i = 0; i < maxTicks && mirror.advance() > 0; i++) {
    mirror.game.events.length = 0;
  }
}

describe("BoardMirror", () => {
  it("조각조각 받은 입력으로 원본과 같은 판을 만든다", () => {
    const { game, rec } = playSource(300);
    const mirror = newMirror();

    // 실제 전송처럼 4프레임마다 새로 쌓인 만큼만 흘려보낸다
    let sentKeys = 0;
    let sentIge = 0;
    for (let upto = 4; upto <= rec.frame; upto += 4) {
      const keys = rec.keys.slice(sentKeys);
      const ige = rec.garbage.slice(sentIge);
      // 다음 묶음에는 이 프레임까지의 입력만 실려야 하는데, 기록이 이미 끝까지
      // 차 있으므로 여기서는 프레임 경계로 잘라 보낸다
      const cutK = keys.findIndex((_, i) => i % 3 === 0 && keys[i] >= upto);
      const cutG = igeCut(ige, upto);
      const chunkK = cutK < 0 ? keys : keys.slice(0, cutK);
      const chunkG = ige.slice(0, cutG);
      sentKeys += chunkK.length;
      sentIge += chunkG.length;
      mirror.feed(upto, chunkK, chunkG);
      drain(mirror);
    }
    mirror.feed(rec.frame, rec.keys.slice(sentKeys), rec.garbage.slice(sentIge));
    drain(mirror);

    expect(mirror.frame).toBe(rec.frame);
    expect(game.stats.piecesPlaced).toBeGreaterThan(0);
    expect(fingerprint(mirror.game)).toBe(fingerprint(game));
  });

  it("받은 데까지만 돌고 그 앞은 기다린다", () => {
    const { rec } = playSource(200);
    const mirror = newMirror();
    mirror.feed(50, rec.keys, rec.garbage);
    drain(mirror);
    expect(mirror.frame).toBe(50);
    expect(mirror.behind).toBe(0);

    // 입력은 이미 다 갖고 있어도 경계를 올려주기 전에는 더 가지 않는다
    drain(mirror);
    expect(mirror.frame).toBe(50);

    mirror.feed(120);
    drain(mirror);
    expect(mirror.frame).toBe(120);
  });

  it("입력이 통째로 빈 구간은 키프레임으로 이어 붙는다", () => {
    const { game, rec } = playSource(300);
    const mirror = newMirror();

    // 순단으로 중간이 통째로 빠졌다 — 앞부분만 받았다
    const cut = firstFrameIndex(rec.keys, 120);
    mirror.feed(120, rec.keys.slice(0, cut), []);
    drain(mirror);
    expect(mirror.frame).toBe(120);

    // 상태 키프레임을 받으면 건너뛴 구간을 그대로 넘어간다
    mirror.keyframe(300, game.serialize());
    expect(mirror.frame).toBe(300);
    expect(fingerprint(mirror.game)).toBe(fingerprint(game));
  });

  it("판이 어긋나면 키프레임으로 되돌린다", () => {
    /*
      상대가 나와 다른 조건으로 돌고 있으면(엔진 버전이 달라 룰 하나를 무시하는
      봇 같은 경우) 프레임은 맞는데 판이 갈린다. 그대로 두면 미러가 제 갈 길로
      흘러가 그럴듯한 가짜 판을 그린다 — 어긋난 줄도 모르고 보게 된다.
    */
    const { rec } = playSource(300);
    const mirror = newMirror();
    mirror.feed(200, rec.keys, rec.garbage);
    drain(mirror);

    // 실제 상대는 훨씬 많이 놓은 상태였다
    const truth = playSource(300).game;
    expect(truth.stats.piecesPlaced).toBeGreaterThan(mirror.game.stats.piecesPlaced + 2);

    mirror.keyframe(mirror.frame, truth.serialize());
    expect(mirror.game.stats.piecesPlaced).toBe(truth.stats.piecesPlaced);
  });

  it("조각 수가 같아도 판이 다르면 되돌린다", () => {
    /*
      가장 놓치기 쉬운 어긋남이다. 상대와 미러가 같은 박자로 두고 있으면 조각
      수는 늘 맞아떨어져서, 개수만 견주던 때는 이 경우를 통째로 흘려보냈다 —
      미러는 라인 하나 못 지운 채 쌓여 올라간 가짜 판을 계속 그렸다.
    */
    const { rec } = playSource(300);
    const mirror = newMirror();
    mirror.feed(200, rec.keys, rec.garbage);
    drain(mirror);

    // 조각 수·프레임은 그대로 두고 판만 다른 상태를 만든다
    const truth = mirror.game.serialize();
    truth.grid = truth.grid.slice();
    const row = truth.grid.length - RULE.cols;
    for (let x = 0; x < RULE.cols; x++) truth.grid[row + x] = ((x % 6) + 1) as number;
    expect(truth.stats.piecesPlaced).toBe(mirror.game.stats.piecesPlaced);

    mirror.keyframe(mirror.frame, truth);
    expect(fingerprint(mirror.game)).toBe(snapshotFingerprint(truth));
  });

  it("몇 프레임 앞선 키프레임은 그 자리에 닿았을 때 대조한다", () => {
    /*
      미러는 늘 스트림보다 몇 프레임 뒤에 있다. 받은 그 순간에는 견줄 자리가
      없으므로 들고 있다가, 그 프레임까지 굴러왔을 때 판단한다.
    */
    const { rec } = playSource(300);
    const mirror = newMirror();
    mirror.feed(200, rec.keys, rec.garbage);
    drain(mirror);
    expect(mirror.frame).toBe(200);

    // 아직 닿지 않은 프레임의 어긋난 키프레임 — 받은 자리에서는 건드리지 않는다
    const truth = mirror.game.serialize();
    truth.grid = truth.grid.slice();
    const row = truth.grid.length - RULE.cols;
    for (let x = 0; x < RULE.cols; x++) truth.grid[row + x] = ((x % 6) + 1) as number;
    mirror.keyframe(206, truth);
    expect(mirror.frame).toBe(200);
    const before = fingerprint(mirror.game);

    // 그 자리까지 굴러가면 그제야 어긋남을 잡아낸다
    mirror.feed(206);
    drain(mirror);
    expect(fingerprint(mirror.game)).not.toBe(before);
    expect(fingerprint(mirror.game)).toBe(snapshotFingerprint(truth));
    expect(mirror.frame).toBe(206);
  });

  it("지연으로 설명되는 차이는 그냥 둔다", () => {
    /*
      미러는 스트림이 도착하는 만큼 늘 몇 프레임 뒤에 있어서, 그 사이에 놓인
      조각만큼 상대가 앞선다. 그때마다 상태를 갈아끼우면 화면이 튄다.
      되돌렸는지는 frame이 넘어갔는지로 본다(syncTo가 frame을 옮긴다).
    */
    const { rec } = playSource(300);
    const mirror = newMirror();
    mirror.feed(300, rec.keys, rec.garbage);
    drain(mirror);
    const at = mirror.frame;

    const lagging = mirror.game.serialize();
    lagging.stats = { ...lagging.stats, piecesPlaced: lagging.stats.piecesPlaced + 1 };
    mirror.keyframe(at + 3, lagging);
    expect(mirror.frame).toBe(at);
  });

  it("몇 프레임 뒤처진 정도로는 키프레임을 쓰지 않는다", () => {
    // 내용이 같은데 프레임만 조금 앞선 키프레임은 무시한다.
    const { rec } = playSource(200);
    const mirror = newMirror();
    mirror.feed(100, rec.keys, rec.garbage);
    drain(mirror);
    expect(mirror.frame).toBe(100);

    mirror.keyframe(105, mirror.game.serialize());
    expect(mirror.frame).toBe(100);
  });

  it("스냅샷만 오는 상대는 시뮬을 돌리지 않는다", () => {
    const { game } = playSource(200);
    const mirror = newMirror();
    mirror.snapshot(game.serialize());
    expect(mirror.snapshotOnly).toBe(true);
    expect(mirror.advance()).toBe(0);

    // 뒤늦게 입력이 와도 갈아타지 않는다 — 지금 상태가 몇 프레임인지 모른다
    mirror.feed(50, [0, ReplayAction.HardDrop, 1]);
    expect(mirror.advance()).toBe(0);
    expect(mirror.game.stats.piecesPlaced).toBe(game.stats.piecesPlaced);
  });
});

/** keys에서 frame 이상이 처음 나오는 위치(3개 단위) */
function firstFrameIndex(keys: number[], frame: number): number {
  for (let i = 0; i < keys.length; i += 3) {
    if (keys[i] >= frame) return i;
  }
  return keys.length;
}

/** garbage 로그에서 frame 미만까지의 길이 */
function igeCut(ige: number[], frame: number): number {
  let i = 0;
  while (i + 1 < ige.length && ige[i] < frame) {
    const n = ige[i + 1];
    if (!Number.isInteger(n) || n <= 0 || i + 2 + n > ige.length) break;
    i += 2 + n;
  }
  return i;
}
