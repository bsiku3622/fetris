import { MatchReplayPlayer } from "@fetris/engine/replay";
import type { MatchReplayFile } from "@fetris/engine/replay";
import { Renderer } from "../render/renderer";
import type { GfxOptions } from "../render/renderer";
import { liveStats } from "@fetris/engine/modes";
import type { HudInfo } from "@fetris/engine/modes";

// ============================================================================
// ReplaySession — 저장된 판을 다시 돌려 보여주는 컨트롤러.
//
// 판 하나에는 참가자 여러 명이 들어 있다. 각자의 보드는 자기 시드·키·받은
// 가비지만으로 독립적으로 재현되므로, 같은 프레임으로 나란히 진행하면 그날의
// 대전이 그대로 재생된다.
//
// 게임 세션과 마찬가지로 React 밖에서 루프를 돌린다. 진행 상황만 낮은 빈도로
// 콜백에 실어 보내 슬라이더를 갱신하고, 보드는 캔버스에 직접 그린다.
//
// 시뮬레이션에는 되감기가 없어서 뒤로 가는 탐색은 처음부터 다시 돌린다
// (몇 천 프레임이라도 수십 ms라 체감되지 않는다).
// ============================================================================

export interface ReplayCallbacks {
  /** 재생 위치가 바뀔 때(약 10Hz) */
  onProgress?: (frame: number, playing: boolean) => void;
  /** 끝까지 재생했을 때 */
  onEnd?: () => void;
}

export class ReplaySession {
  readonly frames: number;
  private match: MatchReplayPlayer;
  /** 참가자 순서와 같은 렌더러 목록(캔버스가 아직 없는 참가자는 null) */
  private renderers: (Renderer | null)[];
  private ids: string[];
  private gfx: GfxOptions;
  private cbs: ReplayCallbacks;

  private raf = 0;
  private playing = false;
  private speed = 1;
  /** 프레임 진행 누적(속도가 1이 아니면 소수로 쌓인다) */
  private accum = 0;
  private lastTime = 0;
  private progressAccum = 0;
  private hud: HudInfo = { left: [], right: [] };

  constructor(
    canvases: Map<string, HTMLCanvasElement>,
    file: MatchReplayFile,
    gfx: GfxOptions,
    cbs: ReplayCallbacks = {},
  ) {
    this.gfx = gfx;
    this.cbs = cbs;
    this.match = new MatchReplayPlayer(file);
    this.frames = this.match.frames;
    this.ids = file.players.map((p) => p.id);
    this.renderers = this.ids.map((id) => {
      const canvas = canvases.get(id);
      if (!canvas) return null;
      const r = new Renderer(canvas);
      r.resize();
      return r;
    });
    this.draw();
  }

  get frame(): number {
    return this.match.frame;
  }
  get isPlaying(): boolean {
    return this.playing;
  }
  get playbackSpeed(): number {
    return this.speed;
  }

  play(): void {
    if (this.playing) return;
    if (this.match.done) this.match.reset();
    this.playing = true;
    this.lastTime = performance.now();
    this.accum = 0;
    this.loop();
    this.cbs.onProgress?.(this.match.frame, true);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cbs.onProgress?.(this.match.frame, false);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(x: number): void {
    this.speed = Math.max(0.1, Math.min(8, x));
  }

  /** 특정 프레임으로 이동(재생 중이면 그대로 이어서 재생) */
  seek(frame: number): void {
    this.match.seek(frame);
    this.accum = 0;
    this.lastTime = performance.now();
    this.draw();
    this.cbs.onProgress?.(this.match.frame, this.playing);
  }

  /** 화면이 다시 잡힌 뒤 캔버스를 붙인다(레이아웃 변경·늦은 마운트 대응) */
  rebind(playerId: string, canvas: HTMLCanvasElement): void {
    const i = this.ids.indexOf(playerId);
    if (i < 0) return;
    const r = new Renderer(canvas);
    r.resize();
    this.renderers[i] = r;
    this.draw();
  }

  resize(): void {
    for (const r of this.renderers) r?.resize();
    this.draw();
  }

  setGfx(gfx: GfxOptions): void {
    this.gfx = gfx;
  }

  destroy(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private loop = (): void => {
    if (!this.playing) return;
    const now = performance.now();
    const dtMs = Math.min(250, now - this.lastTime); // 탭 복귀 시 몰아치기 방지
    this.lastTime = now;

    // 기록은 60Hz 프레임 단위다 — 속도를 곱해 몇 프레임 진행할지 정한다
    this.accum += (dtMs / 1000) * 60 * this.speed;
    let steps = Math.floor(this.accum);
    if (steps > 0) {
      this.accum -= steps;
      // 한 번에 너무 많이 밀리면 끊겨 보이므로 상한을 둔다
      steps = Math.min(steps, 240);
      for (let i = 0; i < steps; i++) {
        if (!this.match.step()) {
          this.pause();
          this.draw();
          this.cbs.onEnd?.();
          return;
        }
      }
    }

    this.draw();

    this.progressAccum += dtMs;
    if (this.progressAccum >= 100) {
      this.progressAccum = 0;
      this.cbs.onProgress?.(this.match.frame, true);
    }

    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(): void {
    for (let i = 0; i < this.renderers.length; i++) {
      const renderer = this.renderers[i];
      if (!renderer) continue;
      const g = this.match.boards[i].game;
      const s = g.stats;
      const ls = liveStats(s);
      this.hud = {
        left: [
          { label: "PIECES", value: String(s.piecesPlaced), sub: `, ${ls.pps.toFixed(2)}/S` },
          { label: "LINES", value: String(s.lines) },
          { label: "ATTACK", value: String(s.attack), sub: `, ${ls.apm.toFixed(0)}/M` },
        ],
        right: [],
      };
      renderer.render(
        g, 0, this.gfx,
        undefined, undefined, undefined,
        this.hud,
        g.pendingGarbage, g.readyGarbage,
      );
    }
  }
}
