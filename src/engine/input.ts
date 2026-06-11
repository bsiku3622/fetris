import { Game } from "./game";
import type { InputCommands } from "./game";

// ============================================================================
// InputManager — DOM 키보드 → 게임 입력.
//  - 방향키(L/R)는 handling에 즉시 press/release (서브프레임 DAS 정밀도).
//  - soft drop은 held 상태로 매 poll 반영.
//  - rotate/hold/hardDrop은 keydown 엣지에서 1회 적립, poll 시 소비.
//  - 키맵 리매핑 가능. e.repeat(OS 오토리피트)는 무시.
// ============================================================================

export interface KeyMap {
  moveLeft: string[];
  moveRight: string[];
  softDrop: string[];
  hardDrop: string[];
  rotateCW: string[];
  rotateCCW: string[];
  rotate180: string[];
  hold: string[];
  retry: string[];
  pause: string[];
}

/** 게임 플레이 키 — 프리셋이 다루는 대상. */
export const GAME_ACTIONS: (keyof KeyMap)[] = ["moveLeft", "moveRight", "softDrop", "hardDrop", "rotateCW", "rotateCCW", "rotate180", "hold"];
/** 시스템 키 — 프리셋과 무관(다시하기·일시정지). */
export const SYSTEM_ACTIONS: (keyof KeyMap)[] = ["retry", "pause"];

export const DEFAULT_KEYMAP: KeyMap = {
  moveLeft: ["ArrowLeft"],
  moveRight: ["ArrowRight"],
  softDrop: ["ArrowDown"],
  hardDrop: ["Space"],
  rotateCW: ["ArrowUp", "KeyX"],
  rotateCCW: ["KeyZ"],
  rotate180: ["KeyA"],
  hold: ["KeyC", "ShiftLeft"],
  retry: ["KeyR"],
  pause: ["Escape", "F1"],
};

/** 클래식(가이드라인) — 화살표 + Z/X 회전, Ctrl로 CCW 추가. */
const CLASSIC_KEYMAP: KeyMap = {
  moveLeft: ["ArrowLeft"],
  moveRight: ["ArrowRight"],
  softDrop: ["ArrowDown"],
  hardDrop: ["Space"],
  rotateCW: ["ArrowUp", "KeyX"],
  rotateCCW: ["KeyZ", "ControlLeft"],
  rotate180: ["KeyA"],
  hold: ["KeyC", "ShiftLeft"],
  retry: ["KeyR"],
  pause: ["Escape", "F1"],
};

/** WASD — 왼손 이동(A/D)·드랍(W/S), 오른손 화살표 회전, Shift 홀드. */
const WASD_KEYMAP: KeyMap = {
  moveLeft: ["KeyA"],
  moveRight: ["KeyD"],
  softDrop: ["KeyW"],
  hardDrop: ["KeyS"],
  rotateCW: ["ArrowRight"],
  rotateCCW: ["ArrowLeft"],
  rotate180: ["ArrowUp"],
  hold: ["ShiftLeft"],
  retry: ["KeyR"],
  pause: ["Escape", "F1"],
};

/** IOP — 오른손 홈 포지션(L;'Op[/). */
const IOP_KEYMAP: KeyMap = {
  moveLeft: ["KeyL"],
  moveRight: ["Quote"],
  softDrop: ["KeyP"],
  hardDrop: ["Semicolon"],
  rotateCW: ["BracketLeft"],
  rotateCCW: ["KeyO"],
  rotate180: ["Slash"],
  hold: ["ShiftLeft"],
  retry: ["KeyR"],
  pause: ["Escape", "F1"],
};

export const KEYMAP_PRESETS: { id: string; label: string; keymap: KeyMap }[] = [
  { id: "classic", label: "클래식", keymap: CLASSIC_KEYMAP },
  { id: "wasd", label: "WASD", keymap: WASD_KEYMAP },
  { id: "iop", label: "IOP", keymap: IOP_KEYMAP },
];

/** 여러 프리셋을 합쳐 하나의 키맵으로(동작별 키 union, 최대 3개). 선택 순서대로 우선. */
export function mergeKeymaps(maps: KeyMap[]): KeyMap {
  const actions = Object.keys(DEFAULT_KEYMAP) as (keyof KeyMap)[];
  const out = {} as KeyMap;
  for (const a of actions) {
    const codes: string[] = [];
    for (const m of maps) for (const c of m[a] ?? []) if (!codes.includes(c)) codes.push(c);
    out[a] = codes.slice(0, 3);
  }
  return out;
}

/** 현재 키맵이 프리셋의 게임 키를 (동작별로) 모두 포함하면 true — 프리셋 활성 표시 판정. 게임 키가 하나도 없으면 false. 시스템 키는 무시. */
export function keymapHasPreset(keymap: KeyMap, preset: KeyMap): boolean {
  let any = false;
  for (const a of GAME_ACTIONS) {
    for (const c of preset[a] ?? []) {
      any = true;
      if (!(keymap[a] ?? []).includes(c)) return false;
    }
  }
  return any;
}

/** 프리셋의 게임 키를 현재 키맵에 합쳐 적용(union, 동작당 최대 3개, 기존 키 우선). 시스템 키는 그대로 둠. */
export function addPresetToKeymap(keymap: KeyMap, preset: KeyMap): KeyMap {
  const out = structuredClone(keymap);
  for (const a of GAME_ACTIONS) {
    const codes = [...(keymap[a] ?? [])];
    for (const c of preset[a] ?? []) if (!codes.includes(c)) codes.push(c);
    out[a] = codes.slice(0, 3);
  }
  return out;
}

/** 프리셋의 게임 키를 현재 키맵에서 동작별로 제거. 시스템 키는 그대로 둠. */
export function removePresetFromKeymap(keymap: KeyMap, preset: KeyMap): KeyMap {
  const out = structuredClone(keymap);
  for (const a of GAME_ACTIONS) {
    const drop = new Set(preset[a] ?? []);
    out[a] = (keymap[a] ?? []).filter((c) => !drop.has(c));
  }
  return out;
}

type Action = keyof KeyMap;

export class InputManager {
  private game: Game;
  keymap: KeyMap;
  private lookup = new Map<string, Action>();
  private softHeld = false;
  private leftHeld = false;
  private rightHeld = false;
  // 이산 적립
  private qCW = false;
  private qCCW = false;
  private q180 = false;
  private qHard = false;
  private qHold = false;
  onRetry?: () => void;
  onPause?: () => void;
  onUndo?: () => void;

  constructor(game: Game, keymap: KeyMap = DEFAULT_KEYMAP) {
    this.game = game;
    this.keymap = keymap;
    this.rebuild();
  }

  setGame(game: Game): void {
    this.game = game;
    this.reset();
  }

  setKeymap(km: KeyMap): void {
    this.keymap = km;
    this.rebuild();
  }

  private rebuild(): void {
    this.lookup.clear();
    (Object.keys(this.keymap) as Action[]).forEach((action) => {
      for (const code of this.keymap[action]) this.lookup.set(code, action);
    });
  }

  reset(): void {
    this.softHeld = this.leftHeld = this.rightHeld = false;
    this.qCW = this.qCCW = this.q180 = this.qHard = this.qHold = false;
  }

  attach(target: Window | HTMLElement = window): void {
    target.addEventListener("keydown", this.onKeyDown as EventListener);
    target.addEventListener("keyup", this.onKeyUp as EventListener);
    window.addEventListener("blur", this.onBlur);
  }

  detach(target: Window | HTMLElement = window): void {
    target.removeEventListener("keydown", this.onKeyDown as EventListener);
    target.removeEventListener("keyup", this.onKeyUp as EventListener);
    window.removeEventListener("blur", this.onBlur);
  }

  private onBlur = (): void => {
    // 포커스 잃으면 모든 키 해제(끼임 방지)
    if (this.leftHeld) this.game.releaseDir(-1);
    if (this.rightHeld) this.game.releaseDir(1);
    this.reset();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Ctrl+Z / Cmd+Z → 되돌리기 (rotateCCW보다 우선)
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
      e.preventDefault();
      if (!e.repeat) this.onUndo?.();
      return;
    }
    const action = this.lookup.get(e.code);
    if (!action) return;
    e.preventDefault();
    // 하드드롭: safelock ON이면 오토리피트 무시(홀드 시 1회만), OFF면 리피트 허용.
    // keyup 의존 게이트를 쓰지 않아 키업 누락으로 인한 입력 씹힘이 없음.
    if (action === "hardDrop") {
      if (e.repeat && this.game.handling.h.safelock) return;
      this.qHard = true;
      return;
    }
    if (e.repeat) return; // 그 외 액션은 OS 오토리피트 무시

    switch (action) {
      case "moveLeft":
        this.leftHeld = true;
        this.game.pressDir(-1);
        break;
      case "moveRight":
        this.rightHeld = true;
        this.game.pressDir(1);
        break;
      case "softDrop":
        this.softHeld = true;
        break;
      case "rotateCW":
        this.qCW = true;
        break;
      case "rotateCCW":
        this.qCCW = true;
        break;
      case "rotate180":
        this.q180 = true;
        break;
      case "hold":
        this.qHold = true;
        break;
      case "retry":
        this.onRetry?.();
        break;
      case "pause":
        // 실제 pause/resume은 상위(React)가 단일 소스로 처리 — 여기선 통지만
        this.onPause?.();
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const action = this.lookup.get(e.code);
    if (!action) return;
    e.preventDefault();
    switch (action) {
      case "moveLeft":
        this.leftHeld = false;
        this.game.releaseDir(-1);
        break;
      case "moveRight":
        this.rightHeld = false;
        this.game.releaseDir(1);
        break;
      case "softDrop":
        this.softHeld = false;
        break;
    }
  };

  /** 한 시뮬 배치의 입력 명령 반환 + 이산 플래그 소비 */
  poll(): InputCommands {
    const cmd: InputCommands = {
      rotateCW: this.qCW,
      rotateCCW: this.qCCW,
      rotate180: this.q180,
      hardDrop: this.qHard,
      hold: this.qHold,
      softDropHeld: this.softHeld,
    };
    this.qCW = this.qCCW = this.q180 = this.qHard = this.qHold = false;
    return cmd;
  }
}
