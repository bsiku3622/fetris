import { Game, Phase } from "./game";
import type { GameModeName, RuleSet } from "./types";
import { BlitzScore } from "./scoring";
import { defaultRuleset } from "./config";

// ============================================================================
// 게임 모드 — 40 LINES / BLITZ / ZEN / MARATHON / CUSTOM.
// Mode는 룰을 제공하고, 진행/완료/HUD를 관리한다.
// ============================================================================

export interface StatItem {
  label: string;
  value: string; // 큰 글자(주 수치)
  sub?: string; // 큰 값 옆 작은 글자(보조: PPS, APM, /40, .ms 등)
}

/** 테트리오식 사이드 통계 — 좌측/우측 컬럼 하단에 큼직하게 표시 */
export interface HudInfo {
  left: StatItem[]; // 좌측 스택(HOLD 컬럼 하단)
  right: StatItem[]; // 우측 스택(NEXT 컬럼 하단), 모드에 따라 0개
}

export interface ModeResult {
  completed: boolean;
  timeMs: number;
  lines: number;
  score: number;
  pps: number;
  metricLabel: string;
  metricValue: string;
}

export class Mode {
  name: GameModeName;
  rule: RuleSet;
  blitz: BlitzScore | null = null;
  private goalLines = 0;
  private timeLimitFrames = 0;

  constructor(name: GameModeName, ruleOverride?: Partial<RuleSet>) {
    this.name = name;
    this.rule = { ...defaultRuleset(name), ...ruleOverride };
    if (name === "sprint") this.goalLines = 40;
    if (name === "blitz") {
      this.timeLimitFrames = 120 * 60; // 2분
      this.blitz = new BlitzScore();
    }
  }

  private comboRng = 0x9e3779b9;
  private nextHole(cols: number): number {
    this.comboRng = (this.comboRng * 1664525 + 1013904223) >>> 0;
    return this.comboRng % cols;
  }

  /** COMBO 모드: 바닥에 비어있지 않은 행이 target개 미만이면 가비지로 보충(구멍 랜덤). */
  private maintainComboGarbage(game: Game, target = 3): void {
    const b = game.board;
    let filled = 0;
    for (let y = 0; y < b.totalRows; y++) {
      let any = false;
      for (let x = 0; x < b.cols; x++) {
        if (b.grid[y * b.cols + x]) {
          any = true;
          break;
        }
      }
      if (any) filled++;
    }
    for (let i = filled; i < target; i++) b.addGarbage(1, this.nextHole(b.cols));
  }

  setup(game: Game): void {
    this.blitz?.reset();
    if (this.name === "combo") this.maintainComboGarbage(game, 1);
  }

  /** 매 시뮬 틱 — 중력/레벨/시간 처리 */
  update(game: Game, _dtFrames: number): void {
    if (this.name === "blitz" && this.blitz) {
      game.gravityOverride = this.blitz.gravity();
    }
    if (this.name === "marathon") {
      // 라인 수에 따라 점진적 중력 상승
      const lvl = Math.floor(game.stats.lines / 10);
      game.gravityOverride = Math.min(20, 0.02 * Math.pow(1.25, lvl));
    }
  }

  /** 라인클리어 이벤트 처리(블리츠 점수) */
  onClear(game: Game, lines: number, spin: number, b2b: boolean, combo: number): void {
    if (this.blitz) {
      this.blitz.add(lines, spin, b2b, combo);
      game.stats.score = this.blitz.score;
    }
    // COMBO 모드: 클리어로 줄어들면 가비지를 보충해 항상 1줄 유지
    if (this.name === "combo") this.maintainComboGarbage(game, 1);
  }

  isComplete(game: Game): boolean {
    if (game.isGameOver()) return true;
    if (this.name === "sprint") return game.stats.lines >= this.goalLines;
    if (this.name === "blitz") return game.stats.frame >= this.timeLimitFrames;
    return false;
  }

  /** 경과 시간 — 프레임 기반(결정론적, 일시정지/게임오버 시 자연히 멈춤) */
  private elapsedMs(game: Game, _now: number): number {
    return (game.stats.frame / 60) * 1000;
  }

  hud(game: Game, now: number): HudInfo {
    const s = game.stats;
    const sec = s.frame / 60;
    const pps = sec > 0 ? s.piecesPlaced / sec : 0;
    const apm = sec > 0 ? s.attack / (sec / 60) : 0;
    const elapsed = this.elapsedMs(game, now);

    // 큰 수치 + 작은 보조(테트리오식): 피스수+PPS, 보낸줄+APM
    const pieces: StatItem = { label: "PIECES", value: String(s.piecesPlaced), sub: `, ${pps.toFixed(2)}/S` };
    const attackItem: StatItem = { label: "ATTACK", value: String(s.attack), sub: `, ${apm.toFixed(0)}/M` };
    const t = splitTime(elapsed);
    const timeItem: StatItem = { label: "TIME", value: t.value, sub: t.sub };

    if (this.name === "sprint") {
      return {
        left: [{ label: "LINES", value: String(s.lines), sub: `/${this.goalLines}` }, pieces, attackItem, timeItem],
        right: [{ label: "FINESSE", value: String(s.finesseFaults) }],
      };
    }
    if (this.name === "blitz") {
      const remain = Math.max(0, this.timeLimitFrames - s.frame) / 60;
      const rt = splitTime(remain * 1000);
      return {
        left: [{ label: "LEVEL", value: String(this.blitz?.level ?? 1) }, pieces, attackItem, { label: "TIME", value: rt.value, sub: rt.sub }],
        right: [{ label: "SCORE", value: s.score.toLocaleString() }],
      };
    }
    if (this.name === "marathon" || this.name === "custom") {
      const level = Math.floor(s.lines / 10) + 1;
      return {
        left: [{ label: "LEVEL", value: String(level) }, pieces, attackItem, timeItem],
        right: [{ label: "SCORE", value: s.score.toLocaleString() }],
      };
    }
    // zen / fourwide / combo — 우측 없음
    return {
      left: [{ label: "LINES", value: String(s.lines) }, pieces, attackItem, timeItem],
      right: [],
    };
  }

  result(game: Game, now: number): ModeResult {
    const timeMs = this.elapsedMs(game, now);
    const pps = game.stats.frame > 0 ? game.stats.piecesPlaced / (game.stats.frame / 60) : 0;
    let metricLabel = "SCORE";
    let metricValue = game.stats.score.toLocaleString();
    if (this.name === "sprint") {
      metricLabel = "TIME";
      metricValue = fmtTime(timeMs);
    }
    return {
      completed: !game.isGameOver(),
      timeMs,
      lines: game.stats.lines,
      score: game.stats.score,
      pps,
      metricLabel,
      metricValue,
    };
  }
}

/** 시간을 큰 부분(M:SS 또는 S)과 작은 부분(.mmm)으로 분리 — HUD 표시용 */
export function splitTime(ms: number): { value: string; sub: string } {
  if (ms < 0) ms = 0;
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const mil = Math.floor(ms % 1000);
  const value = m > 0 ? `${m}:${String(s).padStart(2, "0")}` : String(s);
  return { value, sub: `.${String(mil).padStart(3, "0")}` };
}

export function fmtTime(ms: number): string {
  if (ms < 0) ms = 0;
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total * 100) % 100);
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  return `${s}.${String(cs).padStart(2, "0")}`;
}

export { Phase };
