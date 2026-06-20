import { describe, it, expect } from "vitest";
import { detectSpin } from "../src/engine/spin";
import { Board } from "../src/engine/board";
import { Piece, Rot, SpinType } from "../src/engine/types";

// 3x3 T 박스의 특정 코너에만 블록을 채운 보드 생성(스핀 판정 단위 테스트용).
function boardWithCells(cells: Array<[number, number]>): Board {
  const b = new Board(10, 20, 20);
  for (const [x, y] of cells) b.grid[y * b.cols + x] = Piece.Garbage;
  return b;
}

describe("detectSpin — TETR.IO 시즌2 스핀 사다리", () => {
  const px = 3;
  const py = 21; // 가시 영역 어딘가
  // T 박스 네 코너의 보드 좌표
  const TL: [number, number] = [px + 0, py + 0];
  const TR: [number, number] = [px + 2, py + 0];
  const BL: [number, number] = [px + 0, py + 2];
  const BR: [number, number] = [px + 2, py + 2];

  it("none 모드는 항상 None", () => {
    const b = boardWithCells([TL, TR, BL]);
    expect(detectSpin(b, Piece.T, Rot.Spawn, px, py, true, 0, "none")).toBe(SpinType.None);
  });

  it("마지막 동작이 회전이 아니면 None", () => {
    const b = boardWithCells([TL, TR, BL]);
    expect(detectSpin(b, Piece.T, Rot.Spawn, px, py, false, 0, "all-mini+")).toBe(SpinType.None);
  });

  it("all-mini에서도 T는 3-corner로 인정 (회귀: 예전엔 T가 통째로 None이던 버그)", () => {
    const b = boardWithCells([TL, TR, BL]); // 앞 두 코너(TL,TR) 포함 3코너 → Full
    expect(detectSpin(b, Piece.T, Rot.Spawn, px, py, true, 0, "all-mini")).toBe(SpinType.Full);
  });

  it("t-spins 모드 T 3-corner = Full", () => {
    const b = boardWithCells([TL, TR, BL]);
    expect(detectSpin(b, Piece.T, Rot.Spawn, px, py, true, 0, "t-spins")).toBe(SpinType.Full);
  });

  it("3코너지만 앞 코너가 한쪽만 차면 Mini", () => {
    const b = boardWithCells([TL, BL, BR]); // 앞 코너 TR 비어 있음
    expect(detectSpin(b, Piece.T, Rot.Spawn, px, py, true, 0, "all-mini+")).toBe(SpinType.Mini);
  });

  it("5번째 킥(인덱스 4) 사용 시 mini라도 Full로 승격", () => {
    const b = boardWithCells([TL, BL, BR]); // 평소엔 Mini
    expect(detectSpin(b, Piece.T, Rot.Spawn, px, py, true, 4, "all-mini+")).toBe(SpinType.Full);
  });

  it("코너 2개뿐이면 None", () => {
    const b = boardWithCells([TL, TR]);
    expect(detectSpin(b, Piece.T, Rot.Spawn, px, py, true, 0, "all-mini+")).toBe(SpinType.None);
  });

  it("t-spins 모드에서 비-T는 스핀 없음", () => {
    const b = boardWithCells([TL, TR, BL]);
    expect(detectSpin(b, Piece.S, Rot.Spawn, px, py, true, 0, "t-spins")).toBe(SpinType.None);
  });

  it("자유롭게 움직일 수 있는 비-T는 immobile이 아니라 None", () => {
    const b = new Board(10, 20, 20); // 텅 빈 보드
    expect(detectSpin(b, Piece.S, Rot.Spawn, px, py, true, 0, "all-mini+")).toBe(SpinType.None);
  });
});
