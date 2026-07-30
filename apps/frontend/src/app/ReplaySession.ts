import { MatchReplayPlayer } from "@fetris/engine/replay";
import type { MatchReplayFile } from "@fetris/engine/replay";
import { EventType } from "@fetris/engine/game";
import { SpinType } from "@fetris/engine/types";
import { Renderer } from "../render/renderer";
import type { GfxOptions } from "../render/renderer";
import { SoundEngine } from "../audio/sound";
import type { AudioOptions } from "../audio/sound";
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
  private sound: SoundEngine;
  /** 소리를 낼 보드 수(앞에서부터) */
  private loudCount: number;
  /** 녹화 보드용 — 직전 성적을 들고 있다가 차이를 소리로 옮긴다 */
  private lastStats: { lines: number; pieces: number; attack: number }[] = [];

  constructor(
    canvases: Map<string, HTMLCanvasElement>,
    file: MatchReplayFile,
    gfx: GfxOptions,
    audio: AudioOptions,
    cbs: ReplayCallbacks = {},
  ) {
    this.gfx = gfx;
    this.cbs = cbs;
    this.sound = new SoundEngine(audio);
    // 소리는 대전과 같은 규칙을 따른다 — 둘까지는 양쪽 다(뒤쪽은 죽여서),
    // 셋 이상은 뭉개지므로 1위 보드만 울린다.
    this.loudCount = file.players.length <= 2 ? file.players.length : 1;
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
    this.sound.ensure();
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
    // 탐색 중 지나친 사건까지 몰아 울리면 안 된다 — 기준점만 새로 잡는다
    this.syncStats();
    for (const b of this.match.boards) b.game.events.length = 0;
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
    this.sound.dispose();
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
        // 빨리 감기 중에는 소리를 내지 않는다(한 프레임에 몰려 울려 시끄럽다)
        if (this.speed <= 2) this.ring();
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

  /**
   * 이번 프레임에 일어난 일을 소리로 옮긴다.
   *
   * 시뮬레이션으로 도는 보드는 엔진 이벤트가 그대로 있어 스핀까지 살릴 수 있고,
   * 서버 녹화로 도는 보드는 상태만 있으므로 성적 차이로 되짚는다.
   */
  private ring(): void {
    for (let i = 0; i < this.match.boards.length; i++) {
      if (i >= this.loudCount) {
        // 소리를 안 낼 보드라도 이벤트는 비워야 다음 프레임에 쌓이지 않는다
        this.match.boards[i].game.events.length = 0;
        continue;
      }
      const g = this.match.boards[i].game;
      const play = () => {
        if (g.events.length > 0) this.ringEvents(i);
        else this.ringStats(i);
      };
      // 두 번째 보드는 한 단계 죽여 첫 보드를 덮지 않게 한다
      if (i === 0) play();
      else this.sound.asOpponent(play);
    }
  }

  /** 엔진 이벤트가 있는 보드(입력 로그로 재현 중) */
  private ringEvents(i: number): void {
    const g = this.match.boards[i].game;
    for (const e of g.events) {
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
        case EventType.HardDrop:
          this.sound.play("harddrop");
          break;
        case EventType.SpinDetect:
          this.sound.spinHit(true);
          break;
        case EventType.LineClear:
          this.sound.clear(
            e.a ?? 1,
            (e.spin ?? SpinType.None) !== SpinType.None,
            (e.clear?.b2b ?? 0) > 1,
            e.clear?.combo ?? 1,
          );
          break;
        case EventType.GarbageIn:
          this.sound.garbageRise(e.a ?? 1);
          break;
        case EventType.TopOut:
          this.sound.death();
          break;
      }
    }
    g.events.length = 0;
    this.lastStats[i] = this.statsOf(i);
  }

  /** 상태만 있는 보드(서버 녹화로 재생 중) — 성적 차이로 되짚는다 */
  private ringStats(i: number): void {
    const now = this.statsOf(i);
    const before = this.lastStats[i];
    this.lastStats[i] = now;
    if (!before) return;
    const cleared = now.lines - before.lines;
    if (cleared > 0) this.sound.clear(Math.min(4, cleared), false, false, 1);
    else if (now.pieces > before.pieces) this.sound.play("harddrop");
    if (now.attack > before.attack) this.sound.spike(now.attack - before.attack);
  }

  private statsOf(i: number): { lines: number; pieces: number; attack: number } {
    const s = this.match.boards[i].game.stats;
    return { lines: s.lines, pieces: s.piecesPlaced, attack: s.attack };
  }

  /** 소리의 기준점을 지금 상태로 다시 잡는다(탐색 직후) */
  private syncStats(): void {
    for (let i = 0; i < this.match.boards.length; i++) this.lastStats[i] = this.statsOf(i);
  }

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
        this.match.planOf(i),
      );
    }
  }
}
