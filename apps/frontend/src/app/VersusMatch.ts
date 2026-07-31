import { Game, EventType } from "@fetris/engine/game";
import type { GameEvent, InputCommands } from "@fetris/engine/game";
import { BoardMirror } from "@fetris/engine/mirror";
import { ReplayRecorder } from "@fetris/engine/replay";
import { MAX_PLAN_GHOSTS } from "@fetris/engine/types";
import type { Handling, RuleSet, PlanGhost } from "@fetris/engine/types";
import type { MultiTransport } from "../net/transport";
import type { GameMessage, MatchSimParams, TargetStrategy } from "../net/protocol";

// ============================================================================
// VersusMatch — 라스트맨 스탠딩 대전의 헤드리스 코어(렌더/입력 비의존).
//
//  - local:   내가 조종하는 Game
//  - remotes: 상대들의 미러(playerId → BoardMirror)
//
// 상대에게 보내는 것은 보드가 아니라 **누른 키**다. 엔진이 결정론적이라 같은
// 시드·감도에 같은 입력을 먹이면 같은 판이 나오므로, 받는 쪽이 다시 돌리면
// 상대 화면이 프레임 단위로 재현된다. 보드를 통째로 보내는 것보다 트래픽이
// 두 자릿수 배로 적고, 스냅샷 사이가 멈춰 보이던 문제도 사라진다.
//
// 흘려보내는 것은 리플레이 기록기가 쌓는 로그 그 자체다 — 나중에 검증에 낼
// 기록과 지금 남들이 보는 화면이 같은 자료에서 나오므로 둘이 어긋날 수 없다.
//
// 공격은 sender-authoritative: 내 Attack 이벤트를 타깃에게 보내고, 받은 공격은
// 내 로컬 보드에 가비지로 쌓는다. 타깃은 TETR.IO식 4전략으로 고른다(수동 지정 없음).
// 받은 가비지는 내 입력 스트림에 함께 실려 나간다 — 키만으로는 판이 결정되지
// 않기 때문이다.
//
// 매치 진행(누가 참가하고 언제 끝나는지)은 서버가 소유한다. 이 클래스는 서버가
// 알려준 KO/종료를 받아 반영할 뿐, 스스로 승패를 판정하지 않는다.
// ============================================================================

/**
 * 입력 스트림을 내보내는 주기(프레임). 미러는 이만큼 뒤에서 따라오므로 그대로
 * 지연이 되지만, 매 프레임 보내면 인원수만큼 메시지 수가 불어난다.
 */
const STREAM_FRAMES = 4;
/**
 * 상태 키프레임 주기(프레임). 순단으로 입력이 통째로 빈 구간이 생기면 미러가
 * 그 자리에 멈추는데, 이걸 받아야 다시 이어 붙는다. 스트림 주기의 배수여야
 * 같은 틱에서 스트림이 먼저 나간다(순서가 뒤집히면 지나간 입력이 되살아난다).
 */
const KEYFRAME_FRAMES = 120;
/** payback 전략이 "최근"으로 치는 시간(프레임). 약 8초. */
const PAYBACK_MEMORY_FRAMES = 480;

export interface VersusOptions {
  rule: RuleSet;
  handling: Handling;
  seed: number;
  myAttackMul: number;
  transport: MultiTransport;
  /** 이번 매치 참가자(나 제외) */
  opponents: string[];
  /** 시작 타깃 전략 */
  strategy?: TargetStrategy;
  /**
   * 참가자별 시드·감도. 없으면 방 공통값으로 미러를 만든다(로컬 대전·테스트).
   */
  sim?: readonly MatchSimParams[];
  /** 방이 정한 시뮬 주파수 — 미러도 같은 단위로 돌아야 한다 */
  simRate?: number;
}

export class VersusMatch {
  readonly local: Game;
  /** playerId → 상대 미러. 받은 입력을 그대로 다시 돌린다 */
  readonly remotes = new Map<string, BoardMirror>();
  /**
   * 내 입력 기록. 검증 제출과 남들에게 흘려보내는 스트림이 여기 한 곳에서
   * 나오므로, 남이 보고 있던 판과 나중에 제출하는 기록이 어긋날 수 없다.
   */
  readonly recorder = new ReplayRecorder();
  /**
   * playerId → 표시 전용 계획 고스트. 게임 상태가 아니라 화면에만 쓰이므로
   * 미러 Game과 따로 둔다(시뮬레이션·검증에 섞이면 안 된다).
   *
   * 내용은 서버가 소유한다 — 개별 삭제·자동 정리·판 종료 정리를 서버가 하고,
   * 여기는 그 결과를 받아 그리기만 한다.
   */
  readonly plans = new Map<string, PlanGhost[]>();
  /** 아직 살아있는 상대 */
  private aliveIds: string[] = [];
  /** 내가 살아있는지 — 죽으면 입력을 받지 않는다 */
  alive = true;

  private transport: MultiTransport;
  private rule: RuleSet;
  private handling: Handling;
  private seed: number;
  private simRate: number;
  private attackMul: number;
  /** playerId → 그 사람을 재현하는 데 필요한 조건(서버가 나눠준다) */
  private simParams = new Map<string, MatchSimParams>();

  /** 공격 타깃 전략 */
  strategy: TargetStrategy;

  /** even 전략용 — 상대별로 내가 보낸 누적 공격량 */
  private sentTo = new Map<string, number>();
  /** payback 전략용 — 상대별 마지막 피격 프레임과 양 */
  private hitBy = new Map<string, { frame: number; amount: number }>();
  /** 결정론과 무관한 표시용 프레임 카운터 */
  private frame = 0;

  private streamAccum = 0;
  private keyframeAccum = 0;
  /** 어디까지 흘려보냈는지 — 기록기에 새로 쌓인 만큼만 보낸다 */
  private sentKeys = 0;
  private sentIge = 0;

  onLocalEvents?: (events: GameEvent[]) => void;
  /** playerId별 상대 보드가 갱신됐다 */
  onRemoteUpdate?: (playerId: string) => void;
  /** 내가 톱아웃했다 — 상위에서 서버에 ko를 보고한다 */
  onSelfKO?: () => void;
  /** 상대 미러가 새로 만들어졌다(렌더러 바인딩용) */
  onRemoteAdded?: (playerId: string) => void;
  /**
   * 상대 보드에서 일어난 일. 미러가 진짜 게임이라 엔진 이벤트가 그대로 나온다 —
   * 스핀·B2B까지 살아 있어 관전 화면도 자기 판과 같은 소리를 낼 수 있다.
   */
  onRemoteEvents?: (playerId: string, events: GameEvent[]) => void;
  /**
   * 스냅샷만 보내는 상대(옛 봇)에서 한 박자가 일어났다.
   * 상태 차이로 되짚은 것이라 이벤트만큼 정밀하진 않다.
   */
  onRemoteBeat?: (
    playerId: string,
    beat: { cleared: number; locked: number; attacked: number; b2b: number; combo: number },
  ) => void;

  constructor(opts: VersusOptions) {
    this.rule = opts.rule;
    this.handling = opts.handling;
    this.seed = opts.seed;
    this.simRate = opts.simRate ?? 60;
    this.attackMul = opts.myAttackMul;
    this.strategy = opts.strategy ?? "random";
    this.local = new Game(opts.rule, opts.handling, opts.seed);
    this.local.attackMultiplier = opts.myAttackMul;
    this.transport = opts.transport;

    for (const p of opts.sim ?? []) this.simParams.set(p.id, p);
    for (const id of opts.opponents) this.ensureRemote(id);
    this.aliveIds = [...opts.opponents];

    this.transport.onMessage((m, from) => this.onMessage(m, from));
    this.transport.onPlayerLeft?.((playerId) => this.removeOpponent(playerId));
    this.transport.onPlanState?.((playerId, ghosts) => this.setPlan(playerId, ghosts));
  }

  /**
   * 상대 미러를 만들어 둔다(입력이 오기 전에도 자리를 잡아야 렌더러가 붙는다).
   * 시드·감도를 모르는 상대는 방 공통값으로 세워 두는데, 그런 상대는 어차피
   * 스냅샷만 보내므로 미러가 시뮬을 돌리지 않는다.
   */
  private ensureRemote(playerId: string): BoardMirror {
    let mirror = this.remotes.get(playerId);
    if (!mirror) {
      const p = this.simParams.get(playerId);
      mirror = new BoardMirror({
        rule: this.rule,
        handling: p?.handling ?? this.handling,
        seed: p?.seed ?? this.seed,
        simRate: this.simRate,
        attackMul: this.attackMul,
      });
      this.remotes.set(playerId, mirror);
      this.onRemoteAdded?.(playerId);
    }
    return mirror;
  }

  get aliveOpponents(): readonly string[] {
    return this.aliveIds;
  }

  /** 서버가 알려준 탈락을 반영한다. 내 화면에서는 보드가 남아 연출된 뒤 사라진다. */
  applyKO(playerId: string): void {
    this.aliveIds = this.aliveIds.filter((id) => id !== playerId);
  }

  /** 서버가 알려준 계획 상태를 반영한다(빈 배열이면 지운다) */
  setPlan(playerId: string, ghosts: readonly PlanGhost[]): void {
    if (ghosts.length === 0) this.plans.delete(playerId);
    else this.plans.set(playerId, ghosts.slice(0, MAX_PLAN_GHOSTS));
  }

  /** 이탈 — 미러까지 즉시 제거 */
  private removeOpponent(playerId: string): void {
    this.applyKO(playerId);
    this.remotes.delete(playerId);
    this.plans.delete(playerId);
  }

  // ---- 타깃 선택 -----------------------------------------------------------

  /**
   * TETR.IO식 타깃 전략.
   *  random  — 생존자 중 무작위
   *  even    — 내가 가장 적게 때린 상대(공격을 고르게 분배)
   *  elims   — 보드가 가장 높이 쌓인 상대(KO에 가까운 쪽)
   *  payback — 최근 나를 때린 상대. 없으면 random으로 물러난다.
   */
  private pickTarget(): string | null {
    const alive = this.aliveIds.filter((id) => this.remotes.has(id));
    if (alive.length === 0) return null;
    if (alive.length === 1) return alive[0];

    switch (this.strategy) {
      case "random":
        return alive[Math.floor(Math.random() * alive.length)];

      case "even": {
        let best = alive[0];
        let least = this.sentTo.get(best) ?? 0;
        for (const id of alive) {
          const sent = this.sentTo.get(id) ?? 0;
          if (sent < least) {
            least = sent;
            best = id;
          }
        }
        return best;
      }

      case "elims": {
        // highestRow()가 작을수록 위험(스택이 높다)
        let best = alive[0];
        let highest = Number.POSITIVE_INFINITY;
        for (const id of alive) {
          const mirror = this.remotes.get(id);
          if (!mirror) continue;
          const top = mirror.game.board.highestRow();
          if (top < highest) {
            highest = top;
            best = id;
          }
        }
        return best;
      }

      case "payback": {
        let best: string | null = null;
        let latest = -1;
        for (const id of alive) {
          const hit = this.hitBy.get(id);
          if (!hit) continue;
          if (this.frame - hit.frame > PAYBACK_MEMORY_FRAMES) continue;
          if (hit.frame > latest) {
            latest = hit.frame;
            best = id;
          }
        }
        return best ?? alive[Math.floor(Math.random() * alive.length)];
      }
    }
  }

  // ---- 시뮬레이션 ----------------------------------------------------------

  tick(dtFrames: number, cmd: InputCommands, now = 0): void {
    this.frame += dtFrames;
    if (this.alive) this.tickLocal(dtFrames, cmd, now);
    // KO된 뒤에도, 관전자로 들어왔어도 남의 판은 계속 흘러야 한다
    this.advanceMirrors();
  }

  private tickLocal(dtFrames: number, cmd: InputCommands, now: number): void {
    // 이번 스텝에 반영될 입력을 프레임에 못박는다 — 이 기록이 곧 남들에게
    // 흘려보낼 스트림이자 나중에 검증에 낼 로그다
    this.recorder.commitFrame();
    this.local.update(dtFrames, cmd, now);

    const evs = this.local.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.type === EventType.Attack && e.cells && e.cells.length > 0) {
        const targetId = this.pickTarget();
        if (targetId) {
          this.transport.sendTo(targetId, { t: "attack", holes: e.cells.slice(), targetId });
          this.sentTo.set(targetId, (this.sentTo.get(targetId) ?? 0) + e.cells.length);
        }
      }
    }
    this.onLocalEvents?.(evs);
    this.local.events.length = 0;

    if (this.local.isGameOver()) {
      this.alive = false;
      // 마지막 조각까지 남들 화면에 닿도록 남은 걸 털어 보낸다
      this.flushStream();
      this.onSelfKO?.();
      return;
    }

    this.streamAccum += 1;
    if (this.streamAccum >= STREAM_FRAMES) {
      this.streamAccum = 0;
      this.flushStream();
    }
    // 스트림이 먼저 나간 뒤에 보낸다 — 순서가 뒤집히면 미러가 키프레임으로
    // 앞질러 간 다음 지나간 입력을 다시 먹게 된다
    this.keyframeAccum += 1;
    if (this.keyframeAccum >= KEYFRAME_FRAMES) {
      this.keyframeAccum = 0;
      this.transport.send({
        t: "full",
        frame: this.recorder.frame,
        snap: this.local.serialize(),
      });
    }
  }

  /** 기록기에 새로 쌓인 만큼을 흘려보낸다 */
  private flushStream(): void {
    const r = this.recorder;
    const msg: Extract<GameMessage, { t: "sync" }> = { t: "sync", upto: r.frame };
    if (r.keys.length > this.sentKeys) {
      msg.keys = r.keys.slice(this.sentKeys);
      this.sentKeys = r.keys.length;
    }
    if (r.garbage.length > this.sentIge) {
      msg.ige = r.garbage.slice(this.sentIge);
      this.sentIge = r.garbage.length;
    }
    this.transport.send(msg);
  }

  /** 상대 미러들을 받은 데까지 진행시킨다 */
  private advanceMirrors(): void {
    for (const [id, mirror] of this.remotes) {
      const steps = mirror.advance();
      if (steps === 0) continue;
      const g = mirror.game;
      if (g.events.length > 0) {
        // 밀린 걸 몰아서 따라잡는 중이면 소리는 건너뛴다(한꺼번에 터진다)
        if (steps === 1) this.onRemoteEvents?.(id, g.events);
        g.events.length = 0;
      }
      this.onRemoteUpdate?.(id);
    }
  }

  private onMessage(m: GameMessage, from?: string): void {
    switch (m.t) {
      case "attack": {
        // 서버가 relay-to로 나에게만 보낸 것이므로 그대로 받는다
        if (!this.alive) break;
        this.local.receiveGarbage({ holes: m.holes });
        // 받은 가비지는 바깥에서 들어온 입력이다 — 같이 남기고 같이 흘려보내야
        // 남의 미러도, 나중의 재현도 같은 판이 된다
        this.recorder.pushGarbage(m.holes);
        if (from) {
          this.hitBy.set(from, { frame: this.frame, amount: m.holes.length });
        }
        break;
      }
      case "sync": {
        if (!from) break;
        this.ensureRemote(from).feed(m.upto, m.keys, m.ige);
        break;
      }
      case "full": {
        if (!from) break;
        this.ensureRemote(from).keyframe(m.frame, m.snap);
        this.onRemoteUpdate?.(from);
        break;
      }
      case "board": {
        // 입력을 흘리지 않는 옛 봇 — 상태만 얹고 시뮬은 돌리지 않는다
        if (!from) break;
        const mirror = this.ensureRemote(from);
        const g = mirror.game;
        // 스냅샷에는 이벤트가 실려 오지 않는다. 소리를 들려주려면 적용 전후의
        // 성적을 견줘 무슨 일이 있었는지 되짚는 수밖에 없다.
        const before = this.onRemoteBeat
          ? { lines: g.stats.lines, pieces: g.stats.piecesPlaced, attack: g.stats.attack }
          : null;
        mirror.snapshot(m.snap);
        if (before && this.onRemoteBeat) {
          const cleared = g.stats.lines - before.lines;
          const locked = g.stats.piecesPlaced - before.pieces;
          const attacked = g.stats.attack - before.attack;
          if (cleared > 0 || locked > 0) {
            this.onRemoteBeat(from, {
              cleared,
              locked,
              attacked,
              b2b: g.scoring.b2b,
              combo: g.scoring.combo,
            });
          }
        }
        this.onRemoteUpdate?.(from);
        break;
      }
    }
  }

  dispose(): void {
    this.transport.close();
  }
}
