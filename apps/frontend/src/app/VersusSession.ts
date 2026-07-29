import { Game, EventType } from "@fetris/engine/game";
import type { GameEvent } from "@fetris/engine/game";
import { GameLoop } from "@fetris/engine/loop";
import type { LoopPerfOptions } from "@fetris/engine/loop";
import { Renderer } from "../render/renderer";
import type { GfxOptions } from "../render/renderer";
import { ParticleSystem, ActionTextManager, DamageNumberManager } from "../render/effects";
import { FUNKY, PIECE_COLORS } from "../render/theme";
import { SoundEngine, bgmForMode } from "../audio/sound";
import type { AudioOptions } from "../audio/sound";
import { InputManager } from "@fetris/engine/input";
import type { KeyMap, Action } from "@fetris/engine/input";
import { ReplayRecorder, ReplayAction, fingerprint } from "@fetris/engine/replay";
import type { MatchReplayPlayerEntry } from "@fetris/engine/replay";
import { VersusMatch } from "./VersusMatch";
import { liveStats } from "@fetris/engine/modes";
import type { HudInfo } from "@fetris/engine/modes";
import type { MultiTransport } from "../net/transport";
import { TARGET_STRATEGIES } from "../net/protocol";
import type { TargetStrategy } from "../net/protocol";
import type { Handling, RuleSet } from "@fetris/engine/types";
import { SpinType, Piece } from "@fetris/engine/types";

// ============================================================================
// VersusSession — 라스트맨 스탠딩 대전을 구동하는 UI 컨트롤러.
//  - 로컬 보드: 입력/이펙트/사운드 포함 풀 렌더.
//  - 원격 보드: 네트워크 스냅샷 미러를 별도 캔버스에 단순 렌더(이펙트 없음).
//  - 시뮬 스텝은 VersusMatch.tick으로 위임(공격 송수신·스냅샷 동기화 포함).
//
// 내가 KO돼도 세션은 살아 있다 — 로컬 보드만 잠기고 남은 사람들의 경기를
// 계속 렌더한다(관전). 승패 판정은 서버가 하며 여기서는 하지 않는다.
// ============================================================================

export interface VersusCallbacks {
  /** 내가 톱아웃 — 상위에서 서버에 ko를 보고한다 */
  onSelfKO?: () => void;
  /** 타깃 전략이 키로 바뀌었다(HUD 갱신용) */
  onStrategyChange?: (s: TargetStrategy) => void;
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
  transport: MultiTransport;
  /** 이번 매치 상대들(나 제외) */
  opponents: string[];
  /** 시작 타깃 전략 */
  strategy: TargetStrategy;
  /** 교육 모드: Ctrl+Z 되돌리기 허용 */
  undoEnabled: boolean;
  /**
   * 관전 모드 — 이번 매치에 참가하지 않는다.
   * 로컬 보드를 돌리지도, 입력을 받지도 않고 남의 화면만 그린다.
   */
  spectating?: boolean;
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
  private hudAccum = 0;
  private lastHud: HudInfo = { left: [], right: [] };
  private localCanvas: HTMLCanvasElement;
  /** 서버 검증용 입력 기록 — 매치가 끝나면 통째로 제출한다 */
  private recorder = new ReplayRecorder();
  /** 관전 모드면 내 보드를 돌리지도 그리지도 않는다 */
  private readonly spectating: boolean;
  /** 지금 크게 보고 있는 상대들 — 소리를 화면에 뜬 보드로 좁힌다 */
  private focusIds = new Set<string>();
  /** 1대1인가 — 상대가 한 명뿐이면 뛰는 중에도 그쪽 소리를 들려준다 */
  private readonly duel: boolean;

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
      transport: opts.transport,
      opponents: opts.opponents,
      strategy: opts.strategy,
    });
    this.match.local.undoEnabled = opts.undoEnabled;
    this.match.onLocalEvents = (events) => this.drainEvents(events);
    this.spectating = !!opts.spectating;
    this.duel = opts.opponents.length === 1;
    // 1대1은 볼 상대가 정해져 있다 — 화면이 뭘 고르든 그 한 명이 대상이다
    if (this.duel) this.focusIds = new Set(opts.opponents);
    // 관전자는 시뮬레이션을 돌리지 않는다 — tick이 바로 빠져나가고
    // 상대 스냅샷 수신만 남는다.
    if (this.spectating) this.match.alive = false;
    // 내 보드가 없으면 이벤트도 없어 화면이 무음이 된다.
    // 보고 있는 상대의 보드 변화를 소리로 옮겨 준다.
    this.match.onRemoteBeat = (playerId, beat) => this.playRemoteBeat(playerId, beat);
    this.localCanvas = localCanvas;
    this.match.onSelfKO = () => {
      this.sound.death();
      this.localRenderer.flash = 1;
      this.shakeMag = 1.6;
      // 더 이상 조작할 수 없다 — 화면은 관전으로 넘어간다
      this.input.detach();
      this.localCanvas.style.transition =
        "transform 0.7s cubic-bezier(0.4, 0, 1, 1), opacity 0.7s ease-out";
      this.localCanvas.style.transform = "translateY(115%) rotate(-3deg)";
      this.localCanvas.style.opacity = "0";
      this.cbs.onSelfKO?.();
    };
    // 스냅샷이 오기 전에 자리를 잡아둔 상대에게도 렌더러를 붙인다
    this.match.onRemoteAdded = (playerId) => {
      this.bindRemoteRenderer(playerId);
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
    this.attachStrategyKeys();

    // 입력을 프레임 경계에 맞춰 기록한다 — pressDir의 효과가 어차피 다음
    // update부터 나타나므로, 이 기록만으로 서버가 같은 전개를 재현할 수 있다.
    this.input.onAction = (action, down) => {
      const mapped = REPLAY_ACTION[action];
      if (mapped !== undefined) this.recorder.push(mapped, down);
    };
    // 받은 가비지도 같이 남긴다 — 대전은 키 입력만으로 판이 결정되지 않는다
    this.match.onGarbage = (holes) => this.recorder.pushGarbage(holes);

    this.loop = new GameLoop(this.match.local, opts.perf, {
      pollInput: () => this.input.poll(),
      render: (g, alpha, fps) => this.onRender(g, alpha, fps),
      stepGame: (dt, cmd, t) => {
        this.recorder.commitFrame();
        this.match.tick(dt, cmd, t);
      },
    });
  }

  start(): void {
    // 관전자는 조작할 게 없다
    if (!this.spectating) this.input.attach();
    this.sound.ensure();
    this.sound.startMusic(bgmForMode("custom"));
    this.loop.start();
  }

  destroy(): void {
    this.loop.stop();
    this.input.detach();
    window.removeEventListener("keydown", this.strategyKeys);
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

  /**
   * 레이아웃이 바뀌면(1대1 ↔ 관전 ↔ 결승 뷰) React가 캔버스를 새로 만든다.
   * 그때마다 렌더러를 다시 붙이지 않으면 죽은 DOM에 계속 그리게 되어
   * 화면이 멈춘 것처럼 보인다.
   */
  rebindRemote(playerId: string, canvas: HTMLCanvasElement): void {
    if (this.remoteCanvases.get(playerId) === canvas) return;
    this.remoteCanvases.set(playerId, canvas);
    this.remoteRenderers.delete(playerId);
    this.bindRemoteRenderer(playerId);
  }

  /** 내 보드 캔버스가 새로 만들어졌을 때 */
  rebindLocal(canvas: HTMLCanvasElement): void {
    if (this.localCanvas === canvas) return;
    this.localCanvas = canvas;
    this.localRenderer = new Renderer(canvas);
    this.localRenderer.resize();
  }

  /**
   * 서버가 알린 탈락을 화면에 반영한다.
   * 보드를 즉시 지우지 않고 아래로 무너뜨리며 사라지게 한 뒤 렌더러를 뗀다.
   */
  koRemote(playerId: string): void {
    this.match.applyKO(playerId);
    const canvas = this.remoteCanvases.get(playerId);
    if (canvas) {
      canvas.style.transition = "transform 0.7s cubic-bezier(0.4, 0, 1, 1), opacity 0.7s ease-out";
      canvas.style.transform = "translateY(115%) rotate(3deg)";
      canvas.style.opacity = "0";
    }
    // 연출이 끝나면 렌더를 멈춘다(미러 Game은 남겨 두고 그리기만 뗀다)
    setTimeout(() => {
      this.remoteRenderers.delete(playerId);
      this.remoteCanvases.delete(playerId);
    }, 720);
  }

  /**
   * 크게 보고 있는 상대들 — 이들에게서만 고빈도 스냅샷을 받고, 소리도 이들 것만 낸다.
   * 화면에 나란히 떠 있으면(1대1 결승 등) 둘 다 들려야 판이 읽힌다.
   */
  setFocus(ids: readonly string[]): void {
    if (this.duel) return; // 1대1은 상대가 고정이다
    this.focusIds = new Set(ids);
    this.match.setFocus(ids);
  }

  /**
   * 상대 보드의 변화를 소리로 옮긴다 — 관전자에게는 이게 유일한 청각 피드백이다.
   *
   * 소리는 화면을 따라간다 — 크게 떠 있는 보드는 전부 울린다. 관전 중 1대1을
   * 좌우로 보고 있으면 양쪽 다 들리고, 셋 이상에서 주역 하나만 크게 보고 있으면
   * 그 하나만 들린다. 방 전체가 소리를 내면 인원이 늘수록 뭉개져서 무슨 일이
   * 일어나는지 오히려 알 수 없다.
   *
   * 내가 아직 뛰는 중이라면 1대1에서만 상대 소리를 얹되, 내 보드 소리를 덮지
   * 않도록 한 단계 죽여 내보낸다.
   */
  private playRemoteBeat(
    playerId: string,
    beat: { cleared: number; locked: number; attacked: number; b2b: number; combo: number },
  ): void {
    const watching = this.spectating || !this.match.alive;
    // 뛰는 중에 들리는 건 1대1일 때뿐이다
    if (!watching && !this.duel) return;
    if (!this.focusIds.has(playerId)) return;

    const ring = () => {
      if (beat.cleared > 0) {
        // 스냅샷만으로는 스핀 여부를 알 수 없다 — 줄 수·B2B·콤보까지만 살린다
        this.sound.clear(Math.min(4, beat.cleared), false, beat.b2b > 1, Math.max(1, beat.combo));
      } else if (beat.locked > 0) {
        this.sound.play("harddrop");
      }
      if (beat.attacked > 0) this.sound.spike(beat.attacked);
    };

    // 내가 뛰는 중이면 상대 소리는 뒤로 물린다(관전 중엔 그게 유일한 소리라 그대로)
    if (watching) {
      ring();
      if (beat.cleared > 0) this.localRenderer.flash = Math.min(1, 0.3 + beat.cleared * 0.12);
    } else {
      this.sound.asOpponent(ring);
    }
  }

  /**
   * 서버 검증에 제출할 리플레이. 입력 로그와 최종 상태 지문을 함께 넘긴다 —
   * 서버가 같은 시드·핸들링·simRate로 재현해 지문을 대조한다.
   */
  replayPayload(): {
    seed: number;
    handling: Handling;
    frames: number;
    keys: number[];
    garbage: number[];
    fingerprint: string;
    stats: { piecesPlaced: number; lines: number; attack: number };
  } {
    return {
      // sharePieces가 꺼져 있으면 내 시드는 서버가 모른다 — 같이 올려야
      // 남들이 이 판을 재생할 수 있다
      seed: this.match.local.seed,
      // 감도도 사람마다 다르다 — 방 설정으로 재현하면 어긋난다
      handling: this.match.local.handling.h,
      frames: this.recorder.frame,
      keys: this.recorder.keys.slice(),
      garbage: this.recorder.garbage.slice(),
      fingerprint: fingerprint(this.match.local),
      stats: {
        piecesPlaced: this.match.local.stats.piecesPlaced,
        lines: this.match.local.stats.lines,
        attack: this.match.local.stats.attack,
      },
    };
  }

  /** 매치 리플레이에 들어갈 내 몫 — 방이 이걸 모아 판 하나로 묶는다 */
  replayEntry(meta: { playerId: string; nick: string; placement?: number }): MatchReplayPlayerEntry {
    const g = this.match.local;
    return {
      id: meta.playerId,
      nick: meta.nick,
      placement: meta.placement,
      seed: g.seed,
      handling: g.handling.h,
      frames: this.recorder.frame,
      keys: this.recorder.keys.slice(),
      garbage: this.recorder.garbage.slice(),
      fingerprint: fingerprint(g),
      stats: {
        piecesPlaced: g.stats.piecesPlaced,
        lines: g.stats.lines,
        attack: g.stats.attack,
      },
    };
  }

  setStrategy(s: TargetStrategy): void {
    if (this.match.strategy === s) return;
    this.match.strategy = s;
    this.actionText.push(`TARGET: ${s.toUpperCase()}`, FUNKY.yellow, 0.8);
    this.sound.play("hold");
    this.cbs.onStrategyChange?.(s);
  }

  /** 숫자키 1~4로 타깃 전략 전환(TETR.IO와 같은 자리) */
  private strategyKeys = (e: KeyboardEvent): void => {
    const idx = ["Digit1", "Digit2", "Digit3", "Digit4"].indexOf(e.code);
    if (idx < 0) return;
    e.preventDefault();
    this.setStrategy(TARGET_STRATEGIES[idx]);
  };

  private attachStrategyKeys(): void {
    window.addEventListener("keydown", this.strategyKeys);
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

    // HUD(APM/PPS/VS) — 매 프레임 문자열 할당 방지 위해 ~20Hz로 throttle
    this.hudAccum++;
    if (this.hudAccum >= 3) {
      this.hudAccum = 0;
      this.lastHud = versusHud(localGame, this.match.strategy);
    }

    // 로컬: 풀 렌더(이펙트 + 가비지 게이지 + HUD 포함)
    // KO 뒤에도 몇 프레임은 그린다 — 캔버스가 무너지는 연출 동안 보드가 남아야 한다.
    // 관전자는 애초에 자기 보드가 없으므로 건너뛴다.
    if (!this.spectating) {
      this.localRenderer.render(localGame, alpha, this.gfx, this.particles, this.actionText, this.damage, this.lastHud, localGame.pendingGarbage, localGame.readyGarbage);
    }
    // 원격: 각 상대 미러 단순 렌더(이펙트 없음, 게이지·성적은 표시)
    for (const [playerId, renderer] of this.remoteRenderers) {
      const remoteGame = this.match.remotes.get(playerId);
      if (!remoteGame) continue;
      // 크게 뜬 보드에만 성적을 붙인다(썸네일에는 자리가 없다)
      const hud = this.focusIds.has(playerId) ? remoteHud(remoteGame) : undefined;
      renderer.render(remoteGame, 0, this.gfx, undefined, undefined, undefined, hud, remoteGame.pendingGarbage, remoteGame.readyGarbage);
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
        case EventType.Clutch: {
          const n = e.a ?? 1;
          const label = n === 1 ? "CLUTCH!" : n === 2 ? "DOUBLE CLUTCH!" : n === 3 ? "TRIPLE CLUTCH!" : `CLUTCH ×${n}`;
          this.actionText.push(label, FUNKY.danger, 1.3, 1.8);
          this.localRenderer.flash = Math.max(this.localRenderer.flash, 0.6);
          this.shakeMag = Math.max(this.shakeMag, 1.0);
          this.sound.play("b2b");
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

/** InputManager의 액션명 → 리플레이 로그 코드 */
const REPLAY_ACTION: Partial<Record<Action, ReplayAction>> = {
  moveLeft: ReplayAction.MoveLeft,
  moveRight: ReplayAction.MoveRight,
  softDrop: ReplayAction.SoftDrop,
  rotateCW: ReplayAction.RotateCW,
  rotateCCW: ReplayAction.RotateCCW,
  rotate180: ReplayAction.Rotate180,
  hold: ReplayAction.Hold,
  hardDrop: ReplayAction.HardDrop,
};

/** 대전 HUD — PPS/APM/APP/VS + 현재 타깃 전략(숫자키 1~4로 전환). */
function versusHud(game: Game, strategy: TargetStrategy): HudInfo {
  const s = game.stats;
  const ls = liveStats(s);
  return {
    left: [
      { label: "PIECES", value: String(s.piecesPlaced), sub: `, ${ls.pps.toFixed(2)}/S` },
      { label: "ATTACK", value: String(s.attack), sub: `, ${ls.apm.toFixed(0)}/M` },
      { label: "APP", value: ls.app.toFixed(2) },
      { label: "VS", value: ls.vs.toFixed(1) },
      { label: "TARGET", value: strategy.toUpperCase() },
    ],
    right: [],
  };
}

/**
 * 상대 보드용 HUD. 스냅샷에 성적이 실려 오므로 미러에서도 같은 값을 뽑을 수 있다.
 * 크게 떠 있는 보드에만 붙인다 — 썸네일에는 글자가 들어갈 자리가 없다.
 */
function remoteHud(game: Game): HudInfo {
  const s = game.stats;
  const ls = liveStats(s);
  return {
    left: [
      { label: "PIECES", value: String(s.piecesPlaced), sub: `, ${ls.pps.toFixed(2)}/S` },
      { label: "ATTACK", value: String(s.attack), sub: `, ${ls.apm.toFixed(0)}/M` },
      { label: "APP", value: ls.app.toFixed(2) },
      { label: "VS", value: ls.vs.toFixed(1) },
    ],
    right: [],
  };
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
