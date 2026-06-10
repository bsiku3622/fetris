import type { MultiTransport } from "./transport";
import type { ClientControl, ServerControl, GameMessage } from "./protocol";
import type { PlayerInfo } from "./protocol";

// ============================================================================
// NetClient — 브라우저 WebSocket으로 릴레이 서버에 붙어 방 생성/입장을 처리하고,
// VersusMatch가 쓸 MultiTransport(게임 메시지 채널)를 제공한다.
//  - 제어 메시지(create/join/leave)는 콜백으로 노출.
//  - 게임 메시지는 {t:"relay"}로 감싸 보내고, 수신 relay는 transport로 흘린다.
//  - relay-to: 특정 플레이어(targetId)에게만 전송.
// ============================================================================

function defaultUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_FETRIS_WS_URL || "ws://localhost:8787";
}

export type ConnState = "idle" | "connecting" | "open" | "closed";

export class NetClient {
  private ws: WebSocket | null = null;
  private url: string;
  state: ConnState = "idle";

  myId: string | null = null;

  // 게임 메시지 채널(MultiTransport용)
  private msgCb: ((m: GameMessage, from?: string) => void) | null = null;
  private transportCloseCb: (() => void) | null = null;
  private playerLeftCb: ((id: string) => void) | null = null;
  private playerJoinedCb: ((id: string, isHost: boolean) => void) | null = null;

  // 제어 이벤트
  onCreated?: (code: string) => void;
  onJoined?: (code: string, asHost: boolean) => void;
  onPeerJoined?: () => void;
  onPeerLeft?: () => void;
  onError?: (reason: string) => void;
  onDisconnect?: () => void;
  onPlayerList?: (players: PlayerInfo[]) => void;
  onPeerJoinedFull?: (player: PlayerInfo) => void;
  onPeerLeftById?: (playerId: string) => void;
  /** 앱 레벨에서 게임 메시지를 엿보기(룰 핸드셰이크 등). transport보다 먼저 호출됨. */
  onGameMessage?: (m: GameMessage) => void;

  constructor(url?: string) {
    this.url = url || defaultUrl();
  }

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
        this.myId = msg.myId;
        this.onCreated?.(msg.code);
        break;
      case "joined":
        this.myId = msg.myId;
        this.onPlayerList?.(msg.players);
        this.onJoined?.(msg.code, false);
        break;
      case "peer-joined":
        this.onPeerJoined?.();
        this.onPeerJoinedFull?.(msg.player);
        this.playerJoinedCb?.(msg.player.id, msg.player.isHost);
        break;
      case "peer-left":
        this.transportCloseCb?.();
        this.onPeerLeft?.();
        this.onPeerLeftById?.(msg.playerId);
        this.playerLeftCb?.(msg.playerId);
        break;
      case "error":
        this.onError?.(msg.reason);
        break;
      case "relay":
        this.onGameMessage?.(msg.msg);
        this.msgCb?.(msg.msg, msg.from);
        break;
    }
  }

  private sendControl(msg: ClientControl): void {
    if (this.ws && this.state === "open") this.ws.send(JSON.stringify(msg));
  }

  createRoom(maxPlayers = 4, nick?: string): void {
    this.sendControl({ t: "create", maxPlayers, nick });
  }
  sendGame(msg: GameMessage): void {
    this.sendControl({ t: "relay", msg });
  }
  sendGameTo(targetId: string, msg: GameMessage): void {
    this.sendControl({ t: "relay-to", targetId, msg });
  }
  joinRoom(code: string, nick?: string): void {
    this.sendControl({ t: "join", code: code.toUpperCase().trim(), nick });
  }
  leaveRoom(): void {
    this.sendControl({ t: "leave" });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  /** VersusMatch에 주입할 MultiTransport */
  transport(): MultiTransport {
    const client = this;
    return {
      get myId() {
        return client.myId ?? "";
      },
      send: (msg) => client.sendControl({ t: "relay", msg }),
      sendTo: (targetId, msg) => client.sendGameTo(targetId, msg),
      onMessage: (cb) => {
        client.msgCb = cb;
      },
      onClose: (cb) => {
        client.transportCloseCb = cb;
      },
      onPlayerLeft: (cb) => {
        client.playerLeftCb = cb;
      },
      onPlayerJoined: (cb) => {
        client.playerJoinedCb = cb;
      },
      close: () => {
        client.msgCb = null;
        client.transportCloseCb = null;
        client.playerLeftCb = null;
        client.playerJoinedCb = null;
      },
    };
  }
}
