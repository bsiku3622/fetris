import { Piece, SpinType } from "./types.js";
import type { ClearResult, RuleSet } from "./types.js";

// ============================================================================
// 점수 / 가비지 / B2B Surge / 콤보 — TETR.IO 시즌2 기준.
//  - 평시 B2B 보너스 +1
//  - B2Bx4부터 Surge 충전(시작 4라인 + 레벨당 +1), 끊기면 3분할 방출
//  - 비-T 올스핀(Mini)은 B2B 유지하되 공격 0
//  - 콤보 곱셈: base*(1+0.25x), base=0이면 ln(1+1.25x)
//
// 결정론 주의 — 이 파일의 수치 테이블은 사전 계산된 리터럴입니다.
// Math.log/Math.pow는 ECMAScript 명세가 정확한 값을 강제하지 않는 구현 재량
// 함수라, 브라우저(JSC/SpiderMonkey)와 서버(V8)에서 최하위 비트가 갈릴 수 있습니다.
// 서버 사이드 리플레이 검증은 클라이언트와 비트 단위로 같은 결과를 요구하므로,
// 런타임 계산 대신 테이블을 씁니다. 값을 바꿀 땐 테이블을 다시 생성하세요.
// ============================================================================

/**
 * ln(1 + 1.25 * combo)를 combo 0..127 구간에 대해 사전 계산한 값.
 * 128 이상은 마지막 값으로 고정한다(실제 도달 불가능한 영역).
 */
const COMBO_LN: readonly number[] = [
  0, 0.8109302162163288, 1.252762968495368, 1.55814461804655,
  1.791759469228055, 1.9810014688665833, 2.1400661634962708, 2.277267285009756,
  2.3978952727983707, 2.505525936990736, 2.6026896854443837, 2.691243082785829,
  2.772588722239781, 2.847812143477369, 2.917770732084279, 2.9831534913471307,
  3.044522437723423, 3.1023420086122493, 3.157000421150113, 3.2088254890146994,
  3.258096538021482, 3.305053521109253, 3.349904087274605, 3.392829131991639,
  3.4339872044851463, 3.4735180432417816, 3.5115454388310208, 3.548179572010801,
  3.58351893845611, 3.6176519448255684, 3.6506582412937387, 3.6826098411003407,
  3.713572066704308, 3.7436043538031827, 3.7727609380946383, 3.801091444720864,
  3.828641396489095, 3.855452653939752, 3.8815637979434374, 3.907010463604602,
  3.9318256327243257, 3.9560398908449206, 3.979681653901961, 4.00277736869661,
  4.02535169073515, 4.047427642434349, 4.069026754237811, 4.09016919081162,
  4.110873864173311, 4.131158535344817, 4.151039905898646, 4.1705337005796475,
  4.189654742026425, 4.208417018481948, 4.22683374526818, 4.244917420701475,
  4.2626798770413155, 4.2801323269925415, 4.297285406218791, 4.314149212270796,
  4.330733340286331, 4.347046915777855, 4.363098624788362, 4.378896741664954,
  4.394449154672439, 4.409763389645481, 4.42484663185681, 4.43970574626056,
  4.454347296253507, 4.468777561082536, 4.483002552013883, 4.497028027368389,
  4.51085950651685, 4.524502282920636, 4.537961436294641, 4.5512418439625355,
  4.564348191467836, 4.577284982498556, 4.590056548178043, 4.602667055769973,
  4.61512051684126, 4.627420794922911, 4.639571612705423, 4.6515765588022475,
  4.663439094112067, 4.675162557808126, 4.686750172980514, 4.698205051955281,
  4.709530201312334, 4.720728526622364, 4.7318028369214575, 4.7427558489406545,
  4.7535901911063645, 4.764308407326388, 4.774912960575186, 4.785406236291025,
  4.795790545596741, 4.8060681283549815, 4.816241156068032, 4.826311734631628,
  4.836281906951478, 4.846153655430632, 4.855928904335275, 4.865609522045998,
  4.875197323201151, 4.8846940707384086, 4.894101477840304, 4.903421209789107,
  4.912654885736052, 4.92180408038964, 4.930870325627393, 4.939855112035208,
  4.948759890378168, 4.95758607300644, 4.966335035199676, 4.975008116453105,
  4.983606621708336, 4.992131822531696, 5.000584958242754, 5.0089672369955585,
  5.017279836814924, 5.025523906590006, 5.033700567027251, 5.041810911564705,
  5.049856007249537, 5.05783689558055, 5.065754593317335, 5.073610093257644,
];

/**
 * BLITZ 레벨별 중력 — min(20, 0.02 * 1.35^(level-1))를 레벨 1..24에 대해 사전 계산.
 * 레벨 25부터는 상한 20에 걸린다.
 */
const BLITZ_GRAVITY: readonly number[] = [
  0.02, 0.027000000000000003, 0.03645, 0.04920750000000001,
  0.06643012500000002, 0.08968066875000004, 0.12106890281250005, 0.16344301879687506,
  0.22064807537578138, 0.29787490175730486, 0.4021311173723616, 0.5428770084526882,
  0.7328839614111291, 0.9893933479050243, 1.3356810196717832, 1.803169376556907,
  2.434278658351825, 3.286276188774964, 4.436472854846201, 5.989238354042373,
  8.085471777957203, 10.915386900242224, 14.735772315327004, 19.893292625691455,
];

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
    // 미니: 시즌2에서 비-T 올스핀은 공격 0 (B2B만 유지) — 공식 패치노트 "do not send, but keep B2B"
    if (piece !== Piece.T) return 0;
    // 미니 T-spin: single 0, double 1, triple 2(시즌2)
    return lines === 2 ? 1 : lines === 3 ? 2 : 0;
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
    return COMBO_LN[combo < COMBO_LN.length ? combo : COMBO_LN.length - 1];
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
    // 시즌2: 퍼펙트 클리어는 항상 B2B로 친다(All Clear counts as Back-to-Back)
    const eligible = isB2bEligible(lines, spin) || (lines > 0 && board_isEmpty);

    // 콤보 갱신
    if (lines > 0) {
      this.combo++;
    } else {
      this.combo = 0;
    }
    const combo = this.combo - 1; // 첫 클리어 combo=0

    // B2B / Surge 갱신 (시즌2 Charging+Surge)
    let releasedSurge = 0;
    if (lines > 0) {
      if (eligible) {
        this.b2b++;
        // B2Bx4(surgeStart)부터 충전 — 메터 = 현재 B2B 레벨 (b2bx4→4 … b2bx8→8)
        if (this.mode === "surge" && this.b2b >= this.surgeStart) {
          this.surge = this.b2b;
        }
      } else {
        // B2B 끊김 → 충전된 서지를 한 번에 방출
        if (this.mode === "surge" && this.surge > 0) {
          releasedSurge = this.surge;
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
        } else if (this.mode === "surge" && this.b2b < this.surgeStart) {
          base += 1; // 충전 시작 전(B2Bx1~3)엔 +1 송신, 이후엔 서지로 적립(미송신)
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
    // 레벨이 오를수록 중력 증가 (대략 지수) — 테이블 범위를 넘으면 상한 20
    const i = this.level - 1;
    return i < BLITZ_GRAVITY.length ? BLITZ_GRAVITY[i < 0 ? 0 : i] : 20;
  }
}
