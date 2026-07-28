import type { Handling, RuleSet, GameModeName } from "../engine/types";
import type { GameSnapshot } from "../engine/game";
import type { KeyMap } from "../engine/input";
import type { GfxOptions } from "../render/renderer";
import type { AudioOptions } from "../audio/sound";
import type { LoopPerfOptions } from "../engine/loop";
import { DEFAULT_HANDLING, defaultRuleset } from "../engine/config";
import { DEFAULT_KEYMAP } from "../engine/input";
import { DEFAULT_GFX } from "../render/renderer";
import { DEFAULT_AUDIO } from "../audio/sound";

// ============================================================================
// 설정 영속화 — localStorage. 깊은 병합으로 신규 필드 호환.
// ============================================================================

export interface Profile {
  nickname: string;
}

/** 유저가 현재 키맵을 이름 붙여 저장한 커스텀 키 프리셋. */
export interface KeymapPreset {
  id: string;
  label: string;
  keymap: KeyMap;
}

export interface Settings {
  profile: Profile;
  handling: Handling;
  keymap: KeyMap;
  customPresets: KeymapPreset[];
  gfx: GfxOptions;
  audio: AudioOptions;
  perf: LoopPerfOptions;
  rulesets: Record<GameModeName, RuleSet>;
}

/** 랜덤 기본 닉네임 — 매 새 설치마다 다르게 */
function randomNickname(): string {
  return "Player" + Math.floor(1000 + Math.random() * 9000);
}

export const DEFAULT_PERF: LoopPerfOptions = {
  simRate: 60,
  renderFps: 0, // 무제한(주사율)
  interpolate: true,
  lowLatency: true,
};

const KEY = "fetris.settings.v1";

export function defaultSettings(): Settings {
  return {
    profile: { nickname: randomNickname() },
    handling: { ...DEFAULT_HANDLING },
    keymap: structuredClone(DEFAULT_KEYMAP),
    customPresets: [],
    gfx: { ...DEFAULT_GFX },
    audio: { ...DEFAULT_AUDIO },
    perf: { ...DEFAULT_PERF },
    rulesets: {
      sprint: defaultRuleset("sprint"),
      blitz: defaultRuleset("blitz"),
      zen: defaultRuleset("zen"),
      marathon: defaultRuleset("marathon"),
      custom: defaultRuleset("custom"),
      fourwide: defaultRuleset("fourwide"),
      combo: defaultRuleset("combo"),
    },
  };
}

function deepMerge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== "object" || Array.isArray(over)) {
    return (over === undefined ? base : (over as T)) ?? base;
  }
  const out = Array.isArray(base) ? ([...(base as unknown[])] as unknown as T) : ({ ...(base as object) } as T);
  for (const k of Object.keys(over as object)) {
    const bv = (base as Record<string, unknown>)?.[k];
    const ov = (over as Record<string, unknown>)[k];
    (out as Record<string, unknown>)[k] = bv && typeof bv === "object" && !Array.isArray(bv) ? deepMerge(bv, ov) : ov;
  }
  return out;
}

export function loadSettings(): Settings {
  const def = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return def;
    return deepMerge(def, JSON.parse(raw));
  } catch {
    return def;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 무시 */
  }
}

// ---- 베스트 기록 ----------------------------------------------------------
export interface Records {
  sprint40: number | null; // ms (낮을수록 좋음)
  blitz: number | null; // score (높을수록 좋음)
  marathonScore: number | null;
}

const REC_KEY = "fetris.records.v1";

export function loadRecords(): Records {
  try {
    const raw = localStorage.getItem(REC_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* 무시 */
  }
  return { sprint40: null, blitz: null, marathonScore: null };
}

export function saveRecords(r: Records): void {
  try {
    localStorage.setItem(REC_KEY, JSON.stringify(r));
  } catch {
    /* 무시 */
  }
}

// ---- Zen 필드 저장 (세션 간 이어하기) — 전체 게임 스냅샷 ------------------
export type ZenState = GameSnapshot;

const ZEN_KEY = "fetris.zen.v2"; // 스키마 변경(전체 스냅샷)

export function saveZenState(s: ZenState): void {
  try {
    localStorage.setItem(ZEN_KEY, JSON.stringify(s));
  } catch {
    /* 무시 */
  }
}

export function loadZenState(): ZenState | null {
  try {
    const raw = localStorage.getItem(ZEN_KEY);
    return raw ? (JSON.parse(raw) as ZenState) : null;
  } catch {
    return null;
  }
}

export function clearZenState(): void {
  try {
    localStorage.removeItem(ZEN_KEY);
  } catch {
    /* 무시 */
  }
}
