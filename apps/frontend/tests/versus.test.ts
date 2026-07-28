import { describe, it, expect } from "vitest";
import { VersusMatch } from "../src/app/VersusMatch";
import { createLoopbackPair } from "../src/net/transport";
import { Side } from "../src/net/protocol";
import { Phase } from "../src/engine/game";
import type { InputCommands } from "../src/engine/game";
import { Piece, Rot } from "../src/engine/types";
import { shapeOf } from "../src/engine/pieces";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "../src/engine/config";

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

function makePair(seed = 111): [VersusMatch, VersusMatch] {
  const [ta, tb] = createLoopbackPair();
  const a = new VersusMatch({ rule: { ...RULE }, handling: DEFAULT_HANDLING, seed, myAttackMul: 1, side: Side.P1, transport: ta });
  const b = new VersusMatch({ rule: { ...RULE }, handling: DEFAULT_HANDLING, seed, myAttackMul: 1, side: Side.P2, transport: tb });
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
    a.tick(1, CMD({ hardDrop: true })); // quad → Attack 송신 → b.local.receiveGarbage

    expect(b.local.pendingGarbage).toBeGreaterThanOrEqual(4);
  });

  it("공격 배수가 보낸 공격에 적용된다", () => {
    const [ta, tb] = createLoopbackPair();
    const a = new VersusMatch({ rule: { ...RULE }, handling: DEFAULT_HANDLING, seed: 222, myAttackMul: 0.5, side: Side.P1, transport: ta });
    const b = new VersusMatch({ rule: { ...RULE }, handling: DEFAULT_HANDLING, seed: 222, myAttackMul: 1, side: Side.P2, transport: tb });
    bothToPlaying(a, b);

    setupQuad(a, 4);
    // 퍼펙트 클리어(보너스) 방지를 위해 지워지지 않을 블록을 위쪽에 하나 둠 → 순수 quad
    const bd = a.local.board;
    bd.grid[(bd.totalRows - 6) * bd.cols + 0] = Piece.Garbage;
    a.tick(1, CMD({ hardDrop: true }));

    // 순수 quad 공격(5) × 0.5 = floor(2.5) = 2 → 풀배수(5)보다 작아야 한다
    expect(b.local.pendingGarbage).toBeGreaterThan(0);
    expect(b.local.pendingGarbage).toBeLessThan(5);
  });

  it("garbage speed 윈도우 안에서 들어온 가비지를 클리어로 상쇄한다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    // b에게 2줄 가비지 적재 — garbage speed 동안 대기(아직 투하 안 됨)
    b.local.receiveGarbage({ holes: [0, 0] });
    expect(b.local.pendingGarbage).toBe(2);
    b.tick(1, CMD()); // delay 진행(여전히 윈도우 안)
    // b가 quad(공격 ≥4)로 클리어 → 2줄 완전 상쇄
    setupQuad(b, 4);
    b.tick(1, CMD({ hardDrop: true }));
    expect(b.local.pendingGarbage).toBe(0); // 상쇄되어 투하될 가비지가 없음
    void a;
  });

  it("상대 보드 스냅샷이 미러에 반영된다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    // a가 보드에 블록을 두고 스냅샷이 b.primaryRemote로 전달되도록 여러 틱 진행
    setupQuad(a, 4);
    // quad 직전 상태(채워진 보드)를 스냅샷으로 보내기 위해 클리어 없이 스냅샷 주기만큼 진행
    for (let i = 0; i < 4; i++) a.tick(1, CMD());
    // b.primaryRemote 보드에 가비지가 보여야 함
    const remote = b.primaryRemote;
    expect(remote).not.toBeNull();
    let filled = 0;
    const grid = remote!.board.grid;
    for (let i = 0; i < grid.length; i++) if (grid[i] !== 0) filled++;
    expect(filled).toBeGreaterThan(0);
  });
});

describe("VersusMatch 승패", () => {
  it("내 게임오버는 상대 승리로 전달된다", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    a.local.phase = Phase.GameOver;
    a.tick(1, CMD()); // dead 송신

    expect(a.result).toBe("lose");
    expect(b.result).toBe("win");
  });

  it("상대 연결이 끊기면 부전승", () => {
    const [a, b] = makePair();
    bothToPlaying(a, b);
    b.dispose(); // b 이탈 → a에게 close 통지
    expect(a.result).toBe("win");
  });
});
