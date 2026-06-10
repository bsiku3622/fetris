import { Game, EventType } from "../engine/game";
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
import { VersusMatch } from "./VersusMatch";
import type { MatchResult } from "./VersusMatch";
import type { MultiTransport } from "../net/transport";
import { Side } from "../net/protocol";
import type { Handling, RuleSet } from "../engine/types";
import { SpinType, Piece } from "../engine/types";

// ============================================================================
// VersusSession — 1대1 대전을 구동하는 UI 컨트롤러(GameSession의 대전판).
//  - 로컬 보드: 입력/이펙트/사운드 포함 풀 렌더.
//  - 원격 보드: 네트워크 스냅샷 미러를 별도 캔버스에 단순 렌더(이펙트 없음).
//  - 시뮬 스텝은 VersusMatch.tick으로 위임(공격 송수신·스냅샷 동기화 포함).
// ============================================================================

export interface VersusCallbacks {
  onResult?: (result: MatchResult) => void;
  onFps?: (fps: number) => void;
}

export interface VersusSessionOptions {
  rule: RuleSet;
  handling: Handling;
  keymap: KeyMap;
  gfx: GfxOptions;
  audio: AudioOptions;
  perf: LoopPerfOptions;
  seed: number;
  myAttackMul: number;
  side: Side;
  transport: MultiTransport;
  /** 교육 모드: Ctrl+Z 되돌리기 허용 */
  undoEnabled: boolean;
}

export class VersusSession {
  readonly match: VersusMatch;
  private localRenderer: Renderer;
  /** playerId → Renderer. 대전 시작 시 roster의 모든 상대 canvas를 등록. */
  private remoteRenderers = new Map<string, Renderer>();
  /** playerId → canvas (아직 board 스냅샷이 안 온 상대도 등록해 둠) */
  private remoteCanvases: Map<string, HTMLCanvasElement>;
  private particles = new ParticleSystem();
  private actionText = new ActionTextManager();
  private damage = new DamageNumberManager();
  private sound: SoundEngine;
  private input: InputManager;
  private loop: GameLoop;
  private gfx: GfxOptions;
  private cbs: VersusCallbacks;
  private shakeMag = 0;
  private spikeValue = 0;
  private lastB2b = 0;
  private spinThisPiece = false;
  private dangerBeepAccum = 0.6; // 위험 경고음 누적(진입 시 즉시 울리도록 초기값 충전)

  constructor(
    localCanvas: HTMLCanvasElement,
    remoteCanvases: Map<string, HTMLCanvasElement>,
    opts: VersusSessionOptions,
    cbs: VersusCallbacks = {},
  ) {
    this.cbs = cbs;
    this.gfx = opts.gfx;
    this.remoteCanvases = new Map(remoteCanvases);
    this.match = new VersusMatch({
      rule: opts.rule,
      handling: opts.handling,
      seed: opts.seed,
      myAttackMul: opts.myAttackMul,
      side: opts.side,
      transport: opts.transport,
    });
    this.match.local.undoEnabled = opts.undoEnabled;
    this.match.onLocalEvents = (events) => this.drainEvents(events);
    this.match.onResult = (r) => this.cbs.onResult?.(r);
    // 새 플레이어가 board 스냅샷을 보내면 해당 canvas에 렌더러 바인딩
    this.match.onPlayerAdded = (playerId) => {
      this.bindRemoteRenderer(playerId);
    };
    this.match.onPlayerRemoved = (playerId) => {
      this.remoteRenderers.delete(playerId);
    };

    this.localRenderer = new Renderer(localCanvas);
    this.localRenderer.resize();
    // 알려진 roster 상대 canvas를 미리 렌더러로 등록
    for (const id of this.remoteCanvases.keys()) this.bindRemoteRenderer(id);
    this.particles.intensity = opts.gfx.particles;
    this.sound = new SoundEngine(opts.audio);

    this.input = new InputManager(this.match.local, opts.keymap);
    this.input.onUndo = () => {
      if (this.match.local.undo()) {
        this.sound.play("hold");
        this.actionText.push("UNDO", FUNKY.sky, 0.85);
      }
    };

    this.loop = new GameLoop(this.match.local, opts.perf, {
      pollInput: () => this.input.poll(),
      render: (g, alpha, fps) => this.onRender(g, alpha, fps),
      stepGame: (dt, cmd, t) => this.match.tick(dt, cmd, t),
    });
  }

  start(): void {
    this.input.attach();
    this.sound.ensure();
    this.sound.startMusic(bgmForMode("custom"));
    this.loop.start();
  }

  destroy(): void {
    this.loop.stop();
    this.input.detach();
    this.sound.dispose();
    this.match.dispose();
  }

  resize(): void {
    this.localRenderer.resize();
    for (const r of this.remoteRenderers.values()) r.resize();
  }

  /** playerId에 등록된 canvas가 있으면 Renderer를 만들어 바인딩(중복 방지). */
  private bindRemoteRenderer(playerId: string): void {
    if (this.remoteRenderers.has(playerId)) return;
    const canvas = this.remoteCanvases.get(playerId);
    if (!canvas) return;
    const renderer = new Renderer(canvas);
    renderer.resize();
    this.remoteRenderers.set(playerId, renderer);
  }

  /** N인 대전: 상대 canvas를 동적으로 등록(roster 변경 시). */
  addRemoteCanvas(playerId: string, canvas: HTMLCanvasElement): void {
    this.remoteCanvases.set(playerId, canvas);
    this.bindRemoteRenderer(playerId);
  }

  setGfx(gfx: GfxOptions): void {
    this.gfx = gfx;
  }

  private onRender(localGame: Game, alpha: number, fps: number): void {
    // shake/flash 감쇠
    this.shakeMag *= 0.82;
    if (this.shakeMag < 0.05) this.shakeMag = 0;
    const sm = this.shakeMag * this.gfx.screenShake * 2;
    this.localRenderer.shakeX = (Math.random() - 0.5) * sm;
    this.localRenderer.shakeY = (Math.random() - 0.5) * sm;
    this.localRenderer.flash *= 0.85;
    if (this.localRenderer.flash < 0.02) this.localRenderer.flash = 0;
    this.localRenderer.framePulse *= 0.86;
    if (this.localRenderer.framePulse < 0.02) this.localRenderer.framePulse = 0;

    this.particles.intensity = this.gfx.particles;
    this.particles.update(1 / 60);
    this.actionText.update(1 / 60);
    this.damage.update(1 / 60);

    // 로컬: 풀 렌더(이펙트 + 가비지 게이지 포함)
    this.localRenderer.render(localGame, alpha, this.gfx, this.particles, this.actionText, this.damage, undefined, localGame.pendingGarbage);
    // 원격: 각 상대 미러 단순 렌더(이펙트 없음, 게이지는 표시)
    for (const [playerId, renderer] of this.remoteRenderers) {
      const remoteGame = this.match.remotes.get(playerId);
      if (remoteGame) renderer.render(remoteGame, 0, this.gfx, undefined, undefined, undefined, undefined, remoteGame.pendingGarbage);
    }

    // 위험 경고음 — 스택이 천장 근처면 주기적으로 삐
    const b = localGame.board;
    const inDanger = !localGame.isGameOver() && b.highestRow() < b.bufferRows + b.rows * 0.2;
    if (inDanger) {
      this.dangerBeepAccum += 1 / 60;
      if (this.dangerBeepAccum >= 0.55) {
        this.dangerBeepAccum = 0;
        this.sound.dangerBeep();
      }
    } else {
      this.dangerBeepAccum = 0.55; // 다음 진입 시 즉시 울림
    }

    this.cbs.onFps?.(fps);
  }

  /** 로컬 게임 이벤트 → 사운드/이펙트(GameSession과 동일 결의 축약판) */
  private drainEvents(events: GameEvent[]): void {
    const g = this.match.local;
    const b = g.board;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case EventType.Move:
          this.sound.play("move");
          break;
        case EventType.Rotate:
          this.sound.play("rotate");
          break;
        case EventType.Hold:
          this.sound.play("hold");
          break;
        case EventType.HardDrop: {
          this.sound.play("harddrop");
          this.shakeMag = Math.max(this.shakeMag, 0.7 + Math.min(1.4, (e.a ?? 0) / 14));
          const cx = e.cells && e.cells.length === 2 ? (e.cells[0] + e.cells[1]) / 2 : g.px + 1.5;
          this.particles.hardDropDust(cx, g.ghostY(), 1, b.bufferRows, "#9a937a");
          break;
        }
        case EventType.SpinDetect: {
          this.spinThisPiece = true;
          this.sound.spinHit((e.piece ?? Piece.T) === Piece.T);
          const dp = e.piece ?? Piece.T;
          this.particles.spinSparkle(g.px + 1.5, g.py + 1.5, b.bufferRows, dp === Piece.T ? FUNKY.purple : PIECE_COLORS[dp]);
          break;
        }
        case EventType.Spin: {
          const sp = e.piece ?? Piece.T;
          if ((e.a ?? 0) === 0) {
            const mini = e.spin === SpinType.Mini ? " MINI" : "";
            const label = sp === Piece.T ? `T-SPIN${mini}` : `${pieceLetter(sp)} SPIN`;
            this.actionText.push(label, sp === Piece.T ? FUNKY.purple : PIECE_COLORS[sp], 0.85);
          }
          break;
        }
        case EventType.SoftLock:
          if (!this.spinThisPiece) this.sound.resetSpin();
          this.spinThisPiece = false;
          if (g.scoring.combo === 0) this.spikeValue = 0;
          break;
        case EventType.LineClear: {
          const n = e.a ?? 0;
          const spin = e.spin ?? SpinType.None;
          this.sound.clear(n, spin !== SpinType.None, (e.clear?.b2b ?? 0) > 1, e.clear?.combo ?? 1);
          this.localRenderer.flash = Math.min(1, 0.4 + n * 0.15);
          this.localRenderer.framePulse = Math.min(1, 0.5 + n * 0.18);
          this.shakeMag = Math.max(this.shakeMag, 0.3 + n * 0.18);
          const piece = e.piece ?? Piece.T;
          if (e.clear) {
            const cc = e.cells ?? [b.cols / 2, b.bufferRows + b.rows - 1];
            const pcol = piece === Piece.T ? FUNKY.purple : PIECE_COLORS[piece];
            this.particles.lineClear(cc[0], cc[1] ?? b.bufferRows + b.rows - 1, b.bufferRows, pcol, n);
          }
          const main = clearName(n, spin, piece);
          if (main) this.actionText.push(main, clearColor(n, spin, piece), n >= 4 || spin !== SpinType.None ? 1.05 : 0.9);
          const b2b = e.clear?.b2b ?? 0;
          if (e.clear?.b2bEligible && b2b > 1) this.actionText.push(`B2B ×${b2b}`, FUNKY.yellow, 0.8);
          const comboCount = e.clear?.combo ?? 1;
          if (comboCount >= 2) this.actionText.push(`${comboCount} COMBO`, FUNKY.green, 0.8);
          const attack = e.clear?.attack ?? 0;
          const surge = e.clear?.surge ?? 0;
          if (attack > 0) {
            this.spikeValue = comboCount <= 1 ? attack : this.spikeValue + attack;
            const cc = e.cells ?? [b.cols / 2];
            this.damage.show(this.spikeValue, cc[0]);
            this.sound.spike(attack);
            this.shakeMag = Math.max(this.shakeMag, Math.min(1.5, 0.3 + attack * 0.12));
          }
          if (surge > 0) {
            this.sound.surgeRelease();
            this.actionText.push(`SURGE ×${surge}`, FUNKY.danger, 1.3, 1.6);
            this.localRenderer.flash = 1;
            this.shakeMag = 1.6;
          } else if (this.lastB2b >= 1 && b2b === 0 && n > 0) {
            this.sound.b2bBreak();
          }
          this.lastB2b = b2b;
          break;
        }
        case EventType.B2B:
          this.sound.play("b2b");
          break;
        case EventType.PerfectClear: {
          this.sound.play("pc");
          const palette = [Piece.I, Piece.O, Piece.T, Piece.S, Piece.Z, Piece.J, Piece.L].map((p) => PIECE_COLORS[p]);
          this.particles.celebrate(b.cols, b.rows, palette);
          this.localRenderer.flash = 1;
          this.localRenderer.framePulse = 1;
          this.shakeMag = 1.4;
          this.actionText.push("PERFECT CLEAR", FUNKY.pink, 1.35, 2.0);
          break;
        }
        case EventType.GarbageIn: {
          // 가비지가 바닥에서 솟음 — 줄 수만큼 "텅텅" + 묵직한 흔들림
          this.sound.garbageRise(e.a ?? 0);
          this.shakeMag = Math.max(this.shakeMag, Math.min(1.4, 0.3 + (e.a ?? 0) * 0.15));
          break;
        }
        case EventType.TopOut:
          this.sound.death();
          this.localRenderer.flash = 1;
          this.shakeMag = 1.6;
          break;
      }
    }
  }
}

// ---- 액션 텍스트 헬퍼(GameSession과 동일) ----
const LINE_NAMES = ["", "SINGLE", "DOUBLE", "TRIPLE", "QUAD"];

function pieceLetter(p: Piece): string {
  return ["", "I", "J", "L", "O", "S", "T", "Z", "G"][p] ?? "?";
}

function clearName(lines: number, spin: SpinType, piece: Piece): string {
  const ln = LINE_NAMES[lines] ?? `${lines}-LINE`;
  if (spin === SpinType.None) return ln;
  if (piece === Piece.T) return spin === SpinType.Mini ? `T-SPIN MINI ${ln}` : `T-SPIN ${ln}`;
  return `${pieceLetter(piece)} SPIN ${ln}`;
}

function clearColor(lines: number, spin: SpinType, piece: Piece): string {
  if (spin !== SpinType.None) return piece === Piece.T ? FUNKY.purple : PIECE_COLORS[piece];
  if (lines >= 4) return FUNKY.pink;
  if (lines === 3) return FUNKY.orange;
  if (lines === 2) return FUNKY.sky;
  return FUNKY.inkMuted;
}
