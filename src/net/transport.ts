import type { GameMessage } from "./protocol";

// ============================================================================
// Transport — 대전 게임 메시지의 양방향 채널 추상화.
// VersusMatch는 Transport에만 의존하므로, 실제 WebSocket이든 로컬 루프백이든
// 동일하게 동작한다(서버 없이 테스트·로컬 대전 가능).
// ============================================================================

export interface Transport {
  /** 상대에게 게임 메시지 전송 */
  send(msg: GameMessage): void;
  /** 상대 메시지 수신 콜백 등록 */
  onMessage(cb: (msg: GameMessage) => void): void;
  /** 연결 종료 콜백 등록 */
  onClose(cb: () => void): void;
  /** 채널 닫기 */
  close(): void;
}

/** 메시지를 직접 상대 엔드포인트로 전달하는 인메모리 채널(테스트/로컬 대전용) */
class LoopbackTransport implements Transport {
  peer!: LoopbackTransport;
  private msgCb: ((msg: GameMessage) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private closed = false;

  send(msg: GameMessage): void {
    if (this.closed || !this.peer) return;
    // 네트워크처럼 직렬화 왕복을 거쳐 참조 공유 버그를 차단
    const copy = JSON.parse(JSON.stringify(msg)) as GameMessage;
    // 비동기로 전달(실제 네트워크 유사) — 단, 테스트 결정성을 위해 동기 호출
    this.peer.msgCb?.(copy);
  }
  onMessage(cb: (msg: GameMessage) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.peer?.closeCb?.();
  }
}

/** 서로 연결된 두 Transport 엔드포인트를 생성(로컬 2인 대전·테스트) */
export function createLoopbackPair(): [Transport, Transport] {
  const a = new LoopbackTransport();
  const b = new LoopbackTransport();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
