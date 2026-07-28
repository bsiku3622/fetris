import type { MultiTransport } from "./transport";
import type {
  ClientControl,
  ServerControl,
  GameMessage,
  RoomState,
  MatchConfig,
  PlayerRole,
} from "./protocol";

// ============================================================================
// NetClient — 릴레이 서버와의 연결을 감싸고, 방 상태를 하나의 진실로 들고 있다.
//
//  - 제어 메시지(방 상태·카운트다운·매치 시작/종료·KO)는 콜백으로 노출.
//  - 게임 메시지는 {t:"relay"}로 감싸 보내고, 수신 relay는 transport로 흘린다.
//  - 서버가 매치 진행을 소유하므로 클라이언트는 상태를 추측하지 않는다.
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
  /** 서버가 알려준 최신 방 상태 */
  room: RoomState | null = null;

  // 게임 메시지 채널(MultiTransport용)
  private msgCb: ((m: GameMessage, from?: string) => void) | null = null;
  private transportCloseCb: (() => void) | null = null;
  private playerLeftCb: ((id: string) => void) | null = null;
  private playerJoinedCb: ((id: string, isHost: boolean) => void) | null = null;
  /** 직전 로스터 — state 변화에서 입퇴장을 뽑아내기 위해 들고 있는다 */
  private lastRoster = new Set<string>();

  // 제어 이벤트
  onCreated?: (code: string) => void;
  onJoined?: (code: string) => void;
  /** 방 상태가 갱신될 때마다(입퇴장·준비·역할·설정·페이즈) */
  onRoomState?: (state: RoomState) => void;
  onCountdown?: (matchId: number, startsAt: number, seconds: number) => void;
  onMatchStart?: (matchId: number, seed: number, config: MatchConfig, players: string[]) => void;
  onKO?: (playerId: string, placement: number, remaining: number) => void;
  onMatchEnd?: (
    matchId: number,
    winnerId: string | null,
    standings: { playerId: string; placement: number }[],
  ) => void;
  onError?: (reason: string) => void;
  onDisconnect?: () => void;
  onBotPending?: (nick: string) => void;
  /** 앱 레벨에서 게임 메시지 엿보기(채팅 등). transport보다 먼저 호출된다. */
  onGameMessage?: (m: GameMessage, from?: string) => void;

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

  /** 로스터 변화를 transport 콜백(입퇴장)으로 환산한다 */
  private syncRoster(state: RoomState): void {
    const now = new Set(state.players.map((p) => p.id));
    for (const p of state.players) {
      if (!this.lastRoster.has(p.id) && p.id !== this.myId) {
        this.playerJoinedCb?.(p.id, p.isHost);
      }
    }
    for (const id of this.lastRoster) {
      if (!now.has(id)) this.playerLeftCb?.(id);
    }
    this.lastRoster = now;
  }

  private applyState(state: RoomState): void {
    this.room = state;
    this.syncRoster(state);
    this.onRoomState?.(state);
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
        this.applyState(msg.state);
        this.onCreated?.(msg.code);
        break;
      case "joined":
        this.myId = msg.myId;
        this.applyState(msg.state);
        this.onJoined?.(msg.code);
        break;
      case "state":
        this.applyState(msg.state);
        break;
      case "countdown":
        this.onCountdown?.(msg.matchId, msg.startsAt, msg.seconds);
        break;
      case "match-start":
        this.onMatchStart?.(msg.matchId, msg.seed, msg.config, msg.players);
        break;
      case "ko":
        this.onKO?.(msg.playerId, msg.placement, msg.remaining);
        break;
      case "match-end":
        this.onMatchEnd?.(msg.matchId, msg.winnerId, msg.standings);
        break;
      case "bot-pending":
        this.onBotPending?.(msg.nick);
        break;
      case "error":
        this.onError?.(msg.reason);
        break;
      case "relay":
        this.onGameMessage?.(msg.msg, msg.from);
        this.msgCb?.(msg.msg, msg.from);
        break;
    }
  }

  private sendControl(msg: ClientControl): void {
    if (this.ws && this.state === "open") this.ws.send(JSON.stringify(msg));
  }

  // ---- 방 ------------------------------------------------------------------

  createRoom(maxPlayers = 4, nick?: string): void {
    this.sendControl({ t: "create", maxPlayers, nick });
  }
  joinRoom(code: string, nick?: string): void {
    this.sendControl({ t: "join", code: code.toUpperCase().trim(), nick });
  }
  leaveRoom(): void {
    this.sendControl({ t: "leave" });
  }

  // ---- 매치 ----------------------------------------------------------------

  setReady(ready: boolean): void {
    this.sendControl({ t: "ready", ready });
  }
  setRole(role: PlayerRole): void {
    this.sendControl({ t: "set-role", role });
  }
  setConfig(config: MatchConfig): void {
    this.sendControl({ t: "config", config });
  }
  startMatch(): void {
    this.sendControl({ t: "start-match" });
  }
  /** 내가 톱아웃했다고 서버에 알린다 */
  reportKO(): void {
    this.sendControl({ t: "ko" });
  }
  submitReplay(matchId: number, frames: number, keys: number[], fingerprint: string): void {
    this.sendControl({ t: "replay", matchId, frames, keys, fingerprint });
  }

  // ---- 봇 ------------------------------------------------------------------

  addBot(nick?: string): void {
    this.sendControl({ t: "add-bot", nick });
  }
  kickBot(playerId: string): void {
    this.sendControl({ t: "kick-bot", playerId });
  }

  // ---- 게임 메시지 ---------------------------------------------------------

  sendGame(msg: GameMessage): void {
    this.sendControl({ t: "relay", msg });
  }
  sendGameTo(targetId: string, msg: GameMessage): void {
    this.sendControl({ t: "relay-to", targetId, msg });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.room = null;
    this.lastRoster.clear();
  }

  /** VersusMatch에 주입할 MultiTransport */
  transport(): MultiTransport {
    const client = this;
    return {
      get myId() {
        return client.myId ?? "";
      },
      send: (msg) => client.sendGame(msg),
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
