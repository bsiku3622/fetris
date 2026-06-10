import { Game, EventType } from "../engine/game";
import type { GameEvent, InputCommands } from "../engine/game";
import type { Handling, RuleSet } from "../engine/types";
import type { MultiTransport } from "../net/transport";
import { Side, FALLBACK_PEER_ID } from "../net/protocol";
import type { GameMessage } from "../net/protocol";

// ============================================================================
// VersusMatch — Custom Room 대전의 헤드리스 코어(렌더/입력 비의존).
//  - local: 내가 조종하는 Game(시뮬 진행)
//  - remotes: 상대 플레이어들(playerId → Game). 스냅샷만 적용, 시뮬 안 함.
// 공격은 sender-authoritative: 내 Attack 이벤트 → currentTarget에게 송신.
// 수신 공격은 내 local에 가비지로 적재.
// 보드 스냅샷은 주기적으로 모두에게 브로드캐스트해 상대 화면을 갱신.
// ============================================================================

const SNAPSHOT_EVERY_FRAMES = 3;

export interface VersusOptions {
  rule: RuleSet;
  handling: Handling;
  seed: number;
  myAttackMul: number;
  side: Side;
  transport: MultiTransport;
}

export type MatchResult = "win" | "lose" | null;

export class VersusMatch {
  readonly local: Game;
  /** playerId → 상대 미러 Game */
  readonly remotes = new Map<string, Game>();
  /** 아직 Game이 없는 상대(스냅샷 수신 전)의 도착 순서 추적 */
  private remoteOrder: string[] = [];
  readonly side: Side;
  private transport: MultiTransport;
  private snapAccum = 0;
  result: MatchResult = null;

  /** 현재 공격 타겟 playerId. null이면 자동(첫 번째 살아있는 상대) */
  private currentTarget: string | null = null;

  onLocalEvents?: (events: GameEvent[]) => void;
  /** playerId별 보드 스냅샷 갱신 콜백 */
  onRemoteUpdate?: (playerId: string) => void;
  onResult?: (result: MatchResult) => void;
  /** 새 플레이어가 추가됐을 때(렌더러 등록용) */
  onPlayerAdded?: (playerId: string) => void;
  /** 플레이어가 이탈했을 때 */
  onPlayerRemoved?: (playerId: string) => void;

  constructor(opts: VersusOptions) {
    this.side = opts.side;
    this.local = new Game(opts.rule, opts.handling, opts.seed);
    this.local.attackMultiplier = opts.myAttackMul;
    this.transport = opts.transport;
    this.transport.onMessage((m, from) => this.onMessage(m, from));
    this.transport.onClose(() => {
      // 2인 대전: 상대 이탈 → 부전승
      if (this.remotes.size <= 1 && this.result === null) this.setResult("win");
    });
    this.transport.onPlayerLeft?.((playerId) => {
      this.remotes.delete(playerId);
      this.remoteOrder = this.remoteOrder.filter((id) => id !== playerId);
      this.onPlayerRemoved?.(playerId);
      this.checkWinCondition();
    });
    this.transport.onPlayerJoined?.((playerId, isHost) => {
      if (!this.remotes.has(playerId)) {
        const remote = new Game(opts.rule, opts.handling, opts.seed);
        this.remotes.set(playerId, remote);
        this.remoteOrder.push(playerId);
        this.onPlayerAdded?.(playerId);
        // 새 플레이어에게 내 보드 즉시 전송
        this.transport.sendTo(playerId, { t: "board", snap: this.local.serialize() });
      }
      void isHost;
    });
  }

  get primaryRemoteId(): string | null {
    return this.remoteOrder[0] ?? null;
  }

  get primaryRemote(): Game | null {
    const id = this.primaryRemoteId;
    return id ? (this.remotes.get(id) ?? null) : null;
  }

  setTarget(playerId: string | null): void {
    this.currentTarget = playerId;
  }

  private resolveTarget(): string | null {
    if (this.currentTarget && this.remotes.has(this.currentTarget)) return this.currentTarget;
    return this.remoteOrder[0] ?? null;
  }

  tick(dtFrames: number, cmd: InputCommands, now = 0): void {
    this.local.update(dtFrames, cmd, now);

    const evs = this.local.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.type === EventType.Attack && e.cells && e.cells.length > 0) {
        const targetId = this.resolveTarget();
        const msg: GameMessage = { t: "attack", holes: e.cells.slice(), targetId: targetId ?? undefined };
        // 새 서버(myId 있음)에선 타겟 지정 전송, 구버전 서버(myId 없음)에선 브로드캐스트
        if (targetId && this.transport.myId) {
          this.transport.sendTo(targetId, msg);
        } else {
          this.transport.send(msg);
        }
      }
    }
    this.onLocalEvents?.(evs);
    this.local.events.length = 0;

    if (this.local.isGameOver() && this.result === null) {
      this.transport.send({ t: "dead" });
      this.setResult("lose");
    }

    this.snapAccum += dtFrames;
    if (this.snapAccum >= SNAPSHOT_EVERY_FRAMES) {
      this.snapAccum = 0;
      this.transport.send({ t: "board", snap: this.local.serialize() });
    }
  }

  private onMessage(m: GameMessage, from?: string): void {
    switch (m.t) {
      case "attack": {
        // 나를 타겟으로 하거나, targetId가 없거나, 내 id를 모르는(구버전) 경우 수신
        const myId = this.transport.myId;
        if (!m.targetId || !myId || m.targetId === myId) {
          this.local.receiveGarbage({ holes: m.holes });
        }
        break;
      }
      case "board": {
        // 구버전 서버는 from을 안 보냄 → 단일 상대(FALLBACK_PEER_ID)로 취급
        const senderId = from ?? FALLBACK_PEER_ID;
        // 새 발신자면 remote Game 등록
        if (!this.remotes.has(senderId)) {
          const remote = new Game(this.local.rule, this.local.handling.h, this.local.seed);
          this.remotes.set(senderId, remote);
          this.remoteOrder.push(senderId);
          this.onPlayerAdded?.(senderId);
        }
        this.remotes.get(senderId)?.deserialize(m.snap);
        this.onRemoteUpdate?.(senderId);
        break;
      }
      case "dead": {
        // 발신자 제거(구버전은 from 없음 → 첫 상대 제거)
        const deadId = from ?? this.remoteOrder[0];
        if (deadId) {
          this.remotes.delete(deadId);
          this.remoteOrder = this.remoteOrder.filter((id) => id !== deadId);
          this.onPlayerRemoved?.(deadId);
        }
        this.checkWinCondition();
        break;
      }
    }
  }

  private checkWinCondition(): void {
    if (this.result !== null) return;
    if (this.remotes.size === 0) this.setResult("win");
  }

  private setResult(r: MatchResult): void {
    this.result = r;
    this.onResult?.(r);
  }

  dispose(): void {
    this.transport.close();
  }
}
