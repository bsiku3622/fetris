import { Game, Phase, EventType } from "../engine/game";
import type { GameEvent } from "../engine/game";
import { GameLoop } from "../engine/loop";
import type { LoopPerfOptions } from "../engine/loop";
import { Renderer } from "../render/renderer";
import type { GfxOptions } from "../render/renderer";
import { ParticleSystem, ActionTextManager, DamageNumberManager } from "../render/effects";
import { FUNKY, PIECE_COLORS } from "../render/theme";
import { SoundEngine, bgmForMode } from "../audio/sound";
import type { AudioOptions } from "../audio/sound";
import { InputManager } from "../engine/input";
import type { KeyMap } from "../engine/input";
import { Mode } from "../engine/modes";
import { saveZenState, loadZenState, clearZenState } from "./store";
import type { HudInfo, ModeResult } from "../engine/modes";
import type { Handling, GameModeName, RuleSet } from "../engine/types";
import { SpinType, Piece } from "../engine/types";

// ============================================================================
// GameSession — React 밖에서 게임 1판을 구동하는 컨트롤러.
// 루프/렌더/사운드/입력/모드를 통합. HUD는 콜백으로 React에 전달(리렌더 최소).
// ============================================================================

export interface SessionCallbacks {
  onHud?: (hud: HudInfo, fps: number) => void;
  onEnd?: (result: ModeResult) => void;
  onPauseToggle?: () => void;
}

export interface SessionOptions {
  rule: RuleSet;
  handling: Handling;
  keymap: KeyMap;
  gfx: GfxOptions;
  audio: AudioOptions;
  perf: LoopPerfOptions;
  seed: number;
}

export class GameSession {
  game: Game;
  mode: Mode;
  private renderer: Renderer;
  private particles = new ParticleSystem();
  private actionText = new ActionTextManager();
  private damage = new DamageNumberManager();
  private lastB2b = 0;
  private spikeValue = 0; // 콤보 동안 누적되는 스파이크
  sound: SoundEngine;
  private input: InputManager;
  private loop: GameLoop;
  private gfx: GfxOptions;
  private cbs: SessionCallbacks;
  private shakeMag = 0;
  private ended = false;
  private hudAccum = 0;
  private lastHud: HudInfo = { left: [], right: [] };
  private playedReady = false;
  private playedGo = false;
  private spinThisPiece = false;

  constructor(canvas: HTMLCanvasElement, modeName: GameModeName, opts: SessionOptions, cbs: SessionCallbacks = {}) {
    this.cbs = cbs;
    this.gfx = opts.gfx;
    this.mode = new Mode(modeName, opts.rule);
    this.game = new Game(this.mode.rule, opts.handling, opts.seed);
    const zenLike = modeName === "zen" || modeName === "fourwide" || modeName === "combo";
    this.game.undoEnabled = modeName === "zen" || modeName === "fourwide"; // Combo는 되돌리기 비활성(가비지 보충 일관성)
    this.game.topOutResets = zenLike; // 막히면 게임오버 대신 필드 리셋
    this.mode.setup(this.game);
    if (modeName === "zen") this.restoreZen();
    this.renderer = new Renderer(canvas);
    this.renderer.resize();
    this.particles.intensity = opts.gfx.particles;
    this.sound = new SoundEngine(opts.audio);
    this.input = new InputManager(this.game, opts.keymap);
    this.input.onRetry = () => this.retry();
    this.input.onPause = () => cbs.onPauseToggle?.();
    this.input.onUndo = () => {
      if (this.game.undo()) {
        this.sound.play("hold");
        this.actionText.push("UNDO", FUNKY.sky, 0.85);
      }
    };
    this.loop = new GameLoop(this.game, opts.perf, {
      pollInput: () => this.input.poll(),
      render: (g, alpha, fps) => this.onRender(g, alpha, fps),
    });
  }

  start(): void {
    this.input.attach();
    this.sound.ensure();
    this.sound.startMusic(bgmForMode(this.mode.name));
    this.loop.start();
  }

  destroy(): void {
    this.saveZen(); // Zen 이어하기 저장
    this.loop.stop();
    this.input.detach();
    this.sound.dispose();
  }

  /** Zen 복원 (보드+현재피스+넥스트큐+홀드+B2B+통계 전체) */
  private restoreZen(): void {
    const z = loadZenState();
    if (z) this.game.deserialize(z);
  }

  /** Zen 저장 (전체 스냅샷) */
  private saveZen(): void {
    if (this.mode.name !== "zen") return;
    saveZenState(this.game.serialize());
  }

  retry(): void {
    this.ended = false;
    this.playedReady = false;
    this.playedGo = false;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.game.reset(seed);
    this.mode.setup(this.game);
    this.particles.clear();
    this.actionText.clear();
    this.damage.clear();
    this.lastB2b = 0;
    this.spikeValue = 0;
    if (this.mode.name === "zen") clearZenState(); // 다시하기 시 Zen 저장 초기화
    this.sound.resetCombo();
    this.renderer.flash = 0;
    this.shakeMag = 0;
  }

  pause(): void {
    this.game.pause();
  }
  resume(): void {
    this.game.resume();
  }

  resize(): void {
    this.renderer.resize();
  }

  setGfx(gfx: GfxOptions): void {
    this.gfx = gfx;
  }
  setAudio(a: Partial<AudioOptions>): void {
    this.sound.setOptions(a);
  }
  setPerf(p: Partial<LoopPerfOptions>): void {
    this.loop.setOptions(p);
  }
  setHandling(h: Handling): void {
    this.game.setHandling(h);
  }
  setKeymap(km: KeyMap): void {
    this.input.setKeymap(km);
  }

  private onRender(game: Game, alpha: number, fps: number): void {
    // READY / GO 사운드
    const rt = game.readyTimer;
    if (rt >= 0) {
      if (!this.playedReady) {
        this.sound.play("ready");
        this.playedReady = true;
      }
      if (rt <= 20 && !this.playedGo) {
        this.sound.play("go");
        this.playedGo = true;
      }
    }

    // 모드 업데이트(중력/레벨) — 시뮬 외부지만 다음 틱에 반영됨
    this.mode.update(game, 1);

    // 이벤트 드레인 → 사운드/이펙트
    this.drainEvents(game.events);
    game.events.length = 0;

    // shake/flash 감쇠 (대략 프레임당)
    const decay = 0.82;
    this.shakeMag *= decay;
    if (this.shakeMag < 0.05) this.shakeMag = 0;
    const sm = this.shakeMag * this.gfx.screenShake * 2; // 흔들림 강도 1/4로 완화(과한 흔들림 방지)
    this.renderer.shakeX = (Math.random() - 0.5) * sm;
    this.renderer.shakeY = (Math.random() - 0.5) * sm;
    this.renderer.flash *= 0.85;
    if (this.renderer.flash < 0.02) this.renderer.flash = 0;
    // 화려한 연출 감쇠
    const r = this.renderer;
    r.framePulse *= 0.86;
    if (r.framePulse < 0.02) r.framePulse = 0;

    this.particles.intensity = this.gfx.particles;
    this.particles.update(1 / 60);
    this.actionText.update(1 / 60);
    this.damage.update(1 / 60);

    // HUD 갱신 (약 20Hz로 throttle — 매 프레임 문자열 할당 방지). 캔버스/콜백 공용.
    this.hudAccum++;
    if (this.hudAccum >= 3) {
      this.hudAccum = 0;
      this.lastHud = this.mode.hud(game, performance.now());
      this.cbs.onHud?.(this.lastHud, fps);
    }

    this.renderer.render(game, alpha, this.gfx, this.particles, this.actionText, this.damage, this.lastHud);

    // 종료 판정
    if (!this.ended && this.mode.isComplete(game)) {
      this.ended = true;
      // 사망음은 TopOut 이벤트에서 death()로 재생됨(중복 방지)
      const now = performance.now();
      this.cbs.onEnd?.(this.mode.result(game, now));
    }
  }

  private drainEvents(events: GameEvent[]): void {
    const b = this.game.board;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case EventType.Move:
          this.sound.play("move");
          break;
        case EventType.Rotate:
          this.sound.play("rotate");
          break;
        case EventType.Hit:
          // 벽 충돌은 소리 절제(과하면 거슬림)
          break;
        case EventType.Hold:
          this.sound.play("hold");
          break;
        case EventType.HardDrop: {
          this.sound.play("harddrop");
          this.shakeMag = Math.max(this.shakeMag, 0.7 + Math.min(1.4, (e.a ?? 0) / 14));
          // 피스 가로 중심에서 분출(왼쪽 편향 제거) — 트레일 범위 [minX, maxX+1] 중심
          const dropCx = e.cells && e.cells.length === 2 ? (e.cells[0] + e.cells[1]) / 2 : this.game.px + 1.5;
          this.particles.hardDropDust(dropCx, this.game.ghostY(), 1, b.bufferRows, "#9a937a");
          break;
        }
        case EventType.SoftLock:
          // (락 플래시 제거 — 정신사나움)
          // 스핀 없이 놓으면 스핀 음정 리셋
          if (!this.spinThisPiece) this.sound.resetSpin();
          this.spinThisPiece = false;
          // 콤보 끊김 → 스파이크 누적 초기화(표시는 자연 페이드)
          if (this.game.scoring.combo === 0) this.spikeValue = 0;
          this.saveZen(); // Zen 이어하기 — 매 락마다 저장
          break;
        case EventType.SpinDetect: {
          // 회전으로 스핀이 성립한 순간 — 즉시 맛있는 사운드(연속 시 상승)
          this.spinThisPiece = true;
          this.sound.spinHit((e.piece ?? Piece.T) === Piece.T);
          const dp = e.piece ?? Piece.T;
          this.particles.spinSparkle(this.game.px + 1.5, this.game.py + 1.5, b.bufferRows, dp === Piece.T ? FUNKY.purple : PIECE_COLORS[dp]);
          break;
        }
        case EventType.Spin: {
          // 락 시점 — 텍스트만(사운드는 SpinDetect에서 이미 울림)
          const sp = e.piece ?? Piece.T;
          if ((e.a ?? 0) === 0) {
            const mini = e.spin === SpinType.Mini ? " MINI" : "";
            const label = sp === Piece.T ? `T-SPIN${mini}` : `${pieceLetter(sp)} SPIN`;
            this.actionText.push(label, sp === Piece.T ? FUNKY.purple : PIECE_COLORS[sp], 0.85);
          }
          break;
        }
        case EventType.LineClear: {
          const n = e.a ?? 0;
          const spin = e.spin ?? SpinType.None;
          // 사운드: 종류별 베이스(clearline/clearquad/clearspin/clearbtb) + 콤보 상승 톤
          this.sound.clear(n, spin !== SpinType.None, (e.clear?.b2b ?? 0) > 1, e.clear?.combo ?? 1);
          // 이펙트
          this.renderer.flash = Math.min(1, 0.4 + n * 0.15);
          this.renderer.framePulse = Math.min(1, 0.5 + n * 0.18);
          this.shakeMag = Math.max(this.shakeMag, 0.3 + n * 0.18);
          // 액션 텍스트: 메인 클리어 이름 + B2B + 콤보
          const piece = e.piece ?? Piece.T;
          if (e.clear) {
            // 클리어한 미노 중심에서 분출
            const cc = e.cells ?? [b.cols / 2, b.bufferRows + b.rows - 1];
            const pcol = piece === Piece.T ? FUNKY.purple : PIECE_COLORS[piece];
            this.particles.lineClear(cc[0], cc[1] ?? b.bufferRows + b.rows - 1, b.bufferRows, pcol, n);
          }
          const main = clearName(n, spin, piece);
          if (main) {
            const big = n >= 4 || spin !== SpinType.None ? 1.05 : 0.9;
            this.actionText.push(main, clearColor(n, spin, piece), big);
          }
          const b2b = e.clear?.b2b ?? 0;
          if (e.clear?.b2bEligible && b2b > 1) this.actionText.push(`B2B ×${b2b}`, FUNKY.yellow, 0.8);
          const comboCount = e.clear?.combo ?? 1;
          if (comboCount >= 2) this.actionText.push(`${comboCount} COMBO`, FUNKY.green, 0.8);

          // 공격 스파이크 — 콤보 동안 누적(이전 스파이크 + 지금 공격), 단일 숫자
          const attack = e.clear?.attack ?? 0;
          const surge = e.clear?.surge ?? 0;
          const chainCombo = e.clear?.combo ?? 1;
          if (attack > 0) {
            // 콤보 시작(combo<=1)이면 새로, 이어지면 누적
            this.spikeValue = chainCombo <= 1 ? attack : this.spikeValue + attack;
            // 놓은 미노 중심 컬럼(보드 좌표)
            const cc = e.cells ?? [b.cols / 2];
            this.damage.show(this.spikeValue, cc[0]);
            this.sound.spike(attack);
            this.shakeMag = Math.max(this.shakeMag, Math.min(1.5, 0.3 + attack * 0.12));
          }
          // 서지 발사 (B2B 끊기며 대량 방출) — 쾅!
          if (surge > 0) {
            this.sound.surgeRelease();
            this.actionText.push(`SURGE ×${surge}`, FUNKY.danger, 1.3, 1.6);
            this.renderer.flash = 1;
            this.shakeMag = 1.6;
          } else if (this.lastB2b >= 1 && b2b === 0 && n > 0) {
            // B2B 끊김(서지 없이) — 띠딕 사운드
            this.sound.b2bBreak();
          }
          this.lastB2b = b2b;

          // 모드(블리츠 점수)
          const combo = comboCount - 1;
          this.mode.onClear(this.game, n, spin, b2b > 1, combo);
          break;
        }
        // 콤보 사운드는 LineClear에서 콤보 수 기반으로 재생(중복 방지). Combo 이벤트는 사운드 없음.
        case EventType.B2B:
          this.sound.play("b2b");
          break;
        case EventType.PerfectClear: {
          this.sound.play("pc");
          // 화려한 다색 파티클 분수(원형 충격파 제거)
          const palette = [Piece.I, Piece.O, Piece.T, Piece.S, Piece.Z, Piece.J, Piece.L].map((p) => PIECE_COLORS[p]);
          this.particles.celebrate(b.cols, b.rows, palette);
          this.renderer.flash = 1;
          this.renderer.framePulse = 1; // 네온 프레임 번쩍
          this.shakeMag = 1.4;
          this.actionText.push("PERFECT CLEAR", FUNKY.pink, 1.35, 2.0);
          break;
        }
        case EventType.TopOut:
          this.sound.death(); // 사망/리셋 — 큰 폭발음
          this.renderer.flash = 1;
          this.shakeMag = 1.6;
          if (this.game.topOutResets) {
            // Zen/4-Wide/Combo: 필드 리셋 → 저장도 초기화
            this.actionText.push("RESET", FUNKY.sky, 1.1, 1.2);
            this.particles.clear();
            this.damage.clear();
            this.lastB2b = 0;
            clearZenState();
            // Combo 모드: 필드가 비워졌으니 가비지 3줄 재보충
            if (this.mode.name === "combo") this.mode.setup(this.game);
          }
          break;
      }
    }
  }

  isPaused(): boolean {
    return this.game.phase === Phase.Paused;
  }
}

// ---- 액션 텍스트 헬퍼 ----
const LINE_NAMES = ["", "SINGLE", "DOUBLE", "TRIPLE", "QUAD"];

function pieceLetter(p: Piece): string {
  return ["", "I", "J", "L", "O", "S", "T", "Z", "G"][p] ?? "?";
}

function clearName(lines: number, spin: SpinType, piece: Piece): string {
  const ln = LINE_NAMES[lines] ?? `${lines}-LINE`;
  if (spin === SpinType.None) return ln;
  if (piece === Piece.T) {
    // T-스핀
    return spin === SpinType.Mini ? `T-SPIN MINI ${ln}` : `T-SPIN ${ln}`;
  }
  // 올스핀 (T 외)
  return `${pieceLetter(piece)} SPIN ${ln}`;
}

function clearColor(lines: number, spin: SpinType, piece: Piece): string {
  if (spin !== SpinType.None) return piece === Piece.T ? FUNKY.purple : PIECE_COLORS[piece];
  if (lines >= 4) return FUNKY.pink;
  if (lines === 3) return FUNKY.orange;
  if (lines === 2) return FUNKY.sky;
  return FUNKY.inkMuted;
}
