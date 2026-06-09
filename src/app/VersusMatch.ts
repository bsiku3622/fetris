import { Game, EventType } from "../engine/game";
import type { GameEvent, InputCommands } from "../engine/game";
import type { Handling, RuleSet } from "../engine/types";
import type { Transport } from "../net/transport";
import { Side } from "../net/protocol";
import type { GameMessage } from "../net/protocol";

// ============================================================================
// VersusMatch — 1대1 대전의 헤드리스 코어(렌더/입력 비의존).
//  - local: 내가 조종하는 Game(시뮬 진행)
//  - remote: 상대 화면을 그리기 위한 미러 Game(스냅샷만 적용, 시뮬 안 함)
// 공격은 sender-authoritative: 내 Attack 이벤트 → 상대에게 송신, 수신 공격은
// 내 local에 가비지로 적재. 보드 스냅샷은 주기적으로 송신해 상대 화면을 갱신.
// UI(VersusSession)는 onLocalEvents로 이펙트/사운드를 처리한다.
// ============================================================================

/** 약 20Hz로 보드 스냅샷 송신(60Hz 기준 3프레임마다) */
const SNAPSHOT_EVERY_FRAMES = 3;

export interface VersusOptions {
  rule: RuleSet;
  handling: Handling;
  seed: number;
  /** 내 쪽 공격 배수(플레이어별 핸디캡) */
  myAttackMul: number;
  /** 내가 P1(좌)인지 P2(우)인지 — 렌더 컬러 구분용 */
  side: Side;
  transport: Transport;
}

export type MatchResult = "win" | "lose" | null;

export class VersusMatch {
  readonly local: Game;
  readonly remote: Game;
  readonly side: Side;
  private transport: Transport;
  private snapAccum = 0;
  result: MatchResult = null;
  /** 상대가 아직 접속해 있는지 */
  peerConnected = true;

  /** UI 이펙트/사운드용 — 매 tick에 로컬 이벤트를 넘긴다(클리어 전에 호출) */
  onLocalEvents?: (events: GameEvent[]) => void;
  /** 상대 보드 스냅샷이 갱신될 때(리렌더 트리거용) */
  onRemoteUpdate?: () => void;
  /** 승패가 확정될 때 */
  onResult?: (result: MatchResult) => void;

  constructor(opts: VersusOptions) {
    this.side = opts.side;
    this.local = new Game(opts.rule, opts.handling, opts.seed);
    this.local.attackMultiplier = opts.myAttackMul;
    // 상대 미러: 같은 룰로 만들되 시뮬은 돌리지 않고 deserialize로만 갱신
    this.remote = new Game(opts.rule, opts.handling, opts.seed);
    this.transport = opts.transport;
    this.transport.onMessage((m) => this.onMessage(m));
    this.transport.onClose(() => {
      this.peerConnected = false;
      // 대전 중 상대 이탈 → 부전승
      if (this.result === null) this.setResult("win");
    });
  }

  /** 한 시뮬 틱 진행 + 네트워크 동기화 */
  tick(dtFrames: number, cmd: InputCommands, now = 0): void {
    this.local.update(dtFrames, cmd, now);

    // 로컬 이벤트 처리: 공격 포워드 → UI 이펙트 → 비우기
    const evs = this.local.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.type === EventType.Attack && e.cells && e.cells.length > 0) {
        this.transport.send({ t: "attack", holes: e.cells.slice() });
      }
    }
    this.onLocalEvents?.(evs);
    this.local.events.length = 0;

    // 게임오버 → 상대에게 통지(내가 졌음)
    if (this.local.isGameOver() && this.result === null) {
      this.transport.send({ t: "dead" });
      this.setResult("lose");
    }

    // 주기적 보드 스냅샷 송신
    this.snapAccum += dtFrames;
    if (this.snapAccum >= SNAPSHOT_EVERY_FRAMES) {
      this.snapAccum = 0;
      this.transport.send({ t: "board", snap: this.local.serialize() });
    }
  }

  private onMessage(m: GameMessage): void {
    switch (m.t) {
      case "attack":
        this.local.receiveGarbage({ holes: m.holes });
        break;
      case "board":
        this.remote.deserialize(m.snap);
        this.onRemoteUpdate?.();
        break;
      case "dead":
        // 상대가 죽음 → 내 승리
        if (this.result === null) this.setResult("win");
        break;
    }
  }

  private setResult(r: MatchResult): void {
    this.result = r;
    this.onResult?.(r);
  }

  dispose(): void {
    this.transport.close();
  }
}
