import type { Handling, RuleSet, GameModeName } from "./types";

// ============================================================================
// 기본 설정값 — handling(전역), 모드별 RuleSet.
// Tetr.io 표준값을 기준으로 한다.
// ============================================================================

/** 전역 handling 기본값 (Tetr.io 신규 유저 기본) */
export const DEFAULT_HANDLING: Handling = {
  das: 10, // frames (~167ms)
  arr: 2, // frames (~33ms)
  dcd: 0, // frames (비활성)
  sdf: 6, // 배수
  dasInitialMove: false,
  safelock: true, // 하드드롭 후 키 릴리즈 필요(실수 방지)
  cancelDas: false,
  preferSoftDrop: false,
};

/** 표준 가이드라인 룰셋 (40L/Blitz 등 경쟁 모드 베이스) */
export const STANDARD_RULESET: RuleSet = {
  cols: 10,
  rows: 20,
  bufferRows: 20,
  kickset: "SRS+",
  allow180: true,
  spinBonus: "all-mini+",
  randomizer: "7-bag",
  nextCount: 5,
  holdEnabled: true,
  infiniteHold: false,
  gravity: 0.02, // G — 부드러운 시작 중력
  lockDelay: 30, // frames (0.5s)
  lockResets: 15,
  are: 0,
  lineClearAre: 0,
  b2bMode: "surge",
  comboTable: "multiplier",
  allowHardDrop: true,
  ghost: true,
  topOutEnabled: true,
  garbageMultiplier: 1,
};

function clone(base: RuleSet, over: Partial<RuleSet>): RuleSet {
  return { ...base, ...over };
}

/** 모드별 기본 RuleSet */
export const MODE_RULESETS: Record<GameModeName, RuleSet> = {
  // 40 LINES: 표준, 라인 목표는 모드 로직에서 처리
  sprint: clone(STANDARD_RULESET, { b2bMode: "chaining" }),
  // BLITZ: 자체 점수계, 레벨 중력은 모드에서 덮어씀
  blitz: clone(STANDARD_RULESET, { b2bMode: "chaining" }),
  // ZEN: 샌드박스. 막히면 게임오버 대신 필드만 리셋(GameSession이 topOutResets 설정)
  zen: clone(STANDARD_RULESET, { topOutEnabled: true }),
  // MARATHON: 점진적 중력 상승
  marathon: clone(STANDARD_RULESET, { topOutEnabled: true }),
  // CUSTOM: 전부 노출, 기본은 표준
  custom: clone(STANDARD_RULESET, {}),
  // 4-WIDE: 너비 4칸의 좁은 보드 Zen. 막히면 필드 리셋(GameSession이 topOutResets 설정)
  fourwide: clone(STANDARD_RULESET, { cols: 4, topOutEnabled: true }),
  // COMBO: 4-wide 콤보 트레이너. 바닥에 항상 가비지 3줄 유지(Mode가 보충)
  combo: clone(STANDARD_RULESET, { cols: 4, topOutEnabled: true, b2bMode: "chaining" }),
};

export function defaultRuleset(mode: GameModeName): RuleSet {
  return { ...MODE_RULESETS[mode] };
}
