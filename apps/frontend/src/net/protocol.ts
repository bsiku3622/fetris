import type { RuleSet, Handling, PlanGhost } from "@fetris/engine/types";

export type { PlanGhost };
import type { GameSnapshot } from "@fetris/engine/game";
import type { ReplayFile } from "@fetris/engine/replay";

// ============================================================================
// 대전 네트워크 프로토콜 — 클라이언트 ↔ 릴레이 서버 ↔ 다른 클라이언트.
//
// 매치 진행(누가 참가하는지, 언제 시작하는지, 누가 몇 등인지)은 서버가 소유하고,
// 게임 내용물(보드·가비지·공격)은 클라이언트끼리 sender-authoritative로 주고받는다.
// 서버 쪽 정의는 apps/backend/src/protocol.ts — 변경 시 함께 맞춰야 한다.
// ============================================================================

/** 시작 카운트다운은 엔진이 자체 Ready로 처리하므로 별도 페이즈가 없다 */
export type RoomPhase = "lobby" | "playing" | "results";
export type PlayerRole = "player" | "spectator";

export interface PlayerInfo {
  id: string;
  nick: string;
  isHost: boolean;
  isBot: boolean;
  /** 봇이라면 이 봇을 올린 사람(토큰 소유자) */
  botOwner?: string;
  role: PlayerRole;
  /** 이번 매치 생존 여부(playing 중에만 의미 있음) */
  alive: boolean;
  /** 확정된 순위. 1 = 우승. null = 미확정 */
  placement: number | null;
  /** 이 방에 머무는 동안 쌓인 우승 횟수 */
  wins: number;
  /** 지금 소켓이 붙어 있는지(순단으로 끊긴 사람은 잠시 false) */
  connected: boolean;
}

/**
 * 매치 설정. simRate와 handling은 리플레이 검증에 반드시 필요하다 —
 * 같은 시드·입력이라도 simRate가 다르면 다른 결과가 나온다.
 */
export interface MatchConfig {
  rule: RuleSet;
  handling: Handling;
  simRate: number;
  sharePieces: boolean;
  undo: boolean;
  attackMul: number;
  /** 먼저 N승하면 시리즈 종료. 0이면 목표 없이 계속. */
  firstTo: number;
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  maxPlayers: number;
  players: PlayerInfo[];
  config: MatchConfig | null;
  matchId: number;
}

/** 지금 봇을 보내줄 수 있는 러너 — 호스트가 이 중에서 고른다 */
export interface BotRunnerInfo {
  id: string;
  name: string;
  capacity: number;
  active: number;
  /** 토큰에 묶인 소유자. 러너가 스스로 사칭할 수 없다. */
  owner: string;
  label?: string;
}

/** 방 안에서 플레이어끼리 주고받는 게임 메시지(서버는 그대로 중계) */
export type GameMessage =
  /** 상쇄 후 보낸 순수 공격(holes = 줄별 구멍 컬럼, targetId = 공격 대상) */
  | { t: "attack"; holes: number[]; targetId?: string }
  /** 상대 화면 표시용 보드 스냅샷 */
  | { t: "board"; snap: GameSnapshot }
  /**
   * "지금 네 보드를 크게 보고 있다"는 알림.
   * 받은 쪽은 그 사람에게만 스냅샷을 고빈도로 보내 트래픽을 아낀다
   * (인원이 늘면 전체 브로드캐스트만으로는 N² 로 불어난다).
   * watching=false면 포커스 해제.
   */
  | { t: "focus"; watching: boolean }
  /** 대기실·관전 채팅 */
  | { t: "chat"; nick: string; text: string }

  /**
   * 매치가 끝난 뒤 자기 판의 기록을 방에 나눠준다.
   * 관전자는 자기 입력 로그가 없으므로, 이걸 받아야 그 경기를 내려받을 수 있다.
   */
  | { t: "replay-share"; file: ReplayFile };

/** 클라이언트 → 서버 제어 메시지. cid는 재전송 판별용 순번이다. */
type ClientControlBody =
  | { t: "create"; maxPlayers?: number; nick?: string }
  | { t: "join"; code: string; nick?: string }
  | { t: "leave" }
  | { t: "relay"; msg: GameMessage }
  | { t: "relay-to"; targetId: string; msg: GameMessage }
  | { t: "set-role"; role: PlayerRole }
  | { t: "config"; config: MatchConfig }
  | { t: "start-match" }
  /** 결과 대기시간을 건너뛴다 — 시리즈 도중이면 곧바로 다음 판 */
  | { t: "skip-results" }
  /** 호스트 전용: 진행 중인 FT 시리즈를 접고 대기실로 */
  | { t: "abort-series" }
  /** 내가 탈락했다는 자기 신고 */
  | { t: "ko" }
  /** 매치 종료 후 리플레이 제출(검증용) */
  | {
      t: "replay";
      matchId: number;
      /** 이 판에서 실제로 쓴 시드(sharePieces가 꺼져 있으면 각자 다르다) */
      seed: number;
      /** 내가 쓴 감도 — 사람마다 다르므로 재현에 반드시 필요하다 */
      handling: Handling;
      frames: number;
      keys: number[];
      garbage: number[];
      fingerprint: string;
      stats?: { piecesPlaced: number; lines: number; attack: number };
    }
  /** runnerId를 주면 그 러너를 지목, 없으면 서버가 여유 있는 러너를 고른다 */
  | { t: "add-bot"; nick?: string; runnerId?: string }
  | { t: "kick-bot"; playerId: string }
  /** 대기 중인 봇 러너 목록 요청 */
  | { t: "list-runners" }
  /** 방금 끝난 판의 서버 녹화 요청(용량이 커서 필요할 때만 받는다) */
  | { t: "get-recording" }
  /**
   * 표시 전용 계획 고스트. set은 통째로 교체, add는 추가/갱신(같은 id면 덮어씀),
   * remove는 id로 골라 삭제. 상태는 서버가 들고 있다가 방에 뿌린다.
   */
  | { t: "plan"; set?: PlanGhost[]; add?: PlanGhost[]; remove?: string[] }
  /** 끊겼던 자리로 복귀 */
  | { t: "resume"; token: string; lastSeenId?: number };

export type ClientControl = ClientControlBody & { cid?: number };

/** 서버 → 클라이언트 제어 메시지. id는 resume 때 어디까지 받았는지 대조용이다. */
type ServerControlBody =
  | { t: "created"; code: string; myId: string; state: RoomState; session: string }
  | { t: "joined"; code: string; myId: string; state: RoomState; session: string }
  /** resume 성공 — 같은 자리로 돌아왔다 */
  | { t: "resumed"; code: string; myId: string; state: RoomState; ackClientId: number }
  | { t: "state"; state: RoomState }
  | { t: "match-start"; matchId: number; seed: number; config: MatchConfig; players: string[] }
  | { t: "ko"; playerId: string; placement: number; remaining: number }
  | {
      t: "match-end";
      matchId: number;
      winnerId: string | null;
      standings: { playerId: string; placement: number }[];
      /** 결과 화면이 걷히면 서버가 다음 판을 이어 연다(FT 시리즈 진행 중) */
      nextRound?: boolean;
      /** 있으면 시리즈(FT)까지 끝났다는 뜻 */
      seriesWinnerId?: string;
    }
  /** 누군가의 계획 고스트가 바뀌었다(서버가 정리한 경우도 포함) */
  | { t: "plan-state"; playerId: string; ghosts: PlanGhost[] }
  /** 다른 참가자가 제출한 판 기록 — 서버가 방에 흘려준다 */
  | {
      t: "replay-record";
      matchId: number;
      playerId: string;
      seed: number;
      handling?: Handling;
      frames: number;
      keys: number[];
      garbage: number[];
      fingerprint: string;
      stats?: { piecesPlaced: number; lines: number; attack: number };
    }
  /** get-recording 응답 — 서버가 중계하며 받아 적은 판 전체 */
  | {
      t: "recording";
      matchId: number;
      code: string;
      startedAt: number;
      winnerId: string | null;
      players: { id: string; nick: string; placement: number | null; isBot: boolean }[];
      truncated: boolean;
      frames: { ms: number; id: string; snap?: GameSnapshot; plan?: PlanGhost[] }[];
    }
  | { t: "error"; reason: string }
  | { t: "relay"; from: string; msg: GameMessage }
  | { t: "bot-pending"; ticket: string; nick: string; runnerId: string }
  | { t: "runners"; runners: BotRunnerInfo[] };

export type ServerControl = ServerControlBody & { id?: number };

export type AnyMessage = ClientControl | ServerControl;

/**
 * 공격 타깃 전략 — TETR.IO 방식. 수동 지정은 없다.
 *  random  — 매 공격마다 무작위 생존자
 *  even    — 내가 가장 적게 때린 상대(공격을 고르게 분배)
 *  elims   — KO에 가장 가까운 상대(보드가 높이 쌓인 쪽)
 *  payback — 최근 나를 때린 상대에게 되갚음
 */
export type TargetStrategy = "random" | "even" | "elims" | "payback";

export const TARGET_STRATEGIES: readonly TargetStrategy[] = ["random", "even", "elims", "payback"];

export const TARGET_LABELS: Record<TargetStrategy, string> = {
  random: "RANDOM",
  even: "EVEN",
  elims: "ELIMS",
  payback: "PAYBACK",
};
