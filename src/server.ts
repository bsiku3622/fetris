import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import type { ClientControl, ServerControl } from "./protocol.js";

// ============================================================================
// Fetris 1대1 대전 릴레이 서버.
//  - 방 코드 기반 매칭(매치메이킹 없음): 호스트가 방을 만들고 게스트가 코드로 입장.
//  - sender-authoritative 릴레이: 게임 메시지는 내용 해석 없이 상대에게 그대로 전달.
//  - 한 방은 최대 2명. 누구든 나가면 방은 정리되고 상대에게 peer-left 통지.
// ============================================================================

interface Room {
  code: string;
  host: WebSocket;
  guest: WebSocket | null;
}

interface SockInfo {
  code: string;
  isHost: boolean;
}

// 헷갈리는 문자(0/O/1/I) 제외한 방 코드 알파벳
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
  // 극히 드문 충돌 폭주 — 길이를 늘려 회피
  return genCode(rooms) + CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
}

export interface RelayServer {
  http: Server;
  wss: WebSocketServer;
  /** 현재 활성 방 수(모니터링/테스트용) */
  roomCount(): number;
  close(): Promise<void>;
}

export function startServer(port: number): RelayServer {
  const rooms = new Map<string, Room>();
  const sockInfo = new Map<WebSocket, SockInfo>();
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

  const peerOf = (ws: WebSocket): WebSocket | null => {
    const info = sockInfo.get(ws);
    if (!info) return null;
    const room = rooms.get(info.code);
    if (!room) return null;
    return info.isHost ? room.guest : room.host;
  };

  /** 소켓이 속한 방을 정리하고 남은 상대에게 통지. 1대1이라 한 명이라도 나가면 방 종료. */
  const teardown = (ws: WebSocket): void => {
    const info = sockInfo.get(ws);
    if (!info) return;
    const room = rooms.get(info.code);
    sockInfo.delete(ws);
    if (!room) return;
    const peer = info.isHost ? room.guest : room.host;
    if (peer && peer !== ws) {
      send(peer, { t: "peer-left" });
      sockInfo.delete(peer);
    }
    rooms.delete(info.code);
  };

  const handle = (ws: WebSocket, raw: ClientControl): void => {
    switch (raw.t) {
      case "create": {
        // 이미 방에 속해 있으면 먼저 정리(중복 생성 방지)
        if (sockInfo.has(ws)) teardown(ws);
        const code = genCode(rooms);
        rooms.set(code, { code, host: ws, guest: null });
        sockInfo.set(ws, { code, isHost: true });
        send(ws, { t: "created", code });
        break;
      }
      case "join": {
        const code = String(raw.code ?? "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { t: "error", reason: "room-not-found" });
          return;
        }
        if (room.guest) {
          send(ws, { t: "error", reason: "room-full" });
          return;
        }
        room.guest = ws;
        sockInfo.set(ws, { code, isHost: false });
        send(ws, { t: "joined", code, asHost: false });
        send(room.host, { t: "peer-joined" });
        break;
      }
      case "relay": {
        const peer = peerOf(ws);
        if (peer) send(peer, { t: "relay", msg: raw.msg });
        break;
      }
      case "leave": {
        teardown(ws);
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
        return; // 잘못된 JSON은 무시
      }
      if (msg && typeof msg.t === "string") handle(ws, msg);
    });
    ws.on("close", () => teardown(ws));
    ws.on("error", () => teardown(ws));
  });

  // 죽은 연결 감지(끊긴 소켓이 방을 점유하는 것 방지)
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
