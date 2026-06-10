import { Piece, SpinType } from "./types";
import type { ClearResult, RuleSet } from "./types";

// ============================================================================
// 점수 / 가비지 / B2B Surge / 콤보 — TETR.IO 시즌2 기준.
//  - 평시 B2B 보너스 +1
//  - B2Bx4부터 Surge 충전(시작 4라인 + 레벨당 +1), 끊기면 3분할 방출
//  - 비-T 올스핀(Mini)은 B2B 유지하되 공격 0
//  - 콤보 곱셈: base*(1+0.25x), base=0이면 ln(1+1.25x)
// ============================================================================

/** 클리어 종류별 베이스 가비지(멀티/콤보 적용 전) */
function baseAttack(lines: number, spin: SpinType, piece: Piece): number {
  if (spin === SpinType.Full) {
    if (piece === Piece.T) {
      // T-spin
      return lines === 1 ? 2 : lines === 2 ? 4 : lines === 3 ? 6 : 0;
    }
    // 비-T full spin (all 모드): 라인당 강하게
    return lines === 1 ? 2 : lines === 2 ? 4 : lines === 3 ? 6 : 0;
  }
  if (spin === SpinType.Mini) {
    // 미니: 시즌2에서 비-T 올스핀은 공격 0 (B2B만 유지)
    if (piece !== Piece.T) return 0;
    // 미니 T-spin
    return lines === 1 ? 0 : lines === 2 ? 1 : 0;
  }
  // 일반 라인 클리어
  switch (lines) {
    case 1:
      return 0; // single
    case 2:
      return 1; // double
    case 3:
      return 2; // triple
    case 4:
      return 4; // quad
    default:
      return 0;
  }
}

/** 이 클리어가 B2B를 유지/증가시키는지 (quad 또는 스핀) */
function isB2bEligible(lines: number, spin: SpinType): boolean {
  if (lines === 0) return false;
  return lines >= 4 || spin !== SpinType.None;
}

/** 시즌1 B2B Chaining 보너스 라인 (B2B 카운트 → 추가 라인) */
function chainBonus(b2b: number): number {
  if (b2b < 1) return 0;
  if (b2b <= 1) return 0;
  if (b2b <= 3) return 1;
  if (b2b <= 8) return 2;
  if (b2b <= 24) return 3;
  if (b2b <= 67) return 4;
  if (b2b <= 185) return 5;
  if (b2b <= 504) return 6;
  if (b2b <= 1370) return 7;
  return 8;
}

/** 콤보 멀티플라이어 적용 */
function applyCombo(base: number, combo: number, table: RuleSet["comboTable"]): number {
  if (table === "none" || combo <= 0) return base;
  if (table === "classic") {
    // 단순 가산형
    return base + Math.max(0, combo - 1);
  }
  // multiplier (TETR.IO 기본)
  if (base > 0) {
    return base * (1 + 0.25 * combo);
  }
  // base 0 (콤보 중 single 등): 2콤보 이상에 ln 보너스
  if (combo >= 2) {
    return Math.log(1 + 1.25 * combo);
  }
  return 0;
}

/** B2B Surge 상태 — 게임에 1개 보유 */
export class B2BSurge {
  b2b = 0;
  combo = 0;
  private surge = 0;
  private surgeStart: number;
  private mode: RuleSet["b2bMode"];

  constructor(rule: RuleSet, surgeStart = 4) {
    this.mode = rule.b2bMode;
    this.surgeStart = surgeStart;
  }

  reset(): void {
    this.b2b = 0;
    this.combo = 0;
    this.surge = 0;
  }

  /** 현재 충전된 서지량 (메터 표시용) */
  get surgeCharge(): number {
    return this.surge;
  }
  /** 서지 시작 라인(방출 시 더해지는 베이스) */
  get surgeStartLines(): number {
    return this.surgeStart;
  }

  /** undo용 스냅샷 */
  snapshot(): { b2b: number; combo: number; surge: number } {
    return { b2b: this.b2b, combo: this.combo, surge: this.surge };
  }
  restoreFrom(s: { b2b: number; combo: number; surge: number }): void {
    this.b2b = s.b2b;
    this.combo = s.combo;
    this.surge = s.surge;
  }

  /**
   * 라인 클리어 처리. 점수/가비지/콤보/B2B/Surge를 갱신하고 ClearResult 반환.
   * 라인 0(스핀만, 클리어 없음)도 호출되면 콤보/B2B 갱신 처리.
   */
  process(lines: number, spin: SpinType, piece: Piece, board_isEmpty: boolean, rule: RuleSet): ClearResult {
    const eligible = isB2bEligible(lines, spin);

    // 콤보 갱신
    if (lines > 0) {
      this.combo++;
    } else {
      this.combo = 0;
    }
    const combo = this.combo - 1; // 첫 클리어 combo=0

    // B2B / Surge 갱신
    let releasedSurge = 0;
    if (lines > 0) {
      if (eligible) {
        this.b2b++;
        if (this.mode === "surge" && this.b2b >= 4) {
          this.surge += 1; // 레벨당 +1 충전
        }
      } else {
        // B2B 끊김 → Surge 방출
        if (this.mode === "surge" && this.surge > 0) {
          releasedSurge = this.surgeStart + this.surge;
        }
        this.b2b = 0;
        this.surge = 0;
      }
    }

    // 공격 계산
    let attack = 0;
    if (lines > 0) {
      let base = baseAttack(lines, spin, piece);
      // B2B 보너스
      if (eligible && this.b2b >= 1) {
        if (this.mode === "chaining") {
          base += chainBonus(this.b2b);
        } else if (this.mode === "surge") {
          base += 1; // 평시 +1
        }
      }
      attack = applyCombo(base, combo, rule.comboTable);
      // 퍼펙트 클리어 보너스(룰값, Tetr.io 시즌2 기본 5)
      if (board_isEmpty) attack += rule.perfectClearDamage ?? 5;
      attack *= rule.garbageMultiplier;
      attack = Math.floor(attack + 1e-9);
    }
    attack += releasedSurge;

    return {
      lines,
      piece,
      spin,
      perfectClear: lines > 0 && board_isEmpty,
      b2b: this.b2b,
      combo: this.combo,
      attack,
      surge: releasedSurge,
      b2bEligible: eligible,
    };
  }
}

// ---- BLITZ 점수계 (별도) --------------------------------------------------
const BLITZ_LINE = [0, 100, 300, 500, 800]; // single..quad
const BLITZ_SPIN = [400, 800, 1200, 1600, 2600]; // spin zero..quad
const BLITZ_MINI = [100, 200, 400, 800]; // mini zero..triple
const BLITZ_LEVEL_LINES = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 24, 26, 28, 30, 32];

export class BlitzScore {
  score = 0;
  level = 1;
  private linesThisLevel = 0;

  reset(): void {
    this.score = 0;
    this.level = 1;
    this.linesThisLevel = 0;
  }

  /** 라인 클리어에 대한 점수 가산. combo는 현재 콤보(0 base), b2b는 b2b 여부. */
  add(lines: number, spin: SpinType, b2bActive: boolean, combo: number): number {
    let pts = 0;
    if (spin === SpinType.Full) {
      pts = BLITZ_SPIN[lines] ?? 0;
    } else if (spin === SpinType.Mini) {
      pts = BLITZ_MINI[lines] ?? 0;
    } else {
      pts = BLITZ_LINE[lines] ?? 0;
    }
    pts *= this.level;
    if (b2bActive && lines > 0) pts = Math.floor(pts * 1.5);
    if (combo > 0) pts += combo * 50;
    this.score += pts;

    if (lines > 0) {
      this.linesThisLevel += lines;
      const need = BLITZ_LEVEL_LINES[Math.min(this.level - 1, BLITZ_LEVEL_LINES.length - 1)];
      if (this.linesThisLevel >= need) {
        this.linesThisLevel -= need;
        this.level++;
      }
    }
    return pts;
  }

  addDrop(cells: number, hard: boolean): void {
    this.score += cells * (hard ? 2 : 1);
  }

  /** BLITZ 레벨 기반 중력(G) */
  gravity(): number {
    // 레벨이 오를수록 중력 증가 (대략 지수)
    return Math.min(20, 0.02 * Math.pow(1.35, this.level - 1));
  }
}
