import type { Transport } from "./transport";
import type { ClientControl, ServerControl, GameMessage } from "./protocol";

// ============================================================================
// NetClient — 브라우저 WebSocket으로 릴레이 서버에 붙어 방 생성/입장을 처리하고,
// VersusMatch가 쓸 Transport(게임 메시지 채널)를 제공한다.
//  - 제어 메시지(create/join/leave)는 콜백으로 노출.
//  - 게임 메시지는 {t:"relay"}로 감싸 보내고, 수신 relay는 transport로 흘린다.
// ============================================================================

/** 빌드 환경변수에서 기본 서버 URL을 읽되, 없으면 로컬 개발 서버로 폴백 */
function defaultUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_FETRIS_WS_URL || "ws://localhost:8787";
}

export type ConnState = "idle" | "connecting" | "open" | "closed";

export class NetClient {
  private ws: WebSocket | null = null;
  private url: string;
  state: ConnState = "idle";

  // 게임 메시지 채널(Transport용)
  private msgCb: ((m: GameMessage) => void) | null = null;
  private transportCloseCb: (() => void) | null = null;

  // 제어 이벤트
  onCreated?: (code: string) => void;
  onJoined?: (code: string, asHost: boolean) => void;
  onPeerJoined?: () => void;
  onPeerLeft?: () => void;
  onError?: (reason: string) => void;
  onDisconnect?: () => void;
  /** 앱 레벨에서 게임 메시지를 엿보기(룰 핸드셰이크 등). transport보다 먼저 호출됨. */
  onGameMessage?: (m: GameMessage) => void;

  constructor(url?: string) {
    this.url = url || defaultUrl();
  }

  /** 서버에 연결. open 되면 resolve. */
  connect(): Promise<void> {
    if (this.ws && this.state === "open") return Promise.resolve();
    this.state = "connecting";
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.state = "open";
        resolve();
      };
      ws.onerror = () => {
        if (this.state === "connecting") reject(new Error("서버 연결 실패"));
      };
      ws.onclose = () => {
        this.state = "closed";
        this.transportCloseCb?.();
        this.onDisconnect?.();
      };
      ws.onmessage = (ev) => this.onServerMessage(ev.data);
    });
  }

  private onServerMessage(data: unknown): void {
    let msg: ServerControl;
    try {
      msg = JSON.parse(String(data)) as ServerControl;
    } catch {
      return;
    }
    switch (msg.t) {
      case "created":
        this.onCreated?.(msg.code);
        break;
      case "joined":
        this.onJoined?.(msg.code, msg.asHost);
        break;
      case "peer-joined":
        this.onPeerJoined?.();
        break;
      case "peer-left":
        this.transportCloseCb?.();
        this.onPeerLeft?.();
        break;
      case "error":
        this.onError?.(msg.reason);
        break;
      case "relay":
        this.onGameMessage?.(msg.msg);
        this.msgCb?.(msg.msg);
        break;
    }
  }

  private sendControl(msg: ClientControl): void {
    if (this.ws && this.state === "open") this.ws.send(JSON.stringify(msg));
  }

  createRoom(): void {
    this.sendControl({ t: "create" });
  }
  /** 게임 메시지를 상대에게 중계(룰 핸드셰이크 등 앱 레벨 송신용) */
  sendGame(msg: GameMessage): void {
    this.sendControl({ t: "relay", msg });
  }
  joinRoom(code: string): void {
    this.sendControl({ t: "join", code: code.toUpperCase().trim() });
  }
  leaveRoom(): void {
    this.sendControl({ t: "leave" });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  /** VersusMatch에 주입할 게임 메시지 Transport */
  transport(): Transport {
    return {
      send: (msg) => this.sendControl({ t: "relay", msg }),
      onMessage: (cb) => {
        this.msgCb = cb;
      },
      onClose: (cb) => {
        this.transportCloseCb = cb;
      },
      // 매치 종료 시 채널만 분리한다. 방(연결)은 재대결을 위해 유지.
      close: () => {
        this.msgCb = null;
        this.transportCloseCb = null;
      },
    };
  }
}
