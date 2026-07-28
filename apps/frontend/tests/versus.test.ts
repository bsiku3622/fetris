import { describe, it, expect } from "vitest";
import { VersusMatch } from "../src/app/VersusMatch";
import { createLoopbackPair } from "../src/net/transport";
import { Phase } from "@fetris/engine/game";
import type { InputCommands } from "@fetris/engine/game";
import { Piece, Rot } from "@fetris/engine/types";
import { shapeOf } from "@fetris/engine/pieces";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "@fetris/engine/config";

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
  for (let i = 0; i < 70 && a.local.cur === Piece.None; i++) {
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

  it("상대 보드 스냅샷이 미러에 반영된다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    setupQuad(a, 4);
    // ambient 스냅샷 주기(12프레임)를 넘겨야 브로드캐스트가 나간다
    for (let i = 0; i < 13; i++) a.tick(1, CMD());

    const remote = b.remotes.get("A");
    expect(remote).toBeDefined();
    let filled = 0;
    const grid = remote!.board.grid;
    for (let i = 0; i < grid.length; i++) if (grid[i] !== 0) filled++;
    expect(filled).toBeGreaterThan(0);
  });

  it("포커스를 걸면 상대가 나를 watcher로 등록해 고빈도로 보낸다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    // b가 a를 크게 보기 시작 → a는 b에게만 자주 보낸다
    b.setFocus("A");
    expect(b.focus).toBe("A");

    setupQuad(a, 4);
    // focus 주기(3프레임)만 지나도 스냅샷이 도착해야 한다
    for (let i = 0; i < 4; i++) a.tick(1, CMD());

    const remote = b.remotes.get("A");
    let filled = 0;
    const grid = remote!.board.grid;
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
    for (let i = 0; i < 70 && m.local.cur === Piece.None; i++) m.tick(1, CMD());

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
    for (let i = 0; i < 70 && m.local.cur === Piece.None; i++) m.tick(1, CMD());

    // Y의 미러 보드만 위험하게 채운다
    const y = m.remotes.get("Y")!;
    const yb = y.board;
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
    for (let i = 0; i < 70 && m.local.cur === Piece.None; i++) m.tick(1, CMD());

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
