import { Piece, Rot } from "./types";

// ============================================================================
// 피스 형상 + 스폰 데이터
// 좌표계: 보드 기준 y-down (행 인덱스가 아래로 증가). 셀은 바운딩 박스 좌상단
// 기준 상대 (x, y). 충돌 검사/회전 hot path에서 할당이 없도록 평탄한 숫자 배열로 보관.
// 각 회전 상태는 [x0,y0, x1,y1, x2,y2, x3,y3] 8개 숫자(4셀)로 저장.
// ============================================================================

export type CellList = readonly number[]; // [x,y]*4
export type PieceShape = readonly [CellList, CellList, CellList, CellList]; // [Spawn, R, 2, L]

// I 피스 (4x4 박스)
const I: PieceShape = [
  [0, 1, 1, 1, 2, 1, 3, 1], // spawn
  [2, 0, 2, 1, 2, 2, 2, 3], // R
  [0, 2, 1, 2, 2, 2, 3, 2], // 2
  [1, 0, 1, 1, 1, 2, 1, 3], // L
];

// J 피스 (3x3 박스)
const J: PieceShape = [
  [0, 0, 0, 1, 1, 1, 2, 1],
  [1, 0, 2, 0, 1, 1, 1, 2],
  [0, 1, 1, 1, 2, 1, 2, 2],
  [1, 0, 1, 1, 0, 2, 1, 2],
];

// L 피스 (3x3 박스)
const L: PieceShape = [
  [2, 0, 0, 1, 1, 1, 2, 1],
  [1, 0, 1, 1, 1, 2, 2, 2],
  [0, 1, 1, 1, 2, 1, 0, 2],
  [0, 0, 1, 0, 1, 1, 1, 2],
];

// O 피스 (2x2 박스, 회전해도 동일 — 킥 없음)
const O: PieceShape = [
  [0, 0, 1, 0, 0, 1, 1, 1],
  [0, 0, 1, 0, 0, 1, 1, 1],
  [0, 0, 1, 0, 0, 1, 1, 1],
  [0, 0, 1, 0, 0, 1, 1, 1],
];

// S 피스 (3x3 박스)
const S: PieceShape = [
  [1, 0, 2, 0, 0, 1, 1, 1],
  [1, 0, 1, 1, 2, 1, 2, 2],
  [1, 1, 2, 1, 0, 2, 1, 2],
  [0, 0, 0, 1, 1, 1, 1, 2],
];

// T 피스 (3x3 박스)
const T: PieceShape = [
  [1, 0, 0, 1, 1, 1, 2, 1],
  [1, 0, 1, 1, 2, 1, 1, 2],
  [0, 1, 1, 1, 2, 1, 1, 2],
  [1, 0, 0, 1, 1, 1, 1, 2],
];

// Z 피스 (3x3 박스)
const Z: PieceShape = [
  [0, 0, 1, 0, 1, 1, 2, 1],
  [2, 0, 1, 1, 2, 1, 1, 2],
  [0, 1, 1, 1, 1, 2, 2, 2],
  [1, 0, 0, 1, 1, 1, 0, 2],
];

/** Piece 열거형 인덱스로 형상 조회. None/Garbage는 placeholder. */
export const SHAPES: Record<number, PieceShape> = {
  [Piece.I]: I,
  [Piece.J]: J,
  [Piece.L]: L,
  [Piece.O]: O,
  [Piece.S]: S,
  [Piece.T]: T,
  [Piece.Z]: Z,
};

/** 바운딩 박스 한 변 크기 (I=4, O=2, 나머지=3). 스폰 위치·코너 판정에 사용. */
export const BOX_SIZE: Record<number, number> = {
  [Piece.I]: 4,
  [Piece.J]: 3,
  [Piece.L]: 3,
  [Piece.O]: 2,
  [Piece.S]: 3,
  [Piece.T]: 3,
  [Piece.Z]: 3,
};

/** 7-bag 순서 기준 전체 피스 목록 */
export const ALL_PIECES: readonly Piece[] = [
  Piece.I,
  Piece.J,
  Piece.L,
  Piece.O,
  Piece.S,
  Piece.T,
  Piece.Z,
];

/**
 * 스폰 시 바운딩 박스 좌상단 x 좌표 계산.
 * 가이드라인: 보드 가로 중앙. 짝수 너비 기준 왼쪽으로 정렬.
 */
export function spawnX(piece: Piece, cols: number): number {
  const box = BOX_SIZE[piece];
  // I,O는 박스가 짝수라 정확히 중앙, JLSTZ는 3폭이라 중앙에서 왼쪽 정렬
  return Math.floor((cols - box) / 2);
}

/** 현재 형상 셀 목록 조회 */
export function shapeOf(piece: Piece, rot: Rot): CellList {
  return SHAPES[piece][rot];
}
