import { Game } from "./game";
import type { InputCommands } from "./game";

// ============================================================================
// GameLoop — 고정 timestep 시뮬레이션 ↔ rAF 렌더 분리.
//  - simRate: 시뮬 틱/초 (60/120/240). 엔진 시간 단위는 60Hz 프레임이므로
//    각 틱은 dtFrames = 60/simRate 만큼 진행 → 메커니즘 수치는 항상 60Hz 기준 일관.
//  - renderFps: 렌더 상한 (0 = 디스플레이 주사율 그대로, 고주사율 풀 활용).
//  - interpolate: 시뮬 틱 사이 보간(부드러운 낙하). off면 픽셀 스냅.
//  - lowLatency: 렌더 직전 입력 재폴링으로 체감 지연 최소화.
// spiral-of-death 방지를 위해 한 프레임당 시뮬 틱 수에 상한을 둔다.
// ============================================================================

export interface LoopPerfOptions {
  simRate: number; // 60 | 120 | 240
  renderFps: number; // 0 = unlimited (주사율)
  interpolate: boolean;
  lowLatency: boolean;
}

export interface LoopHooks {
  /** 이번 배치에서 소비할 이산 입력 명령(회전/홀드/하드드롭/소프트홀드). */
  pollInput: () => InputCommands;
  /** 매 렌더 1회. alpha = 다음 시뮬 틱까지의 보간 계수(0..1). */
  render: (game: Game, alpha: number, fps: number) => void;
}

const MAX_TICKS_PER_FRAME = 8;

export class GameLoop {
  game: Game;
  opts: LoopPerfOptions;
  private hooks: LoopHooks;
  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0; // 초 단위
  private lastRender = 0;
  private fpsEMA = 60;
  private now: () => number;

  constructor(game: Game, opts: LoopPerfOptions, hooks: LoopHooks) {
    this.game = game;
    this.opts = opts;
    this.hooks = hooks;
    this.now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();
  }

  setOptions(opts: Partial<LoopPerfOptions>): void {
    Object.assign(this.opts, opts);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = this.now();
    this.accumulator = 0;
    this.lastRender = this.lastTime;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame = (): void => {
    if (!this.running) return;
    const t = this.now();
    let dt = (t - this.lastTime) / 1000; // 초
    this.lastTime = t;
    if (dt > 0.25) dt = 0.25; // 탭 비활성 등 큰 점프 클램프

    // FPS EMA
    if (dt > 0) {
      const instFps = 1 / dt;
      this.fpsEMA += (instFps - this.fpsEMA) * 0.1;
    }

    const simStep = 1 / this.opts.simRate; // 초/틱
    const dtFrames = 60 / this.opts.simRate; // 엔진 프레임/틱

    this.accumulator += dt;
    let ticks = 0;
    // 이번 배치의 이산 입력 — 첫 틱에만 적용(중복 방지)
    let cmd: InputCommands | null = null;

    while (this.accumulator >= simStep && ticks < MAX_TICKS_PER_FRAME) {
      if (cmd === null) cmd = this.hooks.pollInput();
      else cmd = this.continuousOnly(cmd);
      this.game.update(dtFrames, cmd, t);
      this.accumulator -= simStep;
      ticks++;
    }
    // 상한 초과 시 누적 버림(spiral 방지)
    if (ticks >= MAX_TICKS_PER_FRAME) this.accumulator = 0;

    // 렌더 (frame cap 적용)
    const renderInterval = this.opts.renderFps > 0 ? 1000 / this.opts.renderFps : 0;
    if (renderInterval === 0 || t - this.lastRender >= renderInterval - 0.5) {
      this.lastRender = t;
      const alpha = this.opts.interpolate ? this.accumulator / simStep : 0;
      this.hooks.render(this.game, alpha, Math.round(this.fpsEMA));
    }

    this.rafId = requestAnimationFrame(this.frame);
  };

  /** 두 번째 틱부터는 이산 입력을 빼고 연속 상태만 유지 */
  private continuousOnly(cmd: InputCommands): InputCommands {
    return {
      rotateCW: false,
      rotateCCW: false,
      rotate180: false,
      hardDrop: false,
      hold: false,
      softDropHeld: cmd.softDropHeld,
    };
  }

  get fps(): number {
    return Math.round(this.fpsEMA);
  }
}
