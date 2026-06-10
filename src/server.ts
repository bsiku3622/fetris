import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import type { ClientControl, ServerControl, PlayerInfo } from "./protocol.js";

// ============================================================================
// Fetris Custom Room 릴레이 서버 — N인 멀티플레이어 지원.
//  - 방 코드 기반 매칭. 호스트가 방 생성, 참가자가 코드로 입장.
//  - sender-authoritative 릴레이: 게임 메시지를 내용 해석 없이 중계.
//  - relay: 발신자 제외 방 전체 브로드캐스트.
//  - relay-to: 특정 플레이어(targetId)에게만 전달.
//  - 플레이어가 나가면 방은 유지, 마지막 인원이 나가면 방 삭제.
//  - 호스트 이탈 시 다음 플레이어가 호스트 승계.
// ============================================================================

let _idCounter = 0;
function genPlayerId(): string {
  return `p${(++_idCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

interface Player {
  ws: WebSocket;
  id: string;
  isHost: boolean;
  nick: string;
}

interface Room {
  code: string;
  players: Player[];
  maxPlayers: number;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 4;
const HEARTBEAT_MS = 30_000;

function genCode(rooms: Map<string, Room>): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LEN; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return genCode(rooms) + CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
}

export interface RelayServer {
  http: Server;
  wss: WebSocketServer;
  roomCount(): number;
  close(): Promise<void>;
}

export function startServer(port: number): RelayServer {
  const rooms = new Map<string, Room>();
  const sockToPlayer = new Map<WebSocket, { room: Room; player: Player }>();
  const alive = new WeakMap<WebSocket, boolean>();

  const http = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: http });

  const send = (ws: WebSocket, msg: ServerControl): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const broadcast = (room: Room, msg: ServerControl, exclude?: WebSocket): void => {
    for (const p of room.players) {
      if (p.ws !== exclude) send(p.ws, msg);
    }
  };

  const playerInfoOf = (p: Player): PlayerInfo => ({ id: p.id, isHost: p.isHost, nick: p.nick });

  const sanitizeNick = (n: unknown): string => {
    const s = typeof n === "string" ? n.trim().slice(0, 16) : "";
    return s.length > 0 ? s : "Player";
  };

  const teardownPlayer = (ws: WebSocket): void => {
    const entry = sockToPlayer.get(ws);
    if (!entry) return;
    sockToPlayer.delete(ws);
    const { room, player } = entry;
    room.players = room.players.filter((p) => p !== player);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    // 호스트가 나갔으면 첫 번째 남은 플레이어가 호스트 승계
    if (player.isHost && room.players.length > 0) {
      room.players[0].isHost = true;
    }

    broadcast(room, { t: "peer-left", playerId: player.id });
  };

  const handle = (ws: WebSocket, raw: ClientControl): void => {
    switch (raw.t) {
      case "create": {
        // 기존 방에 있으면 먼저 나가기
        if (sockToPlayer.has(ws)) teardownPlayer(ws);
        const code = genCode(rooms);
        const maxPlayers = Math.min(8, Math.max(2, (raw.maxPlayers ?? 4)));
        const playerId = genPlayerId();
        const player: Player = { ws, id: playerId, isHost: true, nick: sanitizeNick(raw.nick) };
        const room: Room = { code, players: [player], maxPlayers };
        rooms.set(code, room);
        sockToPlayer.set(ws, { room, player });
        send(ws, { t: "created", code, myId: playerId });
        break;
      }
      case "join": {
        const code = String(raw.code ?? "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { t: "error", reason: "room-not-found" });
          return;
        }
        if (room.players.length >= room.maxPlayers) {
          send(ws, { t: "error", reason: "room-full" });
          return;
        }
        if (sockToPlayer.has(ws)) teardownPlayer(ws);
        const playerId = genPlayerId();
        const player: Player = { ws, id: playerId, isHost: false, nick: sanitizeNick(raw.nick) };
        room.players.push(player);
        sockToPlayer.set(ws, { room, player });
        const currentPlayers = room.players.filter((p) => p !== player).map(playerInfoOf);
        send(ws, { t: "joined", code, myId: playerId, players: currentPlayers });
        broadcast(room, { t: "peer-joined", player: playerInfoOf(player) }, ws);
        break;
      }
      case "relay": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        broadcast(entry.room, { t: "relay", from: entry.player.id, msg: raw.msg }, ws);
        break;
      }
      case "relay-to": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        const target = entry.room.players.find((p) => p.id === raw.targetId);
        if (target) send(target.ws, { t: "relay", from: entry.player.id, msg: raw.msg });
        break;
      }
      case "leave": {
        teardownPlayer(ws);
        break;
      }
    }
  };

  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data) => {
      let msg: ClientControl;
      try {
        msg = JSON.parse(data.toString()) as ClientControl;
      } catch {
        return;
      }
      if (msg && typeof msg.t === "string") handle(ws, msg);
    });
    ws.on("close", () => teardownPlayer(ws));
    ws.on("error", () => teardownPlayer(ws));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  http.listen(port);

  return {
    http,
    wss,
    roomCount: () => rooms.size,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}
