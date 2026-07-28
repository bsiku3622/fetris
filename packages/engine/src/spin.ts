import { Piece, Rot, SpinType } from "./types.js";
import type { SpinBonusName } from "./types.js";
import type { Board } from "./board.js";
import { BOX_SIZE } from "./pieces.js";

// ============================================================================
// 스핀 판정 — TETR.IO 시즌2 기준. 마지막 동작이 회전(rotate)일 때만 스핀 가능.
//  - T: 항상 3-corner 룰(full/mini)이 우선. all-mini+/all에선 3-corner가 안 맞아도
//       immobile이면 인정(시즌2 완화: immobile T = Mini, all 모드는 Full).
//  - 비-T(올스핀): t-spins=없음 · all-mini/all-mini+=immobile→Mini · all=immobile→Full.
//  - full vs mini: 앞 두 코너가 모두 차거나 5번째 킥(TST) 사용 시 full, 아니면 mini.
// ============================================================================

/** T 피스 회전 상태별 "앞쪽" 두 코너의 박스-상대 좌표 (3x3 박스 기준). */
// 코너는 박스의 네 모서리 (0,0),(2,0),(0,2),(2,2).
const T_FRONT_CORNERS: Record<Rot, [number, number, number, number]> = {
  // [ax,ay, bx,by] — T가 향한 방향의 두 앞 코너
  [Rot.Spawn]: [0, 0, 2, 0], // 위를 향함 → 상단 두 코너
  [Rot.Right]: [2, 0, 2, 2], // 오른쪽 → 우측 두 코너
  [Rot.Two]: [0, 2, 2, 2], // 아래 → 하단 두 코너
  [Rot.Left]: [0, 0, 0, 2], // 왼쪽 → 좌측 두 코너
};

const ALL_CORNERS: [number, number][] = [
  [0, 0],
  [2, 0],
  [0, 2],
  [2, 2],
];

/**
 * 스핀 판정. lastWasRotate=false면 항상 None.
 * usedKickIndex: 회전에 사용된 킥 테스트 인덱스(0 base). 5번째(인덱스 4) 사용 시 T-spin full 예외.
 * lastRotMovedY: (사용 안 함, 호환용)
 */
export function detectSpin(
  board: Board,
  piece: Piece,
  rot: Rot,
  px: number,
  py: number,
  lastWasRotate: boolean,
  usedKickIndex: number,
  bonus: SpinBonusName,
): SpinType {
  if (!lastWasRotate || bonus === "none") return SpinType.None;
  if (piece === Piece.O) return SpinType.None;

  const allFull = bonus === "all";

  if (piece === Piece.T) {
    // T는 항상 3-corner 룰 우선(full/mini)
    const t = detectTSpin(board, rot, px, py, usedKickIndex);
    if (t !== SpinType.None) return t;
    // 3-corner 미성립: all-mini+/all에서만 immobile T 인정(시즌2 완화 — immobile T = Mini)
    if ((bonus === "all-mini+" || allFull) && isImmobile(board, piece, rot, px, py)) {
      return allFull ? SpinType.Full : SpinType.Mini;
    }
    return SpinType.None;
  }

  // 비-T 피스: t-spins 모드에선 스핀 없음
  if (bonus === "t-spins") return SpinType.None;
  // all-mini / all-mini+ / all : immobile 판정 (all이면 Full, 그 외 Mini)
  if (isImmobile(board, piece, rot, px, py)) {
    return allFull ? SpinType.Full : SpinType.Mini;
  }
  return SpinType.None;
}

function detectTSpin(board: Board, rot: Rot, px: number, py: number, usedKickIndex: number): SpinType {
  // 네 코너 중 채워진 수
  let filled = 0;
  for (const [cx, cy] of ALL_CORNERS) {
    if (board.isSolid(px + cx, py + cy)) filled++;
  }
  if (filled < 3) return SpinType.None;

  // full vs mini: 앞쪽 두 코너가 모두 채워졌으면 full
  const fc = T_FRONT_CORNERS[rot];
  const frontA = board.isSolid(px + fc[0], py + fc[1]);
  const frontB = board.isSolid(px + fc[2], py + fc[3]);
  if (frontA && frontB) return SpinType.Full;

  // 5번째 킥(인덱스 4) 사용 시 mini라도 full로 승격 (TST 등)
  if (usedKickIndex >= 4) return SpinType.Full;

  return SpinType.Mini;
}

/** immobile: 회전 직후 상/하/좌/우 어디로도 못 움직이면 스핀. */
export function isImmobile(board: Board, piece: Piece, rot: Rot, px: number, py: number): boolean {
  const shape = SHAPE_REF[piece][rot];
  // 위로 못 가고(오버행), 아래/좌/우 막힘
  if (!board.collides(shape, px, py - 1)) return false; // 위로 이동 가능 → immobile 아님
  if (!board.collides(shape, px, py + 1)) return false; // 아래
  if (!board.collides(shape, px - 1, py)) return false; // 왼쪽
  if (!board.collides(shape, px + 1, py)) return false; // 오른쪽
  return true;
}

// 순환 의존을 피하려 형상 참조를 늦게 바인딩
import { SHAPES } from "./pieces.js";
const SHAPE_REF = SHAPES;

/** 박스 크기(코너 좌표 보정용) — JLSTZ는 3, I/O는 다름. T-spin은 T만이므로 3 고정 사용. */
export function cornerSpanFor(piece: Piece): number {
  return BOX_SIZE[piece];
}
