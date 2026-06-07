import { Piece, Rot } from "./types";
import { SHAPES, spawnX } from "./pieces";

// ============================================================================
// Finesse — 빈 보드에서 피스를 (목표 x, 목표 회전)에 놓는 최소 "입력" 수를 BFS로 계산.
// 입력 1회로 치는 것: 탭L, 탭R, DAS-L(벽까지), DAS-R(벽까지), 회전 CW/CCW/180.
// (하드/소프트드롭·홀드는 finesse 입력에 포함하지 않음 — 표준 규칙)
// 플레이어 실제 입력 수 - 최소 = finesse fault.
// 회전은 킥을 관대하게 모델링(새 회전의 유효 범위로 x 클램프).
// ============================================================================

/** 회전 상태에서 셀들의 로컬 x 최소/최대 */
function localXBounds(piece: Piece, rot: Rot): [number, number] {
  const shape = SHAPES[piece][rot];
  let mn = 99,
    mx = -99;
  for (let i = 0; i < 8; i += 2) {
    const x = shape[i];
    if (x < mn) mn = x;
    if (x > mx) mx = x;
  }
  return [mn, mx];
}

/** 보드 너비 cols에서 회전 rot일 때 박스 x의 유효 범위 [min, max] */
function validXRange(piece: Piece, rot: Rot, cols: number): [number, number] {
  const [lmn, lmx] = localXBounds(piece, rot);
  return [-lmn, cols - 1 - lmx];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** (targetX, targetRot)에 도달하는 최소 입력 수. 도달 불가면 큰 수. */
export function optimalInputs(piece: Piece, targetX: number, targetRot: Rot, cols: number): number {
  const sx = spawnX(piece, cols);
  const startRot = Rot.Spawn;

  // O는 회전 무의미 — targetRot 무시하고 x만
  const rots = piece === Piece.O ? 1 : 4;

  const key = (x: number, r: number) => r * (cols + 4) + (x + 2);
  const visited = new Set<number>();
  // BFS
  let frontier: [number, number][] = [[sx, startRot]];
  visited.add(key(sx, startRot));
  let depth = 0;

  while (frontier.length) {
    const next: [number, number][] = [];
    for (const [x, rot] of frontier) {
      const matchRot = piece === Piece.O ? true : rot === targetRot;
      if (x === targetX && matchRot) return depth;

      const [vmin, vmax] = validXRange(piece, rot as Rot, cols);
      const cands: [number, number][] = [];
      // 회전
      if (rots > 1) {
        for (const r2 of [(rot + 1) % 4, (rot + 3) % 4, (rot + 2) % 4]) {
          const [n2min, n2max] = validXRange(piece, r2 as Rot, cols);
          cands.push([clamp(x, n2min, n2max), r2]);
        }
      }
      // 이동
      if (x - 1 >= vmin) cands.push([x - 1, rot]);
      if (x + 1 <= vmax) cands.push([x + 1, rot]);
      cands.push([vmin, rot]); // DAS-L
      cands.push([vmax, rot]); // DAS-R

      for (const [nx, nr] of cands) {
        const k = key(nx, nr);
        if (!visited.has(k)) {
          visited.add(k);
          next.push([nx, nr]);
        }
      }
    }
    frontier = next;
    depth++;
    if (depth > 12) break; // 안전장치
  }
  return 99; // 도달 불가
}

/** finesse fault 수: 실제 입력 - 최소(음수면 0) */
export function finesseFault(piece: Piece, actualInputs: number, finalX: number, finalRot: Rot, cols: number): number {
  const opt = optimalInputs(piece, finalX, finalRot, cols);
  if (opt >= 99) return 0; // 계산 불가 시 fault 없음 처리
  return Math.max(0, actualInputs - opt);
}
