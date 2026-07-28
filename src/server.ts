import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { ClientControl, ServerControl, PlayerInfo, BotRunnerInfo } from "./protocol.js";

// ============================================================================
// Fetris Custom Room 릴레이 서버 — N인 멀티플레이어 지원.
//  - 방 코드 기반 매칭. 호스트가 방 생성, 참가자가 코드로 입장.
//  - sender-authoritative 릴레이: 게임 메시지를 내용 해석 없이 중계.
//  - relay: 발신자 제외 방 전체 브로드캐스트.
//  - relay-to: 특정 플레이어(targetId)에게만 전달.
//  - 플레이어가 나가면 방은 유지, 마지막 인원이 나가면 방 삭제.
//  - 호스트 이탈 시 다음 플레이어가 호스트 승계(사람 우선).
//
// 봇 엔드포인트 — WS 경로 `/bot` (사람 클라이언트는 `/`):
//  - 서버는 봇을 실행하지 않는다. 외부 봇 러너가 `/bot`에 붙어 대기하고,
//    호스트의 add-bot 요청을 받으면 서버가 티켓과 함께 러너를 초대한다.
//  - 봇도 결국 일반 참가자로 앉으므로 게임 로직은 여전히 클라이언트 몫이다.
//  - botToken이 설정되면 `/bot?token=...`이 일치해야 연결이 유지된다.
// ============================================================================

let _idCounter = 0;
function genPlayerId(): string {
  return `p${(++_idCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function genRunnerId(): string {
  return `r${(++_idCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

interface Player {
  ws: WebSocket;
  id: string;
  isHost: boolean;
  nick: string;
  isBot: boolean;
  /** 이 봇을 보낸 러너(초대로 앉은 경우) — 이탈 시 점유 해제용 */
  runner?: BotRunner;
}

interface Room {
  code: string;
  players: Player[];
  maxPlayers: number;
  /** add-bot으로 잡아둔 미착석 슬롯 수 */
  reserved: number;
}

/** `/bot`에 붙어 초대를 기다리는 봇 러너(control-plane 연결) */
interface BotRunner {
  ws: WebSocket;
  id: string;
  name: string;
  capacity: number;
  /** 예약 + 착석 중인 봇 수 */
  active: number;
}

/** add-bot으로 발급했으나 아직 착석하지 않은 초대 */
interface PendingBot {
  ticket: string;
  room: Room;
  runner: BotRunner;
  nick: string;
  requestedBy: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 4;
const HEARTBEAT_MS = 30_000;
const BOT_PATH = "/bot";
/** 초대 후 이 시간 안에 봇이 착석하지 않으면 예약을 해제한다 */
const BOT_JOIN_TIMEOUT_MS = 15_000;
const MAX_BOT_CAPACITY = 16;

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

export interface RelayServerOptions {
  /** 설정하면 `/bot?token=...`이 일치하는 연결만 봇으로 받아들인다 */
  botToken?: string;
}

export interface RelayServer {
  http: Server;
  wss: WebSocketServer;
  roomCount(): number;
  /** 대기 중인 봇 러너 수 */
  botRunnerCount(): number;
  close(): Promise<void>;
}

export function startServer(port: number, opts: RelayServerOptions = {}): RelayServer {
  const botToken = opts.botToken?.trim() || "";
  const rooms = new Map<string, Room>();
  const sockToPlayer = new Map<WebSocket, { room: Room; player: Player }>();
  const runners = new Map<WebSocket, BotRunner>();
  const pendingBots = new Map<string, PendingBot>();
  const botSockets = new WeakSet<WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();

  const send = (ws: WebSocket, msg: ServerControl): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const runnerInfo = (r: BotRunner): BotRunnerInfo => ({
    id: r.id,
    name: r.name,
    capacity: r.capacity,
    active: r.active,
  });

  const http = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    // 봇 러너 가용성 확인용(운영/디버그). 방 정보는 노출하지 않는다.
    if (path === "/bots") {
      const list = [...runners.values()].map(runnerInfo);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          runners: list,
          idle: list.filter((r) => r.active < r.capacity).length,
          authRequired: botToken.length > 0,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: http });

  const broadcast = (room: Room, msg: ServerControl, exclude?: WebSocket): void => {
    for (const p of room.players) {
      if (p.ws !== exclude) send(p.ws, msg);
    }
  };

  const playerInfoOf = (p: Player): PlayerInfo => ({
    id: p.id,
    isHost: p.isHost,
    nick: p.nick,
    isBot: p.isBot,
  });

  const occupancy = (room: Room): number => room.players.length + room.reserved;

  const sanitizeNick = (n: unknown, fallback = "Player"): string => {
    const s = typeof n === "string" ? n.trim().slice(0, 16) : "";
    return s.length > 0 ? s : fallback;
  };

  /** 봇 기본 닉 — 방 안에서 겹치지 않게 번호를 붙인다 */
  const botNick = (room: Room, requested: unknown): string => {
    const asked = typeof requested === "string" ? requested.trim().slice(0, 16) : "";
    if (asked) return asked;
    return `Bot ${room.players.filter((p) => p.isBot).length + room.reserved + 1}`;
  };

  const releasePending = (pending: PendingBot): void => {
    clearTimeout(pending.timer);
    pendingBots.delete(pending.ticket);
    pending.room.reserved = Math.max(0, pending.room.reserved - 1);
    pending.runner.active = Math.max(0, pending.runner.active - 1);
  };

  /** 조건에 맞는 미착석 초대를 모두 취소 */
  const cancelPending = (match: (p: PendingBot) => boolean): void => {
    for (const pending of [...pendingBots.values()]) {
      if (match(pending)) releasePending(pending);
    }
  };

  /** 사람이 모두 나간 방은 남은 봇까지 정리하고 삭제 */
  const closeRoomIfAbandoned = (room: Room): void => {
    if (room.players.some((p) => !p.isBot)) return;
    const leftover = room.players;
    room.players = [];
    for (const p of leftover) {
      sockToPlayer.delete(p.ws);
      if (p.runner) p.runner.active = Math.max(0, p.runner.active - 1);
      p.ws.close(1000, "room-closed");
    }
    cancelPending((pending) => pending.room === room);
    rooms.delete(room.code);
  };

  const teardownPlayer = (ws: WebSocket): void => {
    const entry = sockToPlayer.get(ws);
    if (!entry) return;
    sockToPlayer.delete(ws);
    const { room, player } = entry;
    room.players = room.players.filter((p) => p !== player);
    if (player.runner) player.runner.active = Math.max(0, player.runner.active - 1);

    if (room.players.length === 0) {
      cancelPending((pending) => pending.room === room);
      rooms.delete(room.code);
      return;
    }

    // 호스트가 나갔으면 남은 사람 중 첫 번째가 승계(봇은 후순위)
    if (player.isHost) {
      const heir = room.players.find((p) => !p.isBot) ?? room.players[0];
      heir.isHost = true;
    }

    broadcast(room, { t: "peer-left", playerId: player.id });
    closeRoomIfAbandoned(room);
  };

  /** 러너 연결이 끊기면 등록 해제 + 그 러너 앞으로 남은 초대 취소 */
  const teardownRunner = (ws: WebSocket): void => {
    const runner = runners.get(ws);
    if (!runner) return;
    runners.delete(ws);
    cancelPending((pending) => pending.runner === runner);
  };

  /** 여유가 가장 많은 러너 선택 */
  const pickRunner = (): BotRunner | null => {
    let best: BotRunner | null = null;
    for (const r of runners.values()) {
      if (r.active >= r.capacity) continue;
      if (r.ws.readyState !== WebSocket.OPEN) continue;
      if (!best || r.active < best.active) best = r;
    }
    return best;
  };

  const handle = (ws: WebSocket, raw: ClientControl): void => {
    switch (raw.t) {
      case "create": {
        // 기존 방에 있으면 먼저 나가기
        if (sockToPlayer.has(ws)) teardownPlayer(ws);
        const code = genCode(rooms);
        const maxPlayers = Math.min(8, Math.max(2, (raw.maxPlayers ?? 4)));
        const playerId = genPlayerId();
        const isBot = botSockets.has(ws);
        const player: Player = {
          ws,
          id: playerId,
          isHost: true,
          nick: sanitizeNick(raw.nick),
          isBot,
        };
        const room: Room = { code, players: [player], maxPlayers, reserved: 0 };
        rooms.set(code, room);
        sockToPlayer.set(ws, { room, player });
        send(ws, { t: "created", code, myId: playerId });
        break;
      }
      case "join": {
        const ticket = typeof raw.ticket === "string" ? raw.ticket : "";
        let pending: PendingBot | null = null;
        if (ticket) {
          if (!botSockets.has(ws)) {
            send(ws, { t: "error", reason: "bot-path-required" });
            return;
          }
          const found = pendingBots.get(ticket);
          if (!found) {
            send(ws, { t: "error", reason: "invalid-ticket" });
            return;
          }
          pending = found;
        }

        const code = pending ? pending.room.code : String(raw.code ?? "").toUpperCase();
        const room = pending ? pending.room : rooms.get(code);
        if (!room || !rooms.has(room.code)) {
          if (pending) releasePending(pending);
          send(ws, { t: "error", reason: "room-not-found" });
          return;
        }
        // 티켓 입장은 이미 잡아둔 예약 슬롯을 쓰므로 정원 검사에서 제외
        if (!pending && occupancy(room) >= room.maxPlayers) {
          send(ws, { t: "error", reason: "room-full" });
          return;
        }
        if (sockToPlayer.has(ws)) teardownPlayer(ws);

        const isBot = botSockets.has(ws);
        const nick = pending ? pending.nick : sanitizeNick(raw.nick);
        const runner = pending?.runner;
        if (pending) releasePending(pending);
        // 착석한 봇은 러너 점유를 유지한다(이탈 시 teardownPlayer가 해제)
        if (runner) runner.active++;

        const playerId = genPlayerId();
        const player: Player = { ws, id: playerId, isHost: false, nick, isBot, runner };
        room.players.push(player);
        sockToPlayer.set(ws, { room, player });
        const currentPlayers = room.players.filter((p) => p !== player).map(playerInfoOf);
        send(ws, { t: "joined", code: room.code, myId: playerId, players: currentPlayers });
        broadcast(room, { t: "peer-joined", player: playerInfoOf(player) }, ws);
        break;
      }
      case "add-bot": {
        const entry = sockToPlayer.get(ws);
        if (!entry) {
          send(ws, { t: "error", reason: "not-in-room" });
          return;
        }
        if (!entry.player.isHost) {
          send(ws, { t: "error", reason: "not-host" });
          return;
        }
        const room = entry.room;
        if (occupancy(room) >= room.maxPlayers) {
          send(ws, { t: "error", reason: "room-full" });
          return;
        }
        const runner = pickRunner();
        if (!runner) {
          send(ws, { t: "error", reason: "no-bot-available" });
          return;
        }
        const nick = botNick(room, raw.nick);
        const ticket = randomUUID();
        room.reserved++;
        runner.active++;
        const timer = setTimeout(() => {
          const stale = pendingBots.get(ticket);
          if (!stale) return;
          releasePending(stale);
          send(stale.requestedBy, { t: "error", reason: "bot-join-timeout" });
        }, BOT_JOIN_TIMEOUT_MS);
        timer.unref?.();
        pendingBots.set(ticket, { ticket, room, runner, nick, requestedBy: ws, timer });
        send(runner.ws, { t: "bot-invite", code: room.code, ticket, nick });
        send(ws, { t: "bot-pending", ticket, nick, runnerId: runner.id });
        break;
      }
      case "kick-bot": {
        const entry = sockToPlayer.get(ws);
        if (!entry || !entry.player.isHost) {
          send(ws, { t: "error", reason: "not-host" });
          return;
        }
        const target = entry.room.players.find((p) => p.id === raw.playerId);
        if (!target || !target.isBot) {
          send(ws, { t: "error", reason: "not-a-bot" });
          return;
        }
        teardownPlayer(target.ws);
        target.ws.close(1000, "kicked");
        break;
      }
      case "bot-hello": {
        if (!botSockets.has(ws)) {
          send(ws, { t: "error", reason: "bot-path-required" });
          return;
        }
        if (sockToPlayer.has(ws)) {
          send(ws, { t: "error", reason: "already-in-room" });
          return;
        }
        const capacity = Math.min(
          MAX_BOT_CAPACITY,
          Math.max(1, Math.floor(Number(raw.capacity)) || 1),
        );
        const name = sanitizeNick(raw.name, "Bot Runner");
        const existing = runners.get(ws);
        const runner: BotRunner = existing ?? { ws, id: genRunnerId(), name, capacity, active: 0 };
        // 재등록이면 이름·정원만 갱신(진행 중인 봇 점유는 유지)
        runner.name = name;
        runner.capacity = capacity;
        runners.set(ws, runner);
        send(ws, { t: "bot-ready", runner: runnerInfo(runner) });
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

  wss.on("connection", (ws: WebSocket, req) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === BOT_PATH || path === `${BOT_PATH}/`) {
      if (botToken) {
        const query = (req.url ?? "").split("?")[1] ?? "";
        const token = new URLSearchParams(query).get("token") ?? "";
        if (token !== botToken) {
          send(ws, { t: "error", reason: "bot-auth-failed" });
          ws.close(4401, "bot-auth-failed");
          return;
        }
      }
      botSockets.add(ws);
    }

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
    ws.on("close", () => {
      teardownPlayer(ws);
      teardownRunner(ws);
    });
    ws.on("error", () => {
      teardownPlayer(ws);
      teardownRunner(ws);
    });
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
    botRunnerCount: () => runners.size,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const pending of [...pendingBots.values()]) clearTimeout(pending.timer);
        pendingBots.clear();
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}
