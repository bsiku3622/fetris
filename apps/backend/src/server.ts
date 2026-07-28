import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { verifyReplay } from "@fetris/engine/replay";
import type { Handling, RuleSet } from "@fetris/engine/types";
import type {
  ClientControl,
  ServerControl,
  PlayerInfo,
  PlayerRole,
  BotRunnerInfo,
  MatchConfig,
  RoomPhase,
  RoomState,
} from "./protocol.js";

// ============================================================================
// Fetris 릴레이 서버 — 방 관리 + 서버 권위 매치 진행.
//
// 서버가 소유하는 것
//  - 방 상태 머신: lobby → countdown → playing → results → lobby
//  - 참가자 명단·역할(참가/관전)·준비 상태
//  - 라스트맨 스탠딩 판정: KO 순서로 순위를 매기고 마지막 1인이 우승
//  - 방에 머무는 동안의 누적 승수
//
// 서버가 모르는 것
//  - 보드 내용, 가비지 계산, 시드로 무엇이 나오는지
//  - relay/relay-to 페이로드는 해석 없이 그대로 중계(sender-authoritative)
//
// KO는 자기 신고다. 서버는 보드를 모르므로 검증할 수 없고, 리플레이 검증이
// 붙기 전까지는 신고를 그대로 믿는다.
//
// 봇 엔드포인트 — WS 경로 `/bot` (사람 클라이언트는 `/`):
//  외부 봇 러너가 붙어 대기하고, 호스트의 add-bot에 서버가 티켓을 발급해
//  초대하면 봇이 참가자 슬롯에 착석한다. 서버는 봇을 실행하지 않는다.
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
  role: PlayerRole;
  ready: boolean;
  alive: boolean;
  placement: number | null;
  wins: number;
}

interface Room {
  code: string;
  players: Player[];
  maxPlayers: number;
  /** add-bot으로 잡아둔 미착석 슬롯 수 */
  reserved: number;
  phase: RoomPhase;
  config: MatchConfig | null;
  matchId: number;
  /** 이번 매치에 참가한 플레이어 id (시작 시점에 확정) */
  participants: string[];
  /** 이번 매치 시드 — 리플레이 검증에 쓴다 */
  seed: number;
  countdownTimer: ReturnType<typeof setTimeout> | null;
  resultsTimer: ReturnType<typeof setTimeout> | null;
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
/** 카운트다운 길이 — 클라는 이 시간 동안 보드를 띄우고 입력만 잠근다 */
const COUNTDOWN_SECONDS = 3;
/** 순위표를 보여주고 대기실로 돌아가기까지 */
const RESULTS_MS = 6000;
const MIN_PARTICIPANTS = 2;
/** 리플레이 재현 상한 — 악의적으로 거대한 로그를 보내 서버를 묶는 걸 막는다 */
const MAX_REPLAY_FRAMES = 60 * 60 * 30; // 30분(60Hz 기준)
const MAX_REPLAY_KEYS = 3 * 200_000;

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
  /** 카운트다운 길이(초). 테스트에서 줄여 쓴다. */
  countdownSeconds?: number;
  /** 순위표 표시 시간(ms). 테스트에서 줄여 쓴다. */
  resultsMs?: number;
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
  const countdownSeconds = opts.countdownSeconds ?? COUNTDOWN_SECONDS;
  const resultsMs = opts.resultsMs ?? RESULTS_MS;

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
    nick: p.nick,
    isHost: p.isHost,
    isBot: p.isBot,
    role: p.role,
    ready: p.ready,
    alive: p.alive,
    placement: p.placement,
    wins: p.wins,
  });

  const stateOf = (room: Room): RoomState => ({
    code: room.code,
    phase: room.phase,
    maxPlayers: room.maxPlayers,
    players: room.players.map(playerInfoOf),
    config: room.config,
    matchId: room.matchId,
  });

  const broadcastState = (room: Room): void => {
    broadcast(room, { t: "state", state: stateOf(room) });
  };

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

  // ---- 매치 상태 머신 -------------------------------------------------------

  const clearTimers = (room: Room): void => {
    if (room.countdownTimer) clearTimeout(room.countdownTimer);
    if (room.resultsTimer) clearTimeout(room.resultsTimer);
    room.countdownTimer = null;
    room.resultsTimer = null;
  };

  /** 이번 매치를 뛰는(뛴) 플레이어들 */
  const participantsOf = (room: Room): Player[] =>
    room.participants
      .map((id) => room.players.find((p) => p.id === id))
      .filter((p): p is Player => !!p);

  /** 다음 매치에 참가할 자격이 있는 플레이어(관전자 제외) */
  const rosterOf = (room: Room): Player[] => room.players.filter((p) => p.role === "player");

  /** 대기실로 되돌리고 다음 판을 위해 준비 상태를 초기화한다 */
  const returnToLobby = (room: Room): void => {
    clearTimers(room);
    room.phase = "lobby";
    room.participants = [];
    for (const p of room.players) {
      p.alive = true;
      p.placement = null;
      // 봇은 언제나 준비됨. 사람은 매 판 다시 눌러야 한다.
      p.ready = p.isBot;
    }
    broadcastState(room);
  };

  const endMatch = (room: Room, winner: Player | null): void => {
    clearTimers(room);
    if (winner) {
      winner.placement = 1;
      winner.alive = false;
      winner.wins++;
    }
    const standings = participantsOf(room)
      .filter((p) => p.placement !== null)
      .sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99))
      .map((p) => ({ playerId: p.id, placement: p.placement as number }));

    room.phase = "results";
    broadcast(room, {
      t: "match-end",
      matchId: room.matchId,
      winnerId: winner?.id ?? null,
      standings,
    });
    broadcastState(room);
    room.resultsTimer = setTimeout(() => returnToLobby(room), resultsMs);
    room.resultsTimer.unref?.();
  };

  /**
   * 탈락 처리 — 라스트맨 스탠딩. 남은 생존자가 1명이면 그 사람이 우승,
   * 0명이면(동시 탈락) 승자 없이 끝난다.
   */
  const eliminate = (room: Room, player: Player): void => {
    if (room.phase !== "playing" && room.phase !== "countdown") return;
    if (!room.participants.includes(player.id)) return;
    if (!player.alive) return;

    player.alive = false;
    const total = room.participants.length;
    const dead = participantsOf(room).filter((p) => !p.alive).length;
    // 첫 탈락자가 꼴찌 → 탈락 순서의 역순으로 순위가 매겨진다
    player.placement = total - dead + 1;

    const survivors = participantsOf(room).filter((p) => p.alive);
    broadcast(room, {
      t: "ko",
      playerId: player.id,
      placement: player.placement,
      remaining: survivors.length,
    });

    if (survivors.length <= 1) {
      endMatch(room, survivors[0] ?? null);
    } else {
      broadcastState(room);
    }
  };

  const startMatch = (room: Room): void => {
    clearTimers(room);
    const roster = participantsOf(room);
    // 카운트다운 도중 이탈로 인원이 무너졌으면 대기실로 되돌린다
    if (roster.length < MIN_PARTICIPANTS) {
      returnToLobby(room);
      return;
    }
    room.phase = "playing";
    room.seed = (Math.random() * 0xffffffff) >>> 0;
    broadcast(room, {
      t: "match-start",
      matchId: room.matchId,
      seed: room.seed,
      config: room.config as MatchConfig,
      players: room.participants.slice(),
    });
    broadcastState(room);
  };

  const beginCountdown = (room: Room): void => {
    clearTimers(room);
    room.matchId++;
    room.phase = "countdown";
    // 참가자 확정 — 이후 들어오는 사람은 관전자가 된다
    room.participants = rosterOf(room).map((p) => p.id);
    for (const p of room.players) {
      p.alive = room.participants.includes(p.id);
      p.placement = null;
    }
    const startsAt = Date.now() + countdownSeconds * 1000;
    broadcast(room, {
      t: "countdown",
      matchId: room.matchId,
      startsAt,
      seconds: countdownSeconds,
    });
    broadcastState(room);
    room.countdownTimer = setTimeout(() => startMatch(room), countdownSeconds * 1000);
    room.countdownTimer.unref?.();
  };

  // ---- 리플레이 검증 --------------------------------------------------------

  /**
   * 제출된 입력 로그를 서버가 직접 재현해 최종 상태 지문을 대조한다.
   * 어긋나면 제출자에게 알리고 로그를 남긴다(자동 제재는 하지 않는다 —
   * 오탐이 정상 플레이어를 쫓아내는 쪽이 더 나쁘다).
   *
   * 재현은 CPU를 쓰므로 이벤트 루프 밖으로 미룬다. sharePieces가 꺼져 있으면
   * 각자 다른 시드로 돌았기 때문에 서버가 재현할 근거가 없어 건너뛴다.
   */
  const verifySubmittedReplay = (
    room: Room,
    player: Player,
    raw: Extract<ClientControl, { t: "replay" }>,
  ): void => {
    const config = room.config;
    if (!config || !config.sharePieces) return;
    if (raw.matchId !== room.matchId) return;
    if (!Array.isArray(raw.keys) || typeof raw.fingerprint !== "string") return;
    const frames = Math.floor(Number(raw.frames));
    if (!Number.isFinite(frames) || frames <= 0 || frames > MAX_REPLAY_FRAMES) return;
    if (raw.keys.length > MAX_REPLAY_KEYS) return;

    const seed = room.seed;
    const nick = player.nick;
    const ws = player.ws;
    setImmediate(() => {
      try {
        const { ok, actual } = verifyReplay(
          {
            rule: config.rule as RuleSet,
            handling: config.handling as Handling,
            seed,
            keys: raw.keys,
            frames,
            simRate: config.simRate,
          },
          raw.fingerprint,
        );
        if (!ok) {
          console.warn(
            `[fetris-be] 리플레이 불일치 — room=${room.code} player=${nick} ` +
              `expected=${raw.fingerprint} actual=${actual}`,
          );
          send(ws, { t: "error", reason: "replay-mismatch" });
        }
      } catch (err) {
        console.warn(`[fetris-be] 리플레이 재현 실패 — room=${room.code} player=${nick}:`, err);
      }
    });
  };

  // ---- 방 수명 -------------------------------------------------------------

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
    clearTimers(room);
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
    const wasParticipant =
      (room.phase === "playing" || room.phase === "countdown") &&
      room.participants.includes(player.id) &&
      player.alive;

    room.players = room.players.filter((p) => p !== player);
    if (player.runner) player.runner.active = Math.max(0, player.runner.active - 1);

    if (room.players.length === 0) {
      clearTimers(room);
      cancelPending((pending) => pending.room === room);
      rooms.delete(room.code);
      return;
    }

    // 호스트가 나갔으면 남은 사람 중 첫 번째가 승계(봇은 후순위)
    if (player.isHost) {
      const heir = room.players.find((p) => !p.isBot) ?? room.players[0];
      heir.isHost = true;
    }

    // 매치 중 이탈은 탈락으로 처리 — 이미 명단에서 빠졌으므로 직접 정산한다
    if (wasParticipant) {
      const survivors = participantsOf(room).filter((p) => p.alive);
      broadcast(room, { t: "ko", playerId: player.id, placement: 0, remaining: survivors.length });
      if (survivors.length <= 1) {
        endMatch(room, survivors[0] ?? null);
        closeRoomIfAbandoned(room);
        return;
      }
    }

    broadcastState(room);
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
        const maxPlayers = Math.min(8, Math.max(2, raw.maxPlayers ?? 4));
        const playerId = genPlayerId();
        const isBot = botSockets.has(ws);
        const player: Player = {
          ws,
          id: playerId,
          isHost: true,
          nick: sanitizeNick(raw.nick),
          isBot,
          role: "player",
          ready: isBot,
          alive: true,
          placement: null,
          wins: 0,
        };
        const room: Room = {
          code,
          players: [player],
          maxPlayers,
          reserved: 0,
          phase: "lobby",
          config: null,
          matchId: 0,
          participants: [],
          seed: 0,
          countdownTimer: null,
          resultsTimer: null,
        };
        rooms.set(code, room);
        sockToPlayer.set(ws, { room, player });
        send(ws, { t: "created", code, myId: playerId, state: stateOf(room) });
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
        // 매치가 진행 중이면 관전자로 붙고 다음 판부터 참가한다
        const midMatch = room.phase !== "lobby";
        const player: Player = {
          ws,
          id: playerId,
          isHost: false,
          nick,
          isBot,
          runner,
          role: midMatch ? "spectator" : "player",
          ready: isBot && !midMatch,
          alive: false,
          placement: null,
          wins: 0,
        };
        room.players.push(player);
        sockToPlayer.set(ws, { room, player });
        send(ws, { t: "joined", code: room.code, myId: playerId, state: stateOf(room) });
        broadcastState(room);
        break;
      }
      case "ready": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        if (entry.room.phase !== "lobby") {
          send(ws, { t: "error", reason: "not-in-lobby" });
          return;
        }
        if (entry.player.role !== "player") {
          send(ws, { t: "error", reason: "spectator-cannot-ready" });
          return;
        }
        entry.player.ready = !!raw.ready;
        broadcastState(entry.room);
        break;
      }
      case "set-role": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        if (entry.room.phase !== "lobby") {
          send(ws, { t: "error", reason: "not-in-lobby" });
          return;
        }
        const role: PlayerRole = raw.role === "spectator" ? "spectator" : "player";
        entry.player.role = role;
        if (role === "spectator") entry.player.ready = false;
        broadcastState(entry.room);
        break;
      }
      case "config": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        if (!entry.player.isHost) {
          send(ws, { t: "error", reason: "not-host" });
          return;
        }
        if (entry.room.phase !== "lobby") {
          send(ws, { t: "error", reason: "not-in-lobby" });
          return;
        }
        if (!raw.config || typeof raw.config !== "object") {
          send(ws, { t: "error", reason: "bad-config" });
          return;
        }
        entry.room.config = raw.config;
        // 설정이 바뀌면 준비를 물린다 — 모르는 룰로 시작하는 걸 막는다
        for (const p of entry.room.players) if (!p.isBot) p.ready = false;
        broadcastState(entry.room);
        break;
      }
      case "start-match": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        const room = entry.room;
        if (!entry.player.isHost) {
          send(ws, { t: "error", reason: "not-host" });
          return;
        }
        if (room.phase !== "lobby") {
          send(ws, { t: "error", reason: "not-in-lobby" });
          return;
        }
        if (!room.config) {
          send(ws, { t: "error", reason: "no-config" });
          return;
        }
        const roster = rosterOf(room);
        if (roster.length < MIN_PARTICIPANTS) {
          send(ws, { t: "error", reason: "not-enough-players" });
          return;
        }
        if (roster.some((p) => !p.ready)) {
          send(ws, { t: "error", reason: "not-everyone-ready" });
          return;
        }
        beginCountdown(room);
        break;
      }
      case "ko": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        eliminate(entry.room, entry.player);
        break;
      }
      case "replay": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        verifySubmittedReplay(entry.room, entry.player, raw);
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
        if (room.phase !== "lobby") {
          send(ws, { t: "error", reason: "not-in-lobby" });
          return;
        }
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
        for (const room of rooms.values()) clearTimers(room);
        for (const pending of [...pendingBots.values()]) clearTimeout(pending.timer);
        pendingBots.clear();
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}
