import type { Handling } from "./types";

// ============================================================================
// Handling 컨트롤러 — DAS/ARR/DCD를 서브프레임 정밀도로 처리.
// 매 시뮬 틱에 dtFrames(보통 1.0, simRate에 따라 가변)를 받아
// 이번 틱에 수행할 수평 이동 셀 수를 반환한다. ARR=0이면 벽까지(=큰 수).
// 입력은 keydown/keyup 시 호출되며, 내부적으로 프레임 누적기로 양자화 없이 계산.
// ============================================================================

export class HandlingController {
  h: Handling;
  private leftHeld = false;
  private rightHeld = false;
  private dir = 0; // -1, 0, 1 현재 활성 방향
  private dasCharge = 0; // 누적 프레임
  private arrCharge = 0;
  private pendingInitialMove = 0; // 첫 1칸 즉시 이동 플래그

  constructor(h: Handling) {
    this.h = h;
  }

  setHandling(h: Handling): void {
    this.h = h;
  }

  reset(): void {
    this.leftHeld = false;
    this.rightHeld = false;
    this.dir = 0;
    this.dasCharge = 0;
    this.arrCharge = 0;
    this.pendingInitialMove = 0;
  }

  /** 방향키 눌림. 즉시 1칸 이동을 예약하고 DAS 충전 시작. */
  press(dir: -1 | 1): void {
    if (dir === -1) this.leftHeld = true;
    else this.rightHeld = true;
    const fromNeutral = this.dir === 0;
    this.dir = dir;
    this.arrCharge = 0;
    this.pendingInitialMove = dir;
    // 중립에서의 첫 누름은 항상 DAS 재시작.
    // 방향 전환은 cancelDas=on일 때만 리셋(off면 충전 유지 → 반대로 즉시 연사).
    if (fromNeutral || this.h.cancelDas) this.dasCharge = 0;
  }

  /** 방향키 떼기. 반대 방향이 여전히 눌려있으면 그쪽으로 전환. */
  release(dir: -1 | 1): void {
    if (dir === -1) this.leftHeld = false;
    else this.rightHeld = false;

    if (this.dir === dir) {
      // 현재 방향을 뗌 — 반대가 눌려있으면 전환(즉시 이동 + DAS 재충전)
      const other = dir === -1 ? (this.rightHeld ? 1 : 0) : this.leftHeld ? -1 : 0;
      if (other !== 0) {
        this.dir = other as -1 | 1;
        this.arrCharge = 0;
        this.pendingInitialMove = other;
        // 방향 전환과 동일 규칙: cancelDas일 때만 리셋
        if (this.h.cancelDas) this.dasCharge = 0;
      } else {
        this.dir = 0;
      }
    }
  }

  /** 회전/스폰 시 DAS Cut 적용 (DCD>0이면 DAS 충전을 일시 정지) */
  onRotateOrSpawn(): void {
    if (this.h.dcd > 0 && this.dir !== 0) {
      // DAS를 dcd만큼 되돌려 cut
      this.dasCharge = Math.min(this.dasCharge, this.h.das - this.h.dcd);
      if (this.dasCharge < 0) this.dasCharge = 0;
    }
  }

  /**
   * 이번 틱의 수평 이동량(부호 포함 셀 수) 반환.
   * @param dtFrames 이번 틱의 프레임 수 (60Hz 기준 1.0)
   */
  update(dtFrames: number): number {
    let move = 0;

    // 즉시 1칸 이동 (press 직후 첫 틱)
    if (this.pendingInitialMove !== 0) {
      move += this.pendingInitialMove;
      this.pendingInitialMove = 0;
    }

    if (this.dir === 0) return move;

    // DAS 충전
    this.dasCharge += dtFrames;
    if (this.dasCharge < this.h.das) return move;

    // DAS 완료 — ARR 처리
    if (this.h.arr <= 0) {
      // 0 ARR: 벽까지 즉시 (큰 수를 반환, 게임이 충돌로 클램프)
      move += this.dir * 999;
      return move;
    }

    this.arrCharge += dtFrames;
    while (this.arrCharge >= this.h.arr) {
      this.arrCharge -= this.h.arr;
      move += this.dir;
    }
    return move;
  }

  get activeDir(): number {
    return this.dir;
  }
}

/**
 * 소프트드롭 중력(셀/프레임) 계산.
 * SDF 무한 처리: 41 이상 = 즉시(∞). null/NaN/Infinity도 ∞로 간주
 * (localStorage는 Infinity를 직렬화 못 해 null로 저장되므로 마이그레이션 호환).
 * 그 외 유한값은 baseGravity*sdf, 단 최소 사용성 보장.
 */
export const SDF_INFINITE = 41;
export function softDropGravity(baseGravity: number, sdf: number): number {
  if (sdf == null || !isFinite(sdf) || sdf >= SDF_INFINITE) return Infinity;
  return Math.max(baseGravity * sdf, sdf * 0.05);
}
