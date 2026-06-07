// ============================================================================
// Fetris 코어 엔진 타입 정의
// 결정론적·프레임 기반 시뮬레이션. 모든 시간 단위는 "프레임"(60Hz)이 기준이며
// handling 입력만 사용자 친화적으로 ms/배수로 노출한다.
// ============================================================================

/** 피스 종류. 인덱스가 곧 셀 값(보드에 기록되는 색 ID)으로도 쓰인다. */
export const enum Piece {
  None = 0,
  I = 1,
  J = 2,
  L = 3,
  O = 4,
  S = 5,
  T = 6,
  Z = 7,
  Garbage = 8,
}

/** 회전 상태. 0=spawn, R=시계 1회, 2=180, L=반시계 1회 */
export const enum Rot {
  Spawn = 0,
  Right = 1,
  Two = 2,
  Left = 3,
}

/** 마지막으로 수행한 동작 — 스핀 판정에 필요 */
export const enum LastAction {
  None = 0,
  Move = 1,
  Rotate = 2,
}

/** 스핀 판정 결과 */
export const enum SpinType {
  None = 0,
  Mini = 1,
  Full = 2,
}

/** 라인 클리어 1회의 결과 묶음 — 점수/가비지/이펙트가 공유 */
export interface ClearResult {
  lines: number;
  piece: Piece;
  spin: SpinType;
  perfectClear: boolean;
  b2b: number; // 클리어 직후 b2b 카운트
  combo: number; // 클리어 직후 콤보 카운트
  /** 시즌2 기준 이번 클리어가 보낸(또는 보낼) 가비지 라인 */
  attack: number;
  /** Surge가 이번에 방출됐다면 그 총량 */
  surge: number;
  /** 이 클리어가 b2b를 유지/증가시키는 종류인지 */
  b2bEligible: boolean;
}

/** handling(감도) 설정 — 사용자 노출값 */
export interface Handling {
  das: number; // Delayed Auto Shift, 프레임 (낮을수록 빠름)
  arr: number; // Auto Repeat Rate, 프레임 (0 = 즉시 텔레포트)
  dcd: number; // DAS Cut Delay, 프레임 (0 = 비활성)
  sdf: number; // Soft Drop Factor, 배수 (Infinity = 즉시)
  /** 첫 입력 즉시 1칸 이동 후 DAS 충전 시작 여부(가이드라인 표준 동작) */
  dasInitialMove: boolean;
  /** Prevent Accidental Hard Drops — 하드드롭 후 키를 떼야 다시 발동(릴리즈 게이트) */
  safelock: boolean;
  /** Cancel DAS On Direction Change — 방향 전환 시 DAS 리셋 여부 */
  cancelDas: boolean;
  /** Prefer Soft Drop Over Movement — 같은 프레임에 소프트드롭을 좌우 이동보다 우선 */
  preferSoftDrop: boolean;
}

export type KicksetName = "SRS+" | "SRS-X" | "SRS" | "none";
export type SpinBonusName = "none" | "t-spins" | "all-mini" | "all-mini+" | "all";
export type RandomizerName = "7-bag" | "14-bag" | "classic" | "pairs" | "random";

/** 게임 규칙(룰셋) — Custom 모드에서 전부 노출된다 */
export interface RuleSet {
  // 필드
  cols: number; // 보드 너비(기본 10)
  rows: number; // 가시 영역 높이(기본 20)
  bufferRows: number; // 천장 위 버퍼(스폰/오버플로)
  // 회전/스핀
  kickset: KicksetName;
  allow180: boolean;
  spinBonus: SpinBonusName;
  // 큐
  randomizer: RandomizerName;
  nextCount: number; // 표시할 NEXT 개수(0~7)
  holdEnabled: boolean;
  infiniteHold: boolean;
  // 중력/락
  gravity: number; // G (1G = 1셀/프레임)
  lockDelay: number; // 프레임
  lockResets: number; // 이동/회전 reset 최대 횟수
  are: number; // 스폰 지연 프레임
  lineClearAre: number; // 라인클리어 지연 프레임
  // b2b/콤보
  b2bMode: "surge" | "chaining" | "none";
  comboTable: "multiplier" | "classic" | "none";
  // 기타
  allowHardDrop: boolean;
  ghost: boolean;
  topOutEnabled: boolean; // Zen은 false
  garbageMultiplier: number;
}

export type GameModeName = "sprint" | "blitz" | "zen" | "custom" | "marathon" | "fourwide" | "combo";

/** 게임 한 판의 누적 통계 */
export interface Stats {
  score: number;
  lines: number;
  piecesPlaced: number;
  attack: number; // 누적 보낸 가비지
  startTime: number; // performance.now() 기준 시작 ms (-1 = 미시작)
  frame: number; // 누적 시뮬레이션 프레임
  maxB2b: number;
  maxCombo: number;
  perfectClears: number;
  holds: number;
  finesseFaults: number;
}
