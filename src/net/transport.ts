import type { GameMessage } from "./protocol";

// ============================================================================
// Transport — 대전 게임 메시지의 양방향 채널 추상화.
// VersusMatch는 Transport에만 의존하므로, 실제 WebSocket이든 로컬 루프백이든
// 동일하게 동작한다(서버 없이 테스트·로컬 대전 가능).
// ============================================================================

export interface Transport {
  /** 상대에게 게임 메시지 전송 */
  send(msg: GameMessage): void;
  /** 상대 메시지 수신 콜백 등록. from = 발신자 playerId (N인에서 사용) */
  onMessage(cb: (msg: GameMessage, from?: string) => void): void;
  /** 연결 종료 콜백 등록 */
  onClose(cb: () => void): void;
  /** 채널 닫기 */
  close(): void;
}

/** N인 대전 Transport — myId, sendTo(특정 플레이어에게), 이탈 콜백 지원 */
export interface MultiTransport extends Transport {
  readonly myId: string;
  /** targetId 플레이어에게만 메시지 전달 */
  sendTo(targetId: string, msg: GameMessage): void;
  /** 특정 플레이어가 이탈했을 때 콜백 (playerId 전달) */
  onPlayerLeft(cb: (playerId: string) => void): void;
  /** 새 플레이어가 입장했을 때 콜백 (playerId, isHost 전달) */
  onPlayerJoined(cb: (playerId: string, isHost: boolean) => void): void;
}

/** 메시지를 직접 상대 엔드포인트로 전달하는 인메모리 채널(테스트/로컬 대전용) */
class LoopbackTransport implements MultiTransport {
  peer!: LoopbackTransport;
  readonly myId: string;
  private msgCb: ((msg: GameMessage, from?: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private playerLeftCb: ((id: string) => void) | null = null;
  private closed = false;

  constructor(myId: string) {
    this.myId = myId;
  }

  private deliver(msg: GameMessage): void {
    if (this.closed || !this.peer) return;
    // 네트워크처럼 직렬화 왕복을 거쳐 참조 공유 버그를 차단
    const copy = JSON.parse(JSON.stringify(msg)) as GameMessage;
    // 비동기로 전달(실제 네트워크 유사) — 단, 테스트 결정성을 위해 동기 호출
    this.peer.msgCb?.(copy, this.myId);
  }

  send(msg: GameMessage): void {
    this.deliver(msg);
  }
  sendTo(_targetId: string, msg: GameMessage): void {
    // 루프백은 상대가 1명뿐이라 타겟 무관하게 peer로 전달
    this.deliver(msg);
  }
  onMessage(cb: (msg: GameMessage, from?: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onPlayerLeft(cb: (id: string) => void): void {
    this.playerLeftCb = cb;
  }
  onPlayerJoined(_cb: (id: string, isHost: boolean) => void): void {
    // 루프백은 peer가 이미 연결돼 있어 입장 이벤트가 없음(no-op)
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer?.closeCb?.();
    this.peer?.playerLeftCb?.(this.myId);
  }
}

/** 서로 연결된 두 Transport 엔드포인트를 생성(로컬 2인 대전·테스트) */
export function createLoopbackPair(): [MultiTransport, MultiTransport] {
  const a = new LoopbackTransport("A");
  const b = new LoopbackTransport("B");
  a.peer = b;
  b.peer = a;
  return [a, b];
}
