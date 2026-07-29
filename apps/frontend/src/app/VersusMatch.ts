import { Game, EventType } from "@fetris/engine/game";
import type { GameEvent, InputCommands } from "@fetris/engine/game";
import type { Handling, RuleSet } from "@fetris/engine/types";
import type { MultiTransport } from "../net/transport";
import type { GameMessage, TargetStrategy } from "../net/protocol";

// ============================================================================
// VersusMatch — 라스트맨 스탠딩 대전의 헤드리스 코어(렌더/입력 비의존).
//
//  - local: 내가 조종하는 Game(시뮬 진행)
//  - remotes: 상대들의 미러(playerId → Game). 스냅샷만 적용하고 시뮬은 안 한다.
//
// 공격은 sender-authoritative: 내 Attack 이벤트를 타깃에게 보내고, 받은 공격은
// 내 로컬 보드에 가비지로 쌓는다. 타깃은 TETR.IO식 4전략으로 고른다(수동 지정 없음).
//
// 매치 진행(누가 참가하고 언제 끝나는지)은 서버가 소유한다. 이 클래스는 서버가
// 알려준 KO/종료를 받아 반영할 뿐, 스스로 승패를 판정하지 않는다.
//
// 스냅샷 트래픽은 인원의 제곱으로 늘기 때문에 두 단계로 나눠 보낸다.
//  - ambient: 방 전체에 저빈도(썸네일용)
//  - focus:   나를 크게 보고 있는 사람에게만 고빈도
// ============================================================================

/** 나를 보고 있는 사람에게 보내는 주기(프레임) — 약 20Hz */
const SNAP_FOCUS_FRAMES = 3;
/** 방 전체에 뿌리는 주기(프레임) — 약 5Hz. 썸네일에는 충분하다. */
const SNAP_AMBIENT_FRAMES = 12;
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
}

export class VersusMatch {
  readonly local: Game;
  /** playerId → 상대 미러 Game */
  readonly remotes = new Map<string, Game>();
  /** 아직 살아있는 상대 */
  private aliveIds: string[] = [];
  /** 내가 살아있는지 — 죽으면 입력을 받지 않는다 */
  alive = true;

  private transport: MultiTransport;
  private rule: RuleSet;
  private handling: Handling;
  private seed: number;

  /** 공격 타깃 전략 */
  strategy: TargetStrategy;
  /** 지금 크게 보고 있는 상대들 — 이들에게서만 고빈도 스냅샷을 받는다 */
  private focusIds = new Set<string>();
  /** 나를 보고 있는 사람들 — 이들에게만 고빈도로 보낸다 */
  private watchers = new Set<string>();
  /** 1대1인가 — 포커스 장치를 통째로 끈다 */
  private readonly duel: boolean;

  /** even 전략용 — 상대별로 내가 보낸 누적 공격량 */
  private sentTo = new Map<string, number>();
  /** payback 전략용 — 상대별 마지막 피격 프레임과 양 */
  private hitBy = new Map<string, { frame: number; amount: number }>();
  /** 결정론과 무관한 표시용 프레임 카운터 */
  private frame = 0;

  private focusAccum = 0;
  private ambientAccum = 0;

  onLocalEvents?: (events: GameEvent[]) => void;
  /** playerId별 보드 스냅샷 갱신 */
  onRemoteUpdate?: (playerId: string) => void;
  /** 내가 톱아웃했다 — 상위에서 서버에 ko를 보고한다 */
  onSelfKO?: () => void;
  /** 상대 미러가 새로 만들어졌다(렌더러 바인딩용) */
  onRemoteAdded?: (playerId: string) => void;
  /** 가비지를 받았다 — 리플레이 기록기가 같이 남겨야 재현이 성립한다 */
  onGarbage?: (holes: number[]) => void;
  /**
   * 상대 보드에서 한 박자(조각 착지·라인 클리어)가 일어났다.
   * 스냅샷 차이로 되짚은 것이라 이벤트만큼 정밀하진 않지만, 관전자에게
   * 소리를 들려주는 데는 충분하다.
   */
  onRemoteBeat?: (
    playerId: string,
    beat: { cleared: number; locked: number; attacked: number; b2b: number; combo: number },
  ) => void;

  constructor(opts: VersusOptions) {
    this.rule = opts.rule;
    this.handling = opts.handling;
    this.seed = opts.seed;
    this.strategy = opts.strategy ?? "random";
    this.local = new Game(opts.rule, opts.handling, opts.seed);
    this.local.attackMultiplier = opts.myAttackMul;
    this.transport = opts.transport;

    this.duel = opts.opponents.length === 1;
    for (const id of opts.opponents) this.ensureRemote(id);
    this.aliveIds = [...opts.opponents];

    this.transport.onMessage((m, from) => this.onMessage(m, from));
    this.transport.onPlayerLeft?.((playerId) => this.removeOpponent(playerId));
  }

  /** 상대 미러를 만들어 둔다(스냅샷이 오기 전에도 자리를 잡아야 렌더러가 붙는다) */
  private ensureRemote(playerId: string): Game {
    let g = this.remotes.get(playerId);
    if (!g) {
      g = new Game(this.rule, this.handling, this.seed);
      this.remotes.set(playerId, g);
      this.onRemoteAdded?.(playerId);
    }
    return g;
  }

  get aliveOpponents(): readonly string[] {
    return this.aliveIds;
  }

  /** 서버가 알려준 탈락을 반영한다. 내 화면에서는 보드가 남아 연출된 뒤 사라진다. */
  applyKO(playerId: string): void {
    this.aliveIds = this.aliveIds.filter((id) => id !== playerId);
    if (this.focusIds.has(playerId)) {
      this.setFocus([...this.focusIds].filter((id) => id !== playerId));
    }
    this.watchers.delete(playerId);
  }

  /** 이탈 — 미러까지 즉시 제거 */
  private removeOpponent(playerId: string): void {
    this.applyKO(playerId);
    this.remotes.delete(playerId);
  }

  /**
   * 크게 보고 있는 상대들을 바꾼다. 화면에 여럿이 떠 있으면(1대1 결승 등)
   * 그 전부에게 알려 고빈도 스냅샷을 받는다.
   */
  setFocus(ids: readonly string[]): void {
    if (this.duel) return; // 볼 사람이 하나뿐이라 알릴 것도 없다
    const next = new Set(ids);
    for (const id of this.focusIds) {
      if (!next.has(id)) this.transport.sendTo(id, { t: "focus", watching: false });
    }
    for (const id of next) {
      if (!this.focusIds.has(id)) this.transport.sendTo(id, { t: "focus", watching: true });
    }
    this.focusIds = next;
  }

  get focus(): ReadonlySet<string> {
    return this.focusIds;
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
          const g = this.remotes.get(id);
          if (!g) continue;
          const top = g.board.highestRow();
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
    if (!this.alive) return;
    this.frame += dtFrames;
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

    if (this.local.isGameOver() && this.alive) {
      this.alive = false;
      this.onSelfKO?.();
      return;
    }

    // 1대1은 포커스라는 개념이 없다 — 상대가 한 명뿐이라 서로를 늘 크게 본다.
    // 포커스는 인원이 늘 때 트래픽이 제곱으로 붇는 걸 막으려고 만든 장치이므로,
    // 둘뿐일 때는 그냥 끄고 방 전체에 고빈도로 보낸다(관전자도 같이 잘 본다).
    if (this.duel) {
      this.focusAccum += dtFrames;
      if (this.focusAccum >= SNAP_FOCUS_FRAMES) {
        this.focusAccum = 0;
        this.transport.send({ t: "board", snap: this.local.serialize() });
      }
      return;
    }

    // 셋 이상 — 나를 보고 있는 사람에게는 자주, 나머지에게는 드물게
    this.focusAccum += dtFrames;
    if (this.focusAccum >= SNAP_FOCUS_FRAMES && this.watchers.size > 0) {
      this.focusAccum = 0;
      const snap = this.local.serialize();
      for (const watcher of this.watchers) {
        this.transport.sendTo(watcher, { t: "board", snap });
      }
    }
    this.ambientAccum += dtFrames;
    if (this.ambientAccum >= SNAP_AMBIENT_FRAMES) {
      this.ambientAccum = 0;
      this.transport.send({ t: "board", snap: this.local.serialize() });
    }
  }

  private onMessage(m: GameMessage, from?: string): void {
    switch (m.t) {
      case "attack": {
        // 서버가 relay-to로 나에게만 보낸 것이므로 그대로 받는다
        if (!this.alive) break;
        this.local.receiveGarbage({ holes: m.holes });
        this.onGarbage?.(m.holes);
        if (from) {
          this.hitBy.set(from, { frame: this.frame, amount: m.holes.length });
        }
        break;
      }
      case "board": {
        if (!from) break;
        const g = this.ensureRemote(from);
        // 스냅샷에는 이벤트가 실려 오지 않는다. 관전자에게 소리를 들려주려면
        // 적용 전후의 성적을 견줘 무슨 일이 있었는지 되짚는 수밖에 없다.
        const before = this.onRemoteBeat
          ? { lines: g.stats.lines, pieces: g.stats.piecesPlaced, attack: g.stats.attack, b2b: g.scoring.b2b, combo: g.scoring.combo }
          : null;
        g.deserialize(m.snap);
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
      case "focus": {
        if (!from) break;
        if (m.watching) this.watchers.add(from);
        else this.watchers.delete(from);
        break;
      }
    }
  }

  dispose(): void {
    this.watchers.clear();
    this.transport.close();
  }
}
