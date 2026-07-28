import type { RuleSet, Handling } from "@fetris/engine/types";
import type { GameSnapshot } from "@fetris/engine/game";

// ============================================================================
// 대전 네트워크 프로토콜 — 클라이언트 ↔ 릴레이 서버 ↔ 다른 클라이언트.
//
// 매치 진행(누가 참가하는지, 언제 시작하는지, 누가 몇 등인지)은 서버가 소유하고,
// 게임 내용물(보드·가비지·공격)은 클라이언트끼리 sender-authoritative로 주고받는다.
// 서버 쪽 정의는 apps/backend/src/protocol.ts — 변경 시 함께 맞춰야 한다.
// ============================================================================

export type RoomPhase = "lobby" | "countdown" | "playing" | "results";
export type PlayerRole = "player" | "spectator";

export interface PlayerInfo {
  id: string;
  nick: string;
  isHost: boolean;
  isBot: boolean;
  role: PlayerRole;
  ready: boolean;
  /** 이번 매치 생존 여부(playing 중에만 의미 있음) */
  alive: boolean;
  /** 확정된 순위. 1 = 우승. null = 미확정 */
  placement: number | null;
  /** 이 방에 머무는 동안 쌓인 우승 횟수 */
  wins: number;
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
}

export interface RoomState {
  code: string;
  phase: RoomPhase;
  maxPlayers: number;
  players: PlayerInfo[];
  config: MatchConfig | null;
  matchId: number;
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
  | { t: "chat"; nick: string; text: string };

/** 클라이언트 → 서버 제어 메시지 */
export type ClientControl =
  | { t: "create"; maxPlayers?: number; nick?: string }
  | { t: "join"; code: string; nick?: string }
  | { t: "leave" }
  | { t: "relay"; msg: GameMessage }
  | { t: "relay-to"; targetId: string; msg: GameMessage }
  | { t: "ready"; ready: boolean }
  | { t: "set-role"; role: PlayerRole }
  | { t: "config"; config: MatchConfig }
  | { t: "start-match" }
  /** 내가 탈락했다는 자기 신고 */
  | { t: "ko" }
  /** 매치 종료 후 리플레이 제출(검증용) */
  | { t: "replay"; matchId: number; frames: number; keys: number[]; fingerprint: string }
  | { t: "add-bot"; nick?: string }
  | { t: "kick-bot"; playerId: string };

/** 서버 → 클라이언트 제어 메시지 */
export type ServerControl =
  | { t: "created"; code: string; myId: string; state: RoomState }
  | { t: "joined"; code: string; myId: string; state: RoomState }
  | { t: "state"; state: RoomState }
  | { t: "countdown"; matchId: number; startsAt: number; seconds: number }
  | { t: "match-start"; matchId: number; seed: number; config: MatchConfig; players: string[] }
  | { t: "ko"; playerId: string; placement: number; remaining: number }
  | { t: "match-end"; matchId: number; winnerId: string | null; standings: { playerId: string; placement: number }[] }
  | { t: "error"; reason: string }
  | { t: "relay"; from: string; msg: GameMessage }
  | { t: "bot-pending"; ticket: string; nick: string; runnerId: string };

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
