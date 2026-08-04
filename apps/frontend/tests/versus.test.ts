import { describe, it, expect } from "vitest";
import { VersusMatch } from "../src/app/VersusMatch";
import { createLoopbackPair } from "../src/net/transport";
import { Phase, READY_FRAMES } from "@fetris/engine/game";
import type { InputCommands } from "@fetris/engine/game";
import { Piece, Rot, MAX_PLAN_GHOSTS } from "@fetris/engine/types";
import type { PlanGhost } from "@fetris/engine/types";
import { shapeOf } from "@fetris/engine/pieces";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "@fetris/engine/config";
import { ReplayAction, runReplay, fingerprint } from "@fetris/engine/replay";

const CMD = (over: Partial<InputCommands> = {}): InputCommands => ({
  rotateCW: false,
  rotateCCW: false,
  rotate180: false,
  hardDrop: false,
  hold: false,
  softDropHeld: false,
  ...over,
});

const RULE = { ...STANDARD_RULESET, garbageEnabled: true, garbageMessiness: 0 };

/** 루프백으로 이어진 두 매치. 서로를 유일한 상대로 본다. */
function makePair(seed = 111): [VersusMatch, VersusMatch] {
  const [ta, tb] = createLoopbackPair();
  const a = new VersusMatch({
    rule: { ...RULE }, handling: DEFAULT_HANDLING, seed, myAttackMul: 1,
    transport: ta, opponents: ["B"],
  });
  const b = new VersusMatch({
    rule: { ...RULE }, handling: DEFAULT_HANDLING, seed, myAttackMul: 1,
    transport: tb, opponents: ["A"],
  });
  return [a, b];
}

/** 두 매치를 Ready 카운트다운 너머 Playing까지 함께 진행 */
function bothToPlaying(a: VersusMatch, b: VersusMatch): void {
  for (let i = 0; i < READY_FRAMES + 10 && a.local.cur === Piece.None; i++) {
    a.tick(1, CMD());
    b.tick(1, CMD());
  }
}

/** g.local에 세로 I로 4줄을 채워 즉시 quad가 나도록 보드를 세팅 */
function setupQuad(match: VersusMatch, col = 4): void {
  const g = match.local;
  g.cur = Piece.I;
  g.rot = Rot.Right;
  const shape = shapeOf(Piece.I, Rot.Right);
  const minX = Math.min(shape[0], shape[2], shape[4], shape[6]);
  g.px = col - minX;
  g.py = 0;
  const b = g.board;
  for (let y = b.totalRows - 4; y < b.totalRows; y++) {
    for (let x = 0; x < b.cols; x++) {
      if (x !== col) b.grid[y * b.cols + x] = Piece.Garbage;
    }
  }
}

describe("VersusMatch 공격 라우팅", () => {
  it("내가 quad를 비우면 상대 가비지 큐에 공격이 쌓인다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    expect(a.local.cur).not.toBe(Piece.None);
    expect(b.local.pendingGarbage).toBe(0);

    setupQuad(a, 4);
    a.tick(1, CMD({ hardDrop: true }));

    expect(b.local.pendingGarbage).toBeGreaterThanOrEqual(4);
  });

  it("공격 배수가 보낸 공격에 적용된다", () => {
    const [ta, tb] = createLoopbackPair();
    const a = new VersusMatch({
      rule: { ...RULE }, handling: DEFAULT_HANDLING, seed: 222, myAttackMul: 0.5,
      transport: ta, opponents: ["B"],
    });
    const b = new VersusMatch({
      rule: { ...RULE }, handling: DEFAULT_HANDLING, seed: 222, myAttackMul: 1,
      transport: tb, opponents: ["A"],
    });
    bothToPlaying(a, b);

    setupQuad(a, 4);
    // 퍼펙트 클리어(보너스) 방지를 위해 지워지지 않을 블록을 위쪽에 하나 둠 → 순수 quad
    const bd = a.local.board;
    bd.grid[(bd.totalRows - 6) * bd.cols + 0] = Piece.Garbage;
    a.tick(1, CMD({ hardDrop: true }));

    expect(b.local.pendingGarbage).toBeGreaterThan(0);
    expect(b.local.pendingGarbage).toBeLessThan(5);
  });

  it("garbage speed 윈도우 안에서 들어온 가비지를 클리어로 상쇄한다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    b.local.receiveGarbage({ holes: [0, 0] });
    expect(b.local.pendingGarbage).toBe(2);
    b.tick(1, CMD());
    setupQuad(b, 4);
    b.tick(1, CMD({ hardDrop: true }));
    expect(b.local.pendingGarbage).toBe(0);
    void a;
  });

});

// ============================================================================
// 입력 릴레이 — 보드가 아니라 누른 키를 흘려보내고, 받는 쪽이 다시 돌린다.
//
// 이게 성립하려면 미러가 원본과 **완전히 같은 판**이어야 한다. 한 프레임이라도
// 어긋나면 그 뒤로 계속 벌어지므로, 지문까지 맞는지 본다.
// ============================================================================

describe("입력 릴레이", () => {
  it("흘려보낸 입력만으로 상대 미러가 같은 판을 따라 돈다", () => {
    const [a, b] = makePair(4242);
    // 스트림 주기(4프레임)의 배수만큼 돌려야 마지막 조각까지 흘러나간다
    const TICKS = READY_FRAMES + 240;
    for (let i = 0; i < TICKS; i++) {
      const drop = i > 70 && i % 17 === 0;
      if (drop) a.recorder.push(ReplayAction.HardDrop, true);
      if (i > 70 && i % 23 === 5) {
        a.recorder.push(ReplayAction.MoveLeft, true);
        a.local.pressDir(-1);
      }
      if (i > 70 && i % 23 === 11) {
        a.recorder.push(ReplayAction.MoveLeft, false);
        a.local.releaseDir(-1);
      }
      a.tick(1, CMD({ hardDrop: drop }));
      b.tick(1, CMD());
    }
    // 미러는 스트림이 도착하는 만큼 뒤에서 따라온다 — 마저 돌려 따라잡힌다
    for (let i = 0; i < 20; i++) b.tick(1, CMD());

    const mirror = b.remotes.get("A");
    expect(mirror).toBeDefined();
    expect(a.local.stats.piecesPlaced).toBeGreaterThan(0);
    expect(mirror!.frame).toBe(a.recorder.frame);
    expect(fingerprint(mirror!.game)).toBe(fingerprint(a.local));
  });

  it("받은 것보다 앞서 돌지 않는다", () => {
    // upto를 넘어서 돌면 아직 오지 않은 입력을 없는 셈 치고 돌게 되어 어긋난다.
    const [a, b] = makePair(77);
    for (let i = 0; i < 40; i++) {
      a.tick(1, CMD());
      b.tick(1, CMD());
    }
    const mirror = b.remotes.get("A")!;
    expect(mirror.frame).toBeLessThanOrEqual(a.recorder.frame);
    // a를 멈춰 두고 b만 돌려도 마지막으로 받은 지점을 넘지 않는다
    const stuck = mirror.frame;
    for (let i = 0; i < 30; i++) b.tick(1, CMD());
    expect(mirror.frame).toBeLessThanOrEqual(Math.max(stuck, a.recorder.frame));
    expect(mirror.frame).toBe(a.recorder.frame);
  });

  it("스트림은 방 전체로 나간다 — 누구에게만 따로 보내지 않는다", () => {
    // 예전에는 "나를 크게 보는 사람"에게만 스냅샷을 자주 보내는 장치가 있었다.
    // 입력은 통째로 보내도 스냅샷 한 장보다 작아서 그 장치가 필요 없다.
    const sent: string[] = [];
    const targeted: string[] = [];
    const transport = {
      myId: "A",
      send: (msg: { t: string }) => sent.push(msg.t),
      sendTo: (_targetId: string, msg: { t: string }) => targeted.push(msg.t),
      onMessage: () => {},
      onClose: () => {},
      onPlayerLeft: () => {},
      onPlayerJoined: () => {},
      close: () => {},
    };
    const m = new VersusMatch({
      rule: { ...RULE }, handling: DEFAULT_HANDLING, seed: 9, myAttackMul: 1,
      transport, opponents: ["X", "Y", "Z"],
    });

    for (let i = 0; i < 12; i++) m.tick(1, CMD());
    expect(sent.filter((t) => t === "sync").length).toBe(3);
    expect(targeted).toEqual([]);
  });

  it("낮은 빈도로 상태 키프레임을 함께 보낸다", () => {
    // 순단으로 입력이 통째로 빈 구간이 생기면 미러가 그 자리에 멈춘다.
    // 이걸 받아야 다시 이어 붙는다.
    const sent: string[] = [];
    const transport = {
      myId: "A",
      send: (msg: { t: string }) => sent.push(msg.t),
      sendTo: () => {},
      onMessage: () => {},
      onClose: () => {},
      onPlayerLeft: () => {},
      onPlayerJoined: () => {},
      close: () => {},
    };
    const m = new VersusMatch({
      rule: { ...RULE }, handling: DEFAULT_HANDLING, seed: 3, myAttackMul: 1,
      transport, opponents: ["X"],
    });

    for (let i = 0; i < 119; i++) m.tick(1, CMD());
    expect(sent.filter((t) => t === "full")).toHaveLength(0);
    m.tick(1, CMD());
    expect(sent.filter((t) => t === "full")).toHaveLength(1);
    // 스트림이 먼저 나가야 한다 — 순서가 뒤집히면 미러가 지나간 입력을 다시 먹는다
    expect(sent.lastIndexOf("sync")).toBeLessThan(sent.lastIndexOf("full"));
  });

  it("스냅샷만 보내는 상대(옛 봇)는 받은 그대로 얹는다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    setupQuad(a, 4);
    // 입력 스트림 대신 보드를 통째로 보내는 옛 방식
    (b as unknown as { onMessage: (m: unknown, from: string) => void }).onMessage(
      { t: "board", snap: a.local.serialize() },
      "A",
    );

    const mirror = b.remotes.get("A")!;
    expect(mirror.snapshotOnly).toBe(true);
    let filled = 0;
    const grid = mirror.game.board.grid;
    for (let i = 0; i < grid.length; i++) if (grid[i] !== 0) filled++;
    expect(filled).toBeGreaterThan(0);
  });
});

describe("VersusMatch 탈락", () => {
  it("내가 톱아웃하면 onSelfKO가 한 번 불리고 시뮬이 멈춘다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    let koCount = 0;
    a.onSelfKO = () => koCount++;

    a.local.phase = Phase.GameOver;
    a.tick(1, CMD());
    expect(koCount).toBe(1);
    expect(a.alive).toBe(false);

    // 죽은 뒤에는 더 이상 진행되지 않는다
    a.tick(1, CMD());
    expect(koCount).toBe(1);
  });

  it("서버가 알린 탈락은 생존자 목록에서 빠진다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    expect(a.aliveOpponents).toContain("B");
    a.applyKO("B");
    expect(a.aliveOpponents).not.toContain("B");
    void b;
  });

  it("상대가 이탈하면 미러까지 정리된다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    b.dispose();
    expect(a.aliveOpponents).not.toContain("B");
  });
});

describe("타깃 전략", () => {
  /** 상대 셋을 둔 매치 하나 — 전송된 타깃만 관찰한다 */
  function soloWithThree() {
    const sent: { target: string; holes: number[] }[] = [];
    const transport = {
      myId: "ME",
      send: () => {},
      sendTo: (targetId: string, msg: { t: string; holes?: number[] }) => {
        if (msg.t === "attack") sent.push({ target: targetId, holes: msg.holes ?? [] });
      },
      onMessage: () => {},
      onClose: () => {},
      onPlayerLeft: () => {},
      onPlayerJoined: () => {},
      close: () => {},
    };
    const m = new VersusMatch({
      rule: { ...RULE }, handling: DEFAULT_HANDLING, seed: 5, myAttackMul: 1,
      transport, opponents: ["X", "Y", "Z"],
    });
    return { m, sent };
  }

  it("even은 가장 적게 때린 상대를 고른다", () => {
    const { m, sent } = soloWithThree();
    m.strategy = "even";
    for (let i = 0; i < READY_FRAMES + 10 && m.local.cur === Piece.None; i++) m.tick(1, CMD());

    // 여러 번 공격하면 세 상대에게 돌아가며 분배된다
    // (보드 상태에 따라 공격이 안 나가는 턴도 있어 넉넉히 시도한다)
    for (let n = 0; n < 6; n++) {
      setupQuad(m, 4);
      m.tick(1, CMD({ hardDrop: true }));
      m.tick(1, CMD());
    }
    const targets = new Set(sent.map((s) => s.target));
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(targets.size).toBe(3);
  });

  it("elims는 가장 높이 쌓인 상대를 고른다", () => {
    const { m, sent } = soloWithThree();
    m.strategy = "elims";
    for (let i = 0; i < READY_FRAMES + 10 && m.local.cur === Piece.None; i++) m.tick(1, CMD());

    // Y의 미러 보드만 위험하게 채운다
    const y = m.remotes.get("Y")!;
    const yb = y.game.board;
    for (let row = yb.bufferRows; row < yb.totalRows; row++) {
      yb.grid[row * yb.cols] = Piece.Garbage;
    }

    setupQuad(m, 4);
    m.tick(1, CMD({ hardDrop: true }));
    expect(sent.at(-1)?.target).toBe("Y");
  });

  it("payback은 나를 때린 상대에게 되갚는다", () => {
    const { m, sent } = soloWithThree();
    m.strategy = "payback";
    for (let i = 0; i < READY_FRAMES + 10 && m.local.cur === Piece.None; i++) m.tick(1, CMD());

    // Z가 나를 때렸다고 알린다(수신 경로를 직접 흉내)
    (m as unknown as { onMessage: (msg: unknown, from: string) => void }).onMessage(
      { t: "attack", holes: [3] },
      "Z",
    );

    setupQuad(m, 4);
    m.tick(1, CMD({ hardDrop: true }));
    expect(sent.at(-1)?.target).toBe("Z");
  });
});

// ============================================================================
// 대전 리플레이 — 세션이 기록한 로그로 판을 그대로 되살릴 수 있어야 한다.
//
// 서버 검증이 여기에 걸려 있다. 키만 남기고 받은 가비지를 빠뜨리면 정상 플레이가
// 전부 replay-mismatch로 잡히므로, 수신 시점이 프레임 경계와 맞는지까지 본다.
// ============================================================================

describe("대전 리플레이 기록", () => {
  /** VersusSession이 하는 것과 같은 배선으로 한 판을 돌린다 */
  function playRecorded(seed = 909) {
    const [a, b] = makePair(seed);
    // 기록기는 매치가 들고 있다 — 검증에 낼 로그와 지금 상대에게 흘려보내는
    // 스트림이 같은 자료여야 둘이 어긋날 수 없다
    const rec = a.recorder;

    const step = (cmd: InputCommands) => {
      a.tick(1, cmd);
      b.tick(1, CMD());
    };

    for (let i = 0; i < READY_FRAMES + 10 && a.local.cur === Piece.None; i++) step(CMD());

    // b가 quad를 세 번 비워 a에게 가비지를 보낸다. 그 사이 a도 조각을 놓는다.
    for (let round = 0; round < 3; round++) {
      setupQuad(b, 4);
      b.tick(1, CMD({ hardDrop: true }));
      for (let i = 0; i < 40; i++) {
        if (i % 13 === 0) {
          rec.push(ReplayAction.HardDrop, true);
          step(CMD({ hardDrop: true }));
        } else if (i % 7 === 2) {
          rec.push(ReplayAction.MoveLeft, true);
          a.local.pressDir(-1);
          step(CMD());
        } else if (i % 7 === 5) {
          rec.push(ReplayAction.MoveLeft, false);
          a.local.releaseDir(-1);
          step(CMD());
        } else {
          step(CMD());
        }
      }
    }
    return { a, rec };
  }

  it("받은 가비지까지 기록해 판을 그대로 재현한다", () => {
    const { a, rec } = playRecorded();
    expect(rec.garbage.length).toBeGreaterThan(0);
    expect(a.local.stats.piecesPlaced).toBeGreaterThan(0);

    const replayed = runReplay({
      rule: a.local.rule,
      handling: a.local.handling.h,
      seed: a.local.seed,
      keys: rec.keys,
      garbage: rec.garbage,
      frames: rec.frame,
      simRate: 60,
    });
    expect(fingerprint(replayed)).toBe(fingerprint(a.local));
  });

  it("가비지를 빼고 재현하면 어긋난다(기록이 실제로 쓰이고 있다)", () => {
    const { a, rec } = playRecorded();
    const replayed = runReplay({
      rule: a.local.rule,
      handling: a.local.handling.h,
      seed: a.local.seed,
      keys: rec.keys,
      frames: rec.frame,
      simRate: 60,
    });
    expect(fingerprint(replayed)).not.toBe(fingerprint(a.local));
  });
});

// ============================================================================
// 계획 고스트 — 봇이 "이렇게 놓을 생각"을 보여주는 표시 전용 오버레이.
// 게임 상태가 아니므로 시뮬레이션·검증 어디에도 끼면 안 된다.
// ============================================================================

describe("계획 고스트", () => {
  const ghost = (x: number, id?: string): PlanGhost => ({ id, piece: Piece.T, rot: Rot.Spawn, x, y: 20 });

  it("서버가 알려준 계획을 그 사람 몫으로 보관한다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    b.setPlan("A", [ghost(2), ghost(5)]);
    expect(b.plans.get("A")).toHaveLength(2);
    expect(b.plans.get("A")?.[0].x).toBe(2);
    void a;
  });

  it("빈 목록을 받으면 지운다", () => {
    const [, b] = makePair();
    b.setPlan("A", [ghost(1)]);
    expect(b.plans.has("A")).toBe(true);
    b.setPlan("A", []);
    expect(b.plans.has("A")).toBe(false);
  });

  it("보드를 통째로 덧칠하지 못하도록 개수를 자른다", () => {
    const [, b] = makePair();
    const many = Array.from({ length: MAX_PLAN_GHOSTS + 20 }, (_, i) => ghost(i % 10));
    b.setPlan("A", many);
    expect(b.plans.get("A")).toHaveLength(MAX_PLAN_GHOSTS);
  });

  it("계획이 떠 있어도 판의 전개와 지문은 그대로다", () => {
    // 표시 전용이라는 게 이 테스트의 요지 — 같은 입력이면 계획이 있든 없든 같은 판이다.
    const play = (withPlan: boolean) => {
      const [a, b] = makePair(4242);
      bothToPlaying(a, b);
      for (let f = 0; f < 120; f++) {
        if (withPlan && f % 10 === 0) b.setPlan("A", [ghost(f % 8)]);
        a.tick(1, CMD({ hardDrop: f % 13 === 0 }));
        b.tick(1, CMD({ hardDrop: f % 13 === 0 }));
      }
      return fingerprint(b.local);
    };
    expect(play(true)).toBe(play(false));
  });

  it("상대가 나가면 그 사람 계획도 함께 사라진다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    b.setPlan("A", [ghost(3)]);
    expect(b.plans.has("A")).toBe(true);
    a.dispose();
    expect(b.plans.has("A")).toBe(false);
  });
});
