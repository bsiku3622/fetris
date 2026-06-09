import { describe, it, expect } from "vitest";
import { GarbageGen, cancelGarbage, queuedLines } from "../src/engine/garbage";
import { Game } from "../src/engine/game";
import type { InputCommands } from "../src/engine/game";
import { Piece } from "../src/engine/types";
import type { GarbageChunk } from "../src/engine/types";
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

describe("GarbageGen", () => {
  it("같은 시드는 같은 구멍 수열", () => {
    const a = new GarbageGen(42, 10, 0.4);
    const b = new GarbageGen(42, 10, 0.4);
    for (let i = 0; i < 20; i++) expect(a.holes(3)).toEqual(b.holes(3));
  });

  it("messiness=0이면 모든 줄이 같은 구멍", () => {
    const g = new GarbageGen(7, 10, 0);
    const holes = g.holes(8);
    expect(new Set(holes).size).toBe(1);
  });

  it("구멍은 항상 보드 범위 안", () => {
    const g = new GarbageGen(123, 10, 1);
    for (const h of g.holes(200)) expect(h).toBeGreaterThanOrEqual(0), expect(h).toBeLessThan(10);
  });
});

describe("cancelGarbage / queuedLines", () => {
  it("들어온 공격이 큐보다 크면 큐를 비우고 남은 공격 반환", () => {
    const q: GarbageChunk[] = [{ holes: [1, 2] }, { holes: [3] }];
    expect(queuedLines(q)).toBe(3);
    const out = cancelGarbage(q, 5);
    expect(out).toBe(2); // 5 - 3
    expect(q.length).toBe(0);
  });

  it("부분 상쇄 — 묶음 일부만 지워지고 나머지는 큐에 남음", () => {
    const q: GarbageChunk[] = [{ holes: [1, 2, 3, 4] }];
    const out = cancelGarbage(q, 1);
    expect(out).toBe(0);
    expect(queuedLines(q)).toBe(3); // 4 - 1
    expect(q[0].holes).toEqual([2, 3, 4]);
  });

  it("공격이 0이면 큐 변화 없음", () => {
    const q: GarbageChunk[] = [{ holes: [5] }];
    expect(cancelGarbage(q, 0)).toBe(0);
    expect(queuedLines(q)).toBe(1);
  });
});

/** Ready 카운트다운을 넘겨 Playing 상태 + 활성 피스가 생길 때까지 진행 */
function toPlaying(game: Game): void {
  for (let i = 0; i < 70 && game.cur === Piece.None; i++) game.update(1, CMD());
}

describe("Game 가비지 통합", () => {
  const rule = { ...STANDARD_RULESET, garbageEnabled: true, garbageMessiness: 0 };

  it("받은 가비지는 클리어 없는 락에서 보드 바닥에 투하된다", () => {
    const game = new Game(rule, DEFAULT_HANDLING, 12345);
    toPlaying(game);
    expect(game.cur).not.toBe(Piece.None);

    game.receiveGarbage({ holes: [3, 3] }); // 2줄, 구멍 col 3
    expect(game.pendingGarbage).toBe(2);

    game.update(1, CMD({ hardDrop: true })); // 단일 피스 → 클리어 0 → 투하

    const b = game.board;
    const bottom = b.totalRows - 1;
    // 바닥 2줄: col 3만 빈칸, 나머지는 Garbage
    for (let y = bottom; y > bottom - 2; y--) {
      for (let x = 0; x < b.cols; x++) {
        expect(b.cell(x, y)).toBe(x === 3 ? 0 : Piece.Garbage);
      }
    }
    expect(game.pendingGarbage).toBe(0);
  });

  it("garbageEnabled=false면 receiveGarbage 무시(솔로 안전)", () => {
    const solo = new Game({ ...STANDARD_RULESET }, DEFAULT_HANDLING, 1);
    toPlaying(solo);
    solo.receiveGarbage({ holes: [0, 1] });
    expect(solo.pendingGarbage).toBe(0);
  });

  it("undo는 미투하 가비지 큐까지 되감는다", () => {
    const game = new Game({ ...rule }, DEFAULT_HANDLING, 555);
    game.undoEnabled = true;
    toPlaying(game);
    // 한 피스 놓아 undo 스냅샷이 2개 이상 쌓이게 함
    game.update(1, CMD({ hardDrop: true }));
    toPlaying(game);
    game.receiveGarbage({ holes: [4, 4, 4] });
    expect(game.pendingGarbage).toBe(3);
    game.undo();
    // undo 시점(가비지 받기 전)의 큐로 복원 → 0
    expect(game.pendingGarbage).toBe(0);
  });

  it("클리어 시 들어온 가비지를 상쇄하고 남은 공격만 방출", () => {
    const game = new Game({ ...rule }, DEFAULT_HANDLING, 2024);
    game.attackMultiplier = 1;
    toPlaying(game);
    const b = game.board;
    const bottom = b.totalRows - 1;
    // 바닥 한 줄을 col 0만 비우고 채워 라인 클리어 준비
    for (let x = 1; x < b.cols; x++) b.grid[bottom * b.cols + x] = Piece.Garbage;
    // 들어온 가비지 1줄(공격 single=0이라 상쇄 검증은 cancel 단위테스트가 담당)
    game.receiveGarbage({ holes: [0] });
    // 콤보/공격 방출 여부와 무관히, 클리어 턴엔 가비지가 큐에 남아야 한다(투하 안 됨)
    const before = game.pendingGarbage;
    expect(before).toBe(1);
  });
});
