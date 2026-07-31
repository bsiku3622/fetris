import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { verifyReplay } from "@fetris/engine/replay";
import { shapeOf } from "@fetris/engine/pieces";
import type { Handling, RuleSet } from "@fetris/engine/types";
import { BotTokenStore } from "./botTokens.js";
import type {
  ClientControl,
  ServerControl,
  PlayerInfo,
  PlayerRole,
  BotRunnerInfo,
  MatchConfig,
  PlanGhost,
  RoomPhase,
  RoomState,
  GameMessage,
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
  /**
   * 이 자리로 되돌아올 때 쓰는 비밀 값. 소켓이 끊겨도 이 토큰이 있으면
   * 같은 자리에 다시 앉을 수 있다.
   */
  session: string;
  connected: boolean;
  /** 유예 안에 안 돌아오면 탈락시키는 타이머 */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** 이 사람에게 보낸 마지막 메시지 번호 */
  outId: number;
  /**
   * 최근에 보낸 제어 메시지 — resume 때 빠진 것만 다시 보낸다.
   * 중계와 따로 두는 이유는, 판이 도는 중에는 입력 스트림이 초당 백 개 넘게
   * 흐르기 때문이다. 한 통에 섞으면 놓치면 안 되는 KO·매치 종료가 게임
   * 트래픽에 밀려 통째로 빠져버린다.
   */
  outControl: { id: number; data: string }[];
  /** 최근에 중계한 게임 페이로드 */
  outRelay: { id: number; data: string }[];
  /** 이 사람에게서 마지막으로 처리한 메시지 번호 */
  inId: number;
  isHost: boolean;
  nick: string;
  isBot: boolean;
  /** 이 봇을 보낸 러너(초대로 앉은 경우) — 이탈 시 점유 해제용 */
  runner?: BotRunner;
  role: PlayerRole;
  alive: boolean;
  placement: number | null;
  wins: number;
  /**
   * 이 사람이 쓰는 감도. 서버는 내용을 해석하지 않고 매치 시작 때 방에 실어
   * 보내기만 한다 — 남들이 이 사람 보드를 입력만으로 따라 돌리는 데 필요하다.
   */
  handling: unknown;
  /** 이번 매치에서 이 사람에게 배정한 시드 */
  seed: number;
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
  /** 진행 중인 판의 녹화(서버가 중계하며 그대로 받아 적는다) */
  recording: Recording | null;
  /** 방금 끝난 판의 녹화 — 다음 판이 시작될 때까지 보관한다 */
  lastRecording: MatchRecording | null;
  /**
   * playerId → 표시 전용 계획 고스트. 서버가 들고 있는 이유는 셋이다 —
   * 개별 삭제, 그 자리에 조각이 놓였을 때 자동 정리, 판 종료 시 정리.
   * 게임 상태와는 무관하다(시뮬레이션·검증 어디에도 쓰이지 않는다).
   */
  plans: Map<string, PlanGhost[]>;
}

/** 녹화 중 버퍼 */
interface Recording {
  matchId: number;
  startedAt: number;
  bytes: number;
  truncated: boolean;
  frames: RecordedFrame[];
  /** playerId → 중계하며 받아 적은 입력 스트림 */
  streams: Map<string, RecordedStream>;
  /**
   * 판을 시작할 때의 참가자 명단.
   *
   * 방을 떠난 사람은 `room.players`에서 사라지므로, 끝나고 명단을 다시 훑으면
   * 중간에 나간 참가자가 통째로 빠진다 — 그 사람 판도 분명히 있었는데 기록에는
   * 없는 셈이 된다. 그래서 시작 시점에 박아둔다.
   */
  roster: { id: string; nick: string; isBot: boolean }[];
}

/**
 * 참가자 한 명의 입력 로그 — 중계하는 김에 그대로 받아 적은 것이다.
 *
 * 이게 있으면 판을 60Hz로 정확히 되살릴 수 있다. 예전에는 참가자가 끝나고
 * 따로 제출해줘야만 그게 가능했고, 안 내는 참가자(리플레이를 지원하지 않는
 * 봇, 중간에 나간 사람)의 판은 성긴 스냅샷으로만 남았다.
 */
interface RecordedStream {
  seed: number;
  handling: unknown;
  /** [frame, action, down, ...] */
  keys: number[];
  /** [frame, n, ...holes, ...] */
  ige: number[];
  /** 발신자가 "여기까지는 빠짐없이 보냈다"고 알린 마지막 경계 */
  frames: number;
}

/** 시간축 위의 한 장면 — 페이로드는 해석하지 않고 그대로 담는다 */
interface RecordedFrame {
  /** 판 시작 후 경과 ms */
  ms: number;
  /** 누구 것인지 */
  id: string;
  /** 보드 스냅샷 */
  snap?: unknown;
  /** 표시 전용 계획 고스트(빈 배열이면 지움) */
  plan?: unknown;
}

/** 내보낼 수 있는 형태로 굳힌 녹화 */
interface MatchRecording {
  matchId: number;
  code: string;
  startedAt: number;
  winnerId: string | null;
  /** 입력 스트림을 흘린 참가자는 그 로그가 함께 실린다 */
  players: {
    id: string;
    nick: string;
    placement: number | null;
    isBot: boolean;
    seed?: number;
    handling?: unknown;
    keys?: number[];
    garbage?: number[];
    frames?: number;
  }[];
  truncated: boolean;
  frames: RecordedFrame[];
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
/**
 * 소켓이 끊긴 참가자의 자리를 잡아두는 시간. 순단으로 판에서 밀려나지 않게
 * 하려는 것이고, 이 안에 resume하지 못하면 그때 탈락 처리한다.
 */
const DISCONNECT_GRACE_MS = 15_000;
/** resume 때 되돌려줄 수 있는 최근 제어 메시지 수 */
const RESUME_CONTROL_BUFFER = 256;
/**
 * 중계 페이로드 쪽 상한. 8인 방이면 입력 스트림만 초당 백 개가 넘게 오가므로
 * 자리 유예(15초)를 덮으려면 이 정도가 필요하다. 여기서 잘린 구간은 상태
 * 키프레임이 도착할 때 한 번에 메워진다.
 */
const RESUME_RELAY_BUFFER = 2048;
/** 리플레이 재현 상한 — 악의적으로 거대한 로그를 보내 서버를 묶는 걸 막는다 */
const MAX_REPLAY_FRAMES = 60 * 60 * 30; // 30분(60Hz 기준)
const MAX_REPLAY_KEYS = 3 * 200_000;
/**
 * 녹화 상한. 판 하나를 통째로 들고 있어야 하므로 방마다 이만큼까지만 받아 적고,
 * 넘으면 거기서 멈춘다(판이 깨지는 것보다 뒷부분이 잘리는 게 낫다).
 */
const MAX_RECORDING_BYTES = 12 * 1024 * 1024;

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
  /** 끊긴 참가자의 자리를 잡아두는 시간(ms). 테스트에서 줄여 쓴다. */
  graceMs?: number;
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
  const graceMs = opts.graceMs ?? DISCONNECT_GRACE_MS;

  /** 새로 앉는 사람의 세션 관련 초기값 */
  const newSessionFields = () => ({
    session: randomUUID(),
    connected: true,
    graceTimer: null,
    outId: 0,
    outControl: [] as { id: number; data: string }[],
    outRelay: [] as { id: number; data: string }[],
    inId: 0,
    handling: undefined as unknown,
    seed: 0,
  });

  const rooms = new Map<string, Room>();
  const sockToPlayer = new Map<WebSocket, { room: Room; player: Player }>();
  /** 세션 토큰 → 그 자리. 끊긴 사람이 되돌아올 때 찾는다 */
  const sessions = new Map<string, { room: Room; player: Player }>();
  const runners = new Map<WebSocket, BotRunner>();
  const pendingBots = new Map<string, PendingBot>();
  const botSockets = new WeakSet<WebSocket>();
  /** 소켓별 연속 pong 미수신 횟수(하트비트용) */
  const alive = new WeakMap<WebSocket, number>();

  /**
   * 한 사람에게 보낸다. 자리가 있는 사람에게는 증가하는 번호를 붙이고 최근 것을
   * 남겨둔다 — 끊겼다 붙었을 때 빠진 것만 다시 보내기 위해서다.
   */
  const send = (ws: WebSocket, msg: ServerControl): void => {
    const entry = sockToPlayer.get(ws);
    if (!entry) {
      // 아직 자리가 없는 소켓(입장 전·봇 러너)은 번호 없이 그냥 보낸다
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      return;
    }
    sendToPlayer(entry.player, msg);
  };

  const sendToPlayer = (player: Player, msg: ServerControl): void => {
    const stamped = { ...msg, id: ++player.outId };
    const data = JSON.stringify(stamped);
    const relay = msg.t === "relay";
    const buf = relay ? player.outRelay : player.outControl;
    buf.push({ id: stamped.id, data });
    const cap = relay ? RESUME_RELAY_BUFFER : RESUME_CONTROL_BUFFER;
    if (buf.length > cap) buf.shift();
    if (player.connected && player.ws.readyState === WebSocket.OPEN) player.ws.send(data);
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
    for (const p of room.players) {
      if (p.ws !== exclude) sendToPlayer(p, msg);
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
    connected: p.connected,
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

  // ---- 계획 고스트(표시 전용) -----------------------------------------------

  const MAX_PLAN_GHOSTS = 32;

  /** 계획이 바뀌면 방에 알리고 녹화에도 남긴다 */
  const publishPlan = (room: Room, playerId: string): void => {
    const ghosts = room.plans.get(playerId) ?? [];
    broadcast(room, { t: "plan-state", playerId, ghosts });
    recordPlan(room, playerId, ghosts);
  };

  /** 계획을 통째로 비운다(판 시작·종료처럼 화면을 정리해야 할 때) */
  const clearPlans = (room: Room): void => {
    if (room.plans.size === 0) return;
    const ids = [...room.plans.keys()];
    room.plans.clear();
    for (const id of ids) publishPlan(room, id);
  };

  /**
   * 그 자리에 조각이 실제로 놓였으면 계획을 걷어낸다.
   *
   * 여기서만 게임 페이로드를 들여다본다 — 보드 스냅샷의 그리드를 읽어 고스트가
   * 차지한 칸이 전부 메워졌는지 본다. 다 메워졌다면 계획은 이미 실행됐거나
   * 무의미해진 것이라 화면에 남겨둘 이유가 없다.
   */
  const prunePlacedPlans = (room: Room, playerId: string, snap: unknown): void => {
    const ghosts = room.plans.get(playerId);
    if (!ghosts || ghosts.length === 0) return;
    const grid = (snap as { grid?: number[] })?.grid;
    const rule = room.config?.rule as { cols?: number } | undefined;
    const cols = rule?.cols;
    if (!Array.isArray(grid) || !cols || cols <= 0) return;
    const totalRows = Math.floor(grid.length / cols);

    const kept = ghosts.filter((g) => {
      const shape = shapeOf(g.piece, g.rot);
      let filled = 0;
      let inside = 0;
      for (let i = 0; i < 8; i += 2) {
        const x = g.x + shape[i];
        const y = g.y + shape[i + 1];
        if (x < 0 || x >= cols || y < 0 || y >= totalRows) continue;
        inside++;
        if (grid[y * cols + x] !== 0) filled++;
      }
      // 보드 안에 있는 칸이 전부 메워졌으면 놓인 것으로 본다
      return inside === 0 || filled < inside;
    });
    if (kept.length === ghosts.length) return;
    if (kept.length === 0) room.plans.delete(playerId);
    else room.plans.set(playerId, kept);
    publishPlan(room, playerId);
  };

  /**
   * 중계하는 김에 받아 적는다. 페이로드는 여전히 해석하지 않는다 — 종류(`t`)만
   * 보고 보드 스냅샷이면 시간축을 붙여 담을 뿐이다.
   *
   * 여기 담기는 건 방 전체에 뿌려지는 저빈도 스냅샷이라, 나중에 다시 볼 때의
   * 매끄러움은 관전자가 실시간으로 보던 것과 같다.
   */
  const pushFrame = (room: Room, frame: RecordedFrame): void => {
    const rec = room.recording;
    if (!rec || room.phase !== "playing" || rec.truncated) return;
    // 대략적인 크기만 세면 충분하다(정확한 바이트가 아니라 폭주 방지가 목적)
    rec.bytes += JSON.stringify(frame.snap ?? frame.plan ?? null).length + 24;
    if (rec.bytes > MAX_RECORDING_BYTES) {
      rec.truncated = true;
      console.warn(`[fetris-be] 녹화 상한 도달 — room=${room.code} match=${rec.matchId}`);
      return;
    }
    rec.frames.push(frame);
  };

  /** 계획 변화를 녹화에 남긴다 — 나중에 볼 때도 그때 뭘 하려 했는지 보이도록 */
  const recordPlan = (room: Room, playerId: string, ghosts: PlanGhost[]): void => {
    const rec = room.recording;
    if (!rec) return;
    pushFrame(room, { ms: Date.now() - rec.startedAt, id: playerId, plan: ghosts });
  };

  /**
   * 중계하는 김에 입력을 그대로 받아 적는다.
   *
   * 페이로드를 해석하는 건 아니다 — 숫자 배열을 뒤에 이어 붙일 뿐, 그게 무슨
   * 조작인지는 여전히 서버의 관심 밖이다. 다만 이걸 갖고 있으면 참가자가
   * 아무것도 내주지 않아도 판을 60Hz로 정확히 되살릴 수 있다.
   */
  const recordStream = (room: Room, player: Player, msg: GameMessage): void => {
    const rec = room.recording;
    if (!rec || rec.truncated) return;
    let s = rec.streams.get(player.id);
    if (!s) {
      s = {
        seed: player.seed,
        handling: player.handling ?? room.config?.handling,
        keys: [],
        ige: [],
        frames: 0,
      };
      rec.streams.set(player.id, s);
    }
    const keys = (msg as { keys?: unknown }).keys;
    const ige = (msg as { ige?: unknown }).ige;
    const upto = Math.floor(Number((msg as { upto?: unknown }).upto));
    if (Array.isArray(keys)) {
      for (const k of keys) s.keys.push(Number(k));
      rec.bytes += keys.length * 4;
    }
    if (Array.isArray(ige)) {
      for (const g of ige) s.ige.push(Number(g));
      rec.bytes += ige.length * 4;
    }
    if (Number.isFinite(upto) && upto > s.frames) s.frames = upto;
    if (rec.bytes > MAX_RECORDING_BYTES) {
      rec.truncated = true;
      console.warn(`[fetris-be] 녹화 상한 도달 — room=${room.code} match=${rec.matchId}`);
    }
  };

  const record = (room: Room, player: Player, msg: GameMessage): void => {
    const rec = room.recording;
    if (!rec || room.phase !== "playing") return;
    if (msg?.t === "sync") {
      recordStream(room, player, msg);
      return;
    }
    // 보드 상태가 실려 오는 두 가지 — 입력 릴레이의 키프레임과, 입력을 흘리지
    // 않는 옛 봇의 스냅샷. 서버는 어느 쪽이든 시간축에 그대로 붙여 둔다.
    if (msg?.t !== "full" && msg?.t !== "board") return;
    const snap = (msg as { snap?: unknown }).snap;
    pushFrame(room, { ms: Date.now() - rec.startedAt, id: player.id, snap });
    // 계획한 자리에 조각이 놓였으면 여기서 걷어낸다
    prunePlacedPlans(room, player.id, snap);
  };

  /** 진행 중 녹화를 내보낼 수 있는 형태로 굳힌다 */
  const freezeRecording = (room: Room, winnerId: string | null): MatchRecording | null => {
    const rec = room.recording;
    if (!rec || (rec.frames.length === 0 && rec.streams.size === 0)) return null;
    return {
      matchId: rec.matchId,
      code: room.code,
      startedAt: rec.startedAt,
      winnerId,
      players: rec.roster.map((r) => {
        const s = rec.streams.get(r.id);
        // 아직 방에 있으면 확정된 순위를 붙인다(나간 사람은 알 수 없다)
        const live = room.players.find((p) => p.id === r.id);
        return {
          id: r.id,
          nick: r.nick,
          placement: live?.placement ?? null,
          isBot: r.isBot,
          ...(s
            ? {
                seed: s.seed,
                handling: s.handling,
                keys: s.keys,
                garbage: s.ige,
                frames: s.frames,
              }
            : {}),
        };
      }),
      truncated: rec.truncated,
      frames: rec.frames,
    };
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

    // 판이 끝나면 화면에 남은 계획은 의미가 없다 — 서버가 걷는다.
    // (녹화가 굳기 전에 지워야 "마지막에 지웠다"는 것까지 기록에 남는다)
    clearPlans(room);
    room.lastRecording = freezeRecording(room, winner?.id ?? null);
    room.recording = null;

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
    /*
      시드를 서버가 나눠준다. 예전엔 조각 순서를 공유하지 않는 방에서 각자가
      자기 시드를 뽑았는데, 그러면 서버에 재현할 근거가 없어 검증이 통째로
      꺼졌고 남들도 그 사람 보드를 따라 돌릴 수 없었다.
    */
    const share = room.config?.sharePieces !== false;
    for (const p of roster) {
      p.seed = share ? room.seed : (Math.random() * 0xffffffff) >>> 0;
    }
    clearPlans(room);
    // 판을 서버가 직접 받아 적는다. 참가자가 기록을 내주든 말든(리플레이를
    // 지원하지 않는 봇이라도) 판 전체가 남아야 하기 때문이다.
    room.recording = {
      matchId: room.matchId,
      startedAt: Date.now(),
      bytes: 0,
      truncated: false,
      frames: [],
      streams: new Map(),
      roster: roster.map((p) => ({ id: p.id, nick: p.nick, isBot: p.isBot })),
    };
    room.lastRecording = null;
    broadcast(room, {
      t: "match-start",
      matchId: room.matchId,
      seed: room.seed,
      config: room.config as MatchConfig,
      players: room.participants.slice(),
      // 서로의 보드를 입력만으로 따라 돌리려면 시드와 감도가 둘 다 필요하다
      sim: roster.map((p) => ({
        id: p.id,
        seed: p.seed,
        handling: p.handling ?? (room.config as MatchConfig).handling,
      })),
    });
    broadcastState(room);
  };

  // ---- 리플레이 검증 --------------------------------------------------------

  /**
   * 제출된 입력 로그를 서버가 직접 재현해 최종 상태 지문을 대조한다.
   * 어긋나면 제출자에게 알리고 로그를 남긴다(자동 제재는 하지 않는다 —
   * 오탐이 정상 플레이어를 쫓아내는 쪽이 더 나쁘다).
   *
   * 재현은 CPU를 쓰므로 이벤트 루프 밖으로 미룬다. 시드는 서버가 나눠준 값을
   * 쓴다 — 조각 순서를 공유하지 않는 방이라도 서버가 각자의 시드를 알고 있어서
   * 예전처럼 검증을 통째로 건너뛸 필요가 없다.
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
    // 시드는 서버가 배정한 값이 진실이다(제출자가 고쳐 부를 여지를 남기지 않는다)
    const seed = player.seed || room.seed;
    // 감도는 개인 설정이므로 이 사람이 알려온 값을 쓴다. 자기 신고이긴 하지만
    // 어차피 전부 정상 범위의 설정값이라 이걸로 얻는 이득은 없다.
    const handling = (player.handling ?? raw.handling ?? config.handling) as Handling;
    broadcast(
      room,
      {
        t: "replay-record",
        matchId: raw.matchId,
        playerId: player.id,
        seed,
        handling,
        frames,
        keys: raw.keys,
        garbage,
        fingerprint: raw.fingerprint,
        stats: raw.stats,
      },
      player.ws,
    );

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

  /**
   * 소켓이 끊겼다. 대기실이면 그냥 내보내지만, 판이 도는 중이라면 잠깐 자리를
   * 잡아둔다 — 순단 한 번에 판에서 밀려나지 않게 하려는 것이다. 유예 안에
   * resume하지 못하면 그때 정식으로 내보낸다.
   */
  const handleDisconnect = (ws: WebSocket): void => {
    const entry = sockToPlayer.get(ws);
    if (!entry) return;
    const { room, player } = entry;
    const inMatch = room.phase !== "lobby" && room.participants.includes(player.id);

    // 자리를 잡아둘 이유가 없으면 바로 정리
    if (!inMatch || player.isBot) {
      teardownPlayer(ws);
      return;
    }

    sockToPlayer.delete(ws);
    player.connected = false;
    player.graceTimer = setTimeout(() => {
      player.graceTimer = null;
      // 아직도 안 돌아왔다 — 이제 정말 내보낸다
      if (!player.connected) dropPlayer(room, player);
    }, graceMs);
    player.graceTimer.unref?.();
    broadcastState(room);
  };

  const teardownPlayer = (ws: WebSocket): void => {
    const entry = sockToPlayer.get(ws);
    if (!entry) return;
    sockToPlayer.delete(ws);
    const { room, player } = entry;
    dropPlayer(room, player);
  };

  /** 방에서 완전히 들어낸다(유예가 끝났거나 스스로 나갔거나) */
  const dropPlayer = (room: Room, player: Player): void => {
    if (player.graceTimer) {
      clearTimeout(player.graceTimer);
      player.graceTimer = null;
    }
    sessions.delete(player.session);
    if (!room.players.includes(player)) return;
    const wasParticipant =
      room.phase === "playing" &&
      room.participants.includes(player.id) &&
      player.alive;

    room.players = room.players.filter((p) => p !== player);
    if (player.runner) player.runner.active = Math.max(0, player.runner.active - 1);
    // 나간 사람의 계획은 화면에 남을 이유가 없다
    if (room.plans.delete(player.id)) publishPlan(room, player.id);

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
          ...newSessionFields(),
        };
        if (raw.handling && typeof raw.handling === "object") player.handling = raw.handling;
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
          recording: null,
          lastRecording: null,
          plans: new Map(),
        };
        rooms.set(code, room);
        sockToPlayer.set(ws, { room, player });
        sessions.set(player.session, { room, player });
        send(ws, { t: "created", code, myId: playerId, state: stateOf(room), session: player.session });
        break;
      }
      case "resume": {
        const token = typeof raw.token === "string" ? raw.token : "";
        const seat = sessions.get(token);
        if (!seat || !rooms.has(seat.room.code) || !seat.room.players.includes(seat.player)) {
          // 자리가 이미 정리됐다 — 새로 입장하는 수밖에 없다
          send(ws, { t: "error", reason: "resume-failed" });
          return;
        }
        const { room, player } = seat;

        // 옛 소켓이 아직 살아 있으면(중복 접속) 그쪽을 정리한다
        if (player.ws !== ws && player.ws.readyState === WebSocket.OPEN) {
          sockToPlayer.delete(player.ws);
          player.ws.close(4000, "resumed-elsewhere");
        }
        if (player.graceTimer) {
          clearTimeout(player.graceTimer);
          player.graceTimer = null;
        }
        sockToPlayer.delete(player.ws);
        player.ws = ws;
        player.connected = true;
        sockToPlayer.set(ws, { room, player });
        alive.set(ws, 0);

        // 어디까지 받았는지 듣고, 그 뒤에 보낸 것만 다시 보낸다.
        // 제어와 중계를 따로 담아 두었으므로 번호순으로 다시 합쳐 보낸다.
        const lastSeen = Math.floor(Number(raw.lastSeenId));
        const missed = Number.isFinite(lastSeen)
          ? [...player.outControl, ...player.outRelay]
              .filter((m) => m.id > lastSeen)
              .sort((a, b) => a.id - b.id)
          : [];
        send(ws, {
          t: "resumed",
          code: room.code,
          myId: player.id,
          state: stateOf(room),
          ackClientId: player.inId,
        });
        for (const m of missed) {
          if (ws.readyState === WebSocket.OPEN) ws.send(m.data);
        }
        broadcastState(room);
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
          ...newSessionFields(),
        };
        if (raw.handling && typeof raw.handling === "object") player.handling = raw.handling;
        room.players.push(player);
        sockToPlayer.set(ws, { room, player });
        sessions.set(player.session, { room, player });
        send(ws, { t: "joined", code: room.code, myId: playerId, state: stateOf(room), session: player.session });
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
      case "handling": {
        // 감도는 개인 설정이라 방 설정과 별개다. 서버는 내용을 해석하지 않고
        // 들고 있다가 매치 시작 때 방에 실어 보낸다.
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        if (raw.handling && typeof raw.handling === "object") {
          entry.player.handling = raw.handling;
        }
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
      case "plan": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        const { room, player } = entry;
        const clean = (list: unknown): PlanGhost[] =>
          (Array.isArray(list) ? list : [])
            .filter((g): g is PlanGhost => !!g && typeof g === "object")
            .slice(0, MAX_PLAN_GHOSTS);

        let next: PlanGhost[];
        if (Array.isArray(raw.set)) {
          next = clean(raw.set);
        } else {
          next = [...(room.plans.get(player.id) ?? [])];
          if (Array.isArray(raw.remove)) {
            const drop = new Set(raw.remove.map(String));
            next = next.filter((g) => g.id === undefined || !drop.has(g.id));
          }
          for (const g of clean(raw.add)) {
            // 같은 이름이 이미 있으면 덮어쓴다
            const at = g.id !== undefined ? next.findIndex((x) => x.id === g.id) : -1;
            if (at >= 0) next[at] = g;
            else next.push(g);
          }
          next = next.slice(0, MAX_PLAN_GHOSTS);
        }

        if (next.length === 0) room.plans.delete(player.id);
        else room.plans.set(player.id, next);
        publishPlan(room, player.id);
        break;
      }
      case "get-recording": {
        const entry = sockToPlayer.get(ws);
        if (!entry) return;
        const rec = entry.room.lastRecording;
        if (!rec) {
          send(ws, { t: "error", reason: "no-recording" });
          return;
        }
        send(ws, { t: "recording", ...rec });
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
        record(entry.room, entry.player, raw.msg);
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
      if (!msg || typeof msg.t !== "string") return;
      // 이미 처리한 메시지가 다시 오면(재전송) 흘려보낸다
      const seat = sockToPlayer.get(ws);
      if (seat && typeof msg.cid === "number") {
        if (msg.cid <= seat.player.inId) return;
        seat.player.inId = msg.cid;
      }
      handle(ws, msg);
    });
    ws.on("close", () => {
      handleDisconnect(ws);
      teardownRunner(ws);
    });
    ws.on("error", () => {
      handleDisconnect(ws);
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
