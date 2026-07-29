import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { verifyReplay } from "@fetris/engine/replay";
import type { Handling, RuleSet } from "@fetris/engine/types";
import { BotTokenStore } from "./botTokens.js";
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
//  - 방 상태 머신: lobby → playing → results → lobby
//  - 참가자 명단·역할(참가/관전)
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
  resultsTimer: ReturnType<typeof setTimeout> | null;
  /** 결과 화면이 끝나면 다음 판으로 이어갈지(FT 시리즈 진행 중) */
  nextRound: boolean;
  /** 시리즈가 끝났다 — 대기실로 돌아갈 때 승수를 지운다 */
  resetWins: boolean;
}

/** `/bot`에 붙어 초대를 기다리는 봇 러너(control-plane 연결) */
interface BotRunner {
  ws: WebSocket;
  id: string;
  name: string;
  capacity: number;
  /** 예약 + 착석 중인 봇 수 */
  active: number;
  /** 접속 토큰에 묶인 소유자 — 러너가 스스로 바꿀 수 없다 */
  owner: string;
  label?: string;
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
const HEARTBEAT_MS = 25_000;
/**
 * 이만큼 연속으로 pong이 없어야 끊는다. 1회로 두면 잠깐의 네트워크 순단이나
 * 탭이 백그라운드로 내려간 사이의 지연에도 방에서 튕겨나간다.
 */
const HEARTBEAT_MISS_LIMIT = 3;
const BOT_PATH = "/bot";
/** 초대 후 이 시간 안에 봇이 착석하지 않으면 예약을 해제한다 */
const BOT_JOIN_TIMEOUT_MS = 15_000;
const MAX_BOT_CAPACITY = 16;
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
  /** 단일 토큰(구식). 소유자 구분이 없어 botTokensPath를 권장한다. */
  botToken?: string;
  /**
   * 토큰별 소유자를 담은 JSON 파일 경로. 지정하면 봇 경로에 토큰이 필수가 된다.
   * 형식: { "tokens": [{ "token": "...", "owner": "이름", "label": "메모" }] }
   */
  botTokensPath?: string;
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
  const tokens = new BotTokenStore({
    path: opts.botTokensPath,
    legacyToken: opts.botToken,
  });
  const resultsMs = opts.resultsMs ?? RESULTS_MS;

  const rooms = new Map<string, Room>();
  const sockToPlayer = new Map<WebSocket, { room: Room; player: Player }>();
  const runners = new Map<WebSocket, BotRunner>();
  const pendingBots = new Map<string, PendingBot>();
  const botSockets = new WeakSet<WebSocket>();
  /** 소켓별 연속 pong 미수신 횟수(하트비트용) */
  const alive = new WeakMap<WebSocket, number>();

  const send = (ws: WebSocket, msg: ServerControl): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const runnerInfo = (r: BotRunner): BotRunnerInfo => ({
    id: r.id,
    name: r.name,
    capacity: r.capacity,
    active: r.active,
    owner: r.owner,
    label: r.label,
  });

  /** 봇 소켓에 확정된 소유자 — bot-hello 때 토큰에서 결정된다 */
  const socketOwner = new WeakMap<WebSocket, { owner: string; label?: string }>();

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
          authRequired: tokens.required,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  /*
    보드 스냅샷이 트래픽의 대부분이고, 연달아 오는 스냅샷은 서로 거의 같다.
    그래서 압축 컨텍스트를 연결 간에 유지하는 게 결정적이다 — 메시지별로만
    압축하면 3배 남짓이지만, 컨텍스트를 이어가면 같은 자료가 50배 이상 줄어든다.
    작은 제어 메시지는 압축 오버헤드가 더 크므로 threshold 아래로 흘려보낸다.
  */
  const wss = new WebSocketServer({
    server: http,
    perMessageDeflate: {
      threshold: 256,
      concurrencyLimit: 16,
      zlibDeflateOptions: { level: 3, memLevel: 8, chunkSize: 16 * 1024 },
      zlibInflateOptions: { chunkSize: 16 * 1024 },
      // 컨텍스트 유지를 우리 쪽에서 포기하지 않는다(상대가 요구하면 따른다)
      serverNoContextTakeover: false,
      clientNoContextTakeover: false,
    },
  });

  /**
   * 방 전체에 보낸다. 직렬화는 한 번만 한다 — 같은 객체를 수신자 수만큼 다시
   * JSON으로 만드는 건 인원이 늘수록 그대로 CPU 낭비가 된다(보드 스냅샷은 1KB가 넘는다).
   */
  const broadcast = (room: Room, msg: ServerControl, exclude?: WebSocket): void => {
    const data = JSON.stringify(msg);
    for (const p of room.players) {
      if (p.ws !== exclude && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
  };

  const playerInfoOf = (p: Player): PlayerInfo => ({
    id: p.id,
    nick: p.nick,
    isHost: p.isHost,
    isBot: p.isBot,
    botOwner: p.runner?.owner ?? (p.isBot ? socketOwner.get(p.ws)?.owner : undefined),
    role: p.role,
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

  /**
   * 정원은 **게임에 참가하는 인원**만 센다. 관전자는 자리를 차지하지 않으므로
   * 정원이 찬 방에도 얼마든지 들어와 구경할 수 있다.
   */
  const occupancy = (room: Room): number =>
    room.players.filter((p) => p.role === "player").length + room.reserved;

  /** maxPlayers가 0이면 제한 없음(기본값) */
  const isFull = (room: Room): boolean =>
    room.maxPlayers > 0 && occupancy(room) >= room.maxPlayers;

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
    if (room.resultsTimer) clearTimeout(room.resultsTimer);
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
    room.nextRound = false;
    room.participants = [];
    for (const p of room.players) {
      p.alive = true;
      p.placement = null;
      // 시리즈가 끝났으면 다음 시리즈를 0승부터 다시 시작한다
      if (room.resetWins) p.wins = 0;
    }
    room.resetWins = false;
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

    // 시리즈 목표(FT)에 도달했으면 이번 판으로 시리즈가 끝난다.
    // 다음 시리즈를 새로 시작할 수 있도록 모두의 승수를 초기화한다.
    const firstTo = room.config?.firstTo ?? 0;
    const seriesWinner = winner && firstTo > 0 && winner.wins >= firstTo ? winner : null;
    // 초기화는 대기실로 돌아갈 때 한다 — 여기서 지워버리면 결과 화면의 승수가
    // 이미 0이라 "3/3으로 이겼다"가 보이지 않는다.
    if (seriesWinner) room.resetWins = true;

    // 시리즈가 아직 끝나지 않았으면 다음 판을 서버가 이어서 연다.
    // FT는 "몇 판을 치른다"는 약속이므로, 매 판 호스트가 다시 시작을 눌러야
    // 한다면 목표를 걸어둔 의미가 없다.
    const nextRound =
      firstTo > 0 && !seriesWinner && rosterOf(room).length >= MIN_PARTICIPANTS;
    room.nextRound = nextRound;

    room.phase = "results";
    broadcast(room, {
      t: "match-end",
      matchId: room.matchId,
      winnerId: winner?.id ?? null,
      standings,
      nextRound,
      ...(seriesWinner ? { seriesWinnerId: seriesWinner.id } : {}),
    });
    broadcastState(room);
    room.resultsTimer = setTimeout(() => afterResults(room), resultsMs);
    room.resultsTimer.unref?.();
  };

  /**
   * 결과 화면이 끝났을 때 — 시리즈 도중이면 다음 판으로, 아니면 대기실로.
   * 그 사이 참가자가 빠져 인원이 모자라면 대기실로 떨어진다.
   */
  const afterResults = (room: Room): void => {
    if (room.nextRound && room.config && rosterOf(room).length >= MIN_PARTICIPANTS) {
      startMatch(room);
      return;
    }
    returnToLobby(room);
  };

  /**
   * 탈락 처리 — 라스트맨 스탠딩. 남은 생존자가 1명이면 그 사람이 우승,
   * 0명이면(동시 탈락) 승자 없이 끝난다.
   */
  const eliminate = (room: Room, player: Player): void => {
    if (room.phase !== "playing") return;
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

  /**
   * 매치를 연다. 카운트다운은 서버가 세지 않는다 — 엔진이 판을 열면서 자체
   * Ready 카운트다운을 돌리므로(보드는 떠 있고 입력만 잠긴다) 여기서 또 세면
   * 이중이 되고, 그동안 클라이언트는 보여줄 게 없어 화면이 멈춘 것처럼 보인다.
   */
  const startMatch = (room: Room): void => {
    clearTimers(room);
    room.matchId++;
    // 참가자 확정 — 이후 들어오는 사람은 관전자가 된다
    room.participants = rosterOf(room).map((p) => p.id);
    for (const p of room.players) {
      p.alive = room.participants.includes(p.id);
      p.placement = null;
    }
    const roster = participantsOf(room);
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

  // ---- 리플레이 검증 --------------------------------------------------------

  /**
   * 제출된 입력 로그를 서버가 직접 재현해 최종 상태 지문을 대조한다.
   * 어긋나면 제출자에게 알리고 로그를 남긴다(자동 제재는 하지 않는다 —
   * 오탐이 정상 플레이어를 쫓아내는 쪽이 더 나쁘다).
   *
   * 재현은 CPU를 쓰므로 이벤트 루프 밖으로 미룬다. sharePieces가 꺼져 있으면
   * 각자 다른 시드로 돌았기 때문에 서버가 재현할 근거가 없어 건너뛴다.
   *
   * 받은 가비지는 제출자가 함께 신고한다 — 서버는 게임 페이로드를 해석하지 않아
   * 대조할 원본이 없다. 즉 이 검증이 잡는 것은 "제출한 입력이 정말 그 결과를
   * 만드는가"까지이고, 가비지 신고 자체의 진위는 범위 밖이다.
   */
  const verifySubmittedReplay = (
    room: Room,
    player: Player,
    raw: Extract<ClientControl, { t: "replay" }>,
  ): void => {
    const config = room.config;
    if (!config) return;
    if (raw.matchId !== room.matchId) return;
    if (!Array.isArray(raw.keys) || typeof raw.fingerprint !== "string") return;
    const frames = Math.floor(Number(raw.frames));
    if (!Number.isFinite(frames) || frames <= 0 || frames > MAX_REPLAY_FRAMES) return;
    if (raw.keys.length > MAX_REPLAY_KEYS) return;
    const garbage = Array.isArray(raw.garbage) ? raw.garbage : [];
    if (garbage.length > MAX_REPLAY_KEYS) return;

    // 제출된 기록을 방에 그대로 흘려준다. 관전자는 자기 로그가 없어 남이 남긴
    // 것으로만 그 경기를 볼 수 있는데, 참가자가 검증 제출과 별개로 한 번 더
    // 나눠주기를 기다리면 그렇게 하지 않는 봇의 판은 영영 사라진다.
    // 검증에 이미 필요한 제출 하나로 배포까지 끝낸다.
    const submittedSeed = Math.floor(Number(raw.seed));
    // 감도는 개인 설정이므로 제출자가 실제로 쓴 값을 그대로 쓴다. 자기 신고이긴
    // 하지만 어차피 전부 정상 범위의 설정값이라 이걸로 얻는 이득은 없다.
    const handling = (raw.handling ?? config.handling) as Handling;
    broadcast(
      room,
      {
        t: "replay-record",
        matchId: raw.matchId,
        playerId: player.id,
        seed: Number.isFinite(submittedSeed) ? submittedSeed >>> 0 : room.seed,
        handling,
        frames,
        keys: raw.keys,
        garbage,
        fingerprint: raw.fingerprint,
        stats: raw.stats,
      },
      player.ws,
    );

    // 재현 대조는 모두가 같은 조각 순서를 받았을 때만 가능하다 —
    // 시드가 각자 다르면 서버에는 맞춰볼 근거가 없다.
    if (!config.sharePieces) return;

    const seed = room.seed;
    const nick = player.nick;
    const ws = player.ws;
    setImmediate(() => {
      try {
        const { ok, actual } = verifyReplay(
          {
            rule: config.rule as RuleSet,
            handling,
            seed,
            keys: raw.keys,
            garbage,
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
      room.phase === "playing" &&
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

  const runnerAvailable = (r: BotRunner): boolean =>
    r.active < r.capacity && r.ws.readyState === WebSocket.OPEN;

  /** 여유가 가장 많은 러너 선택(호스트가 지목하지 않았을 때) */
  const pickRunner = (): BotRunner | null => {
    let best: BotRunner | null = null;
    for (const r of runners.values()) {
      if (!runnerAvailable(r)) continue;
      if (!best || r.active < best.active) best = r;
    }
    return best;
  };

  /** 호스트가 지목한 러너 찾기 */
  const findRunner = (id: string): BotRunner | null => {
    for (const r of runners.values()) {
      if (r.id === id) return r;
    }
    return null;
  };

  const handle = (ws: WebSocket, raw: ClientControl): void => {
    switch (raw.t) {
      case "create": {
        // 기존 방에 있으면 먼저 나가기
        if (sockToPlayer.has(ws)) teardownPlayer(ws);
        const code = genCode(rooms);
        // 0 = 제한 없음(기본). 값을 주면 2~8로 clamp한다.
        const asked = raw.maxPlayers;
        const maxPlayers =
          asked === undefined || asked === null || asked <= 0
            ? 0
            : Math.min(8, Math.max(2, Math.floor(asked)));
        const playerId = genPlayerId();
        const isBot = botSockets.has(ws);
        const player: Player = {
          ws,
          id: playerId,
          isHost: true,
          nick: sanitizeNick(raw.nick),
          isBot,
          role: "player",
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
          resultsTimer: null,
          nextRound: false,
          resetWins: false,
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
        if (sockToPlayer.has(ws)) teardownPlayer(ws);

        const isBot = botSockets.has(ws);
        const nick = pending ? pending.nick : sanitizeNick(raw.nick);
        const runner = pending?.runner;
        if (pending) releasePending(pending);
        // 착석한 봇은 러너 점유를 유지한다(이탈 시 teardownPlayer가 해제)
        if (runner) runner.active++;

        const playerId = genPlayerId();
        // 매치 중이거나 참가 정원이 찼으면 관전자로 붙는다 — 입장 자체는 막지 않는다.
        // (티켓 입장은 이미 슬롯을 예약해 뒀으므로 정원 검사에서 제외)
        const midMatch = room.phase !== "lobby" || (!pending && isFull(room));
        const player: Player = {
          ws,
          id: playerId,
          isHost: false,
          nick,
          isBot,
          runner,
          role: midMatch ? "spectator" : "player",
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
      case "skip-results": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        // 결과 화면을 다 본 사람이 있으면 굳이 타이머를 기다리지 않는다
        if (entry.room.phase !== "results") return;
        clearTimers(entry.room);
        afterResults(entry.room);
        break;
      }
      case "abort-series": {
        // 호스트가 FT 시리즈를 중간에 접는다 — 승수를 지우고 대기실로 돌아간다
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        if (!entry.player.isHost) {
          send(ws, { t: "error", reason: "not-host" });
          return;
        }
        entry.room.nextRound = false;
        entry.room.resetWins = true;
        returnToLobby(entry.room);
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
        // 관전자 → 참가자 전환은 자리가 있어야 한다(관전은 언제나 가능)
        if (role === "player" && entry.player.role === "spectator" && isFull(entry.room)) {
          send(ws, { t: "error", reason: "room-full" });
          return;
        }
        entry.player.role = role;
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
        startMatch(room);
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
        if (isFull(room)) {
          send(ws, { t: "error", reason: "room-full" });
          return;
        }
        // 호스트가 특정 러너를 지목했으면 그 러너에게만 보낸다
        let runner: BotRunner | null;
        if (typeof raw.runnerId === "string" && raw.runnerId) {
          runner = findRunner(raw.runnerId);
          if (!runner) {
            send(ws, { t: "error", reason: "runner-not-found" });
            return;
          }
          if (!runnerAvailable(runner)) {
            send(ws, { t: "error", reason: "runner-busy" });
            return;
          }
        } else {
          runner = pickRunner();
        }
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
        // 소유자는 접속 토큰에서 이미 확정됐다 — 러너가 스스로 주장할 수 없다
        const identity = socketOwner.get(ws) ?? { owner: "anonymous" };
        const existing = runners.get(ws);
        const runner: BotRunner =
          existing ?? {
            ws,
            id: genRunnerId(),
            name,
            capacity,
            active: 0,
            owner: identity.owner,
            label: identity.label,
          };
        // 재등록이면 이름·정원만 갱신(진행 중인 봇 점유는 유지)
        runner.name = name;
        runner.capacity = capacity;
        runners.set(ws, runner);
        send(ws, { t: "bot-ready", runner: runnerInfo(runner) });
        break;
      }
      case "list-runners": {
        // 방에 있는 사람이면 누구나 볼 수 있다(부르는 건 호스트만)
        if (!sockToPlayer.has(ws)) return;
        send(ws, { t: "runners", runners: [...runners.values()].map(runnerInfo) });
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
      const query = (req.url ?? "").split("?")[1] ?? "";
      const token = new URLSearchParams(query).get("token") ?? "";
      const identity = tokens.verify(token);
      if (!identity) {
        send(ws, { t: "error", reason: "bot-auth-failed" });
        ws.close(4401, "bot-auth-failed");
        return;
      }
      // 소유자를 소켓에 못박는다 — 이후 러너가 무슨 이름을 대든 바뀌지 않는다
      socketOwner.set(ws, identity);
      botSockets.add(ws);
    }

    alive.set(ws, 0);
    ws.on("pong", () => alive.set(ws, 0));
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
      const missed = (alive.get(ws) ?? 0) + 1;
      if (missed >= HEARTBEAT_MISS_LIMIT) {
        ws.terminate();
        continue;
      }
      alive.set(ws, missed);
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
