// ============================================================================
// 릴레이 프로토콜 — 서버 권위 매치 진행 + sender-authoritative 게임 중계.
//
// 서버가 소유하는 것: 방 상태(phase), 참가자 명단·역할·준비, 매치 시작/카운트다운,
//                    KO 순위와 라스트맨 스탠딩 판정, 승수 누적.
// 서버가 모르는 것: 보드 내용, 가비지 계산, 시드로 무엇이 나오는지.
//   → 게임 페이로드(GameMessage)는 해석 없이 그대로 중계한다.
//
// 봇 연결: WS 경로 `/bot`으로 붙은 소켓만 봇으로 취급한다(사람은 `/`).
//   러너(control-plane)가 bot-hello로 등록 → bot-invite 수신 → 봇(data-plane)이
//   ticket으로 join. 자세한 흐름은 README "봇 엔드포인트" 절 참고.
// ============================================================================

/** 서버가 들여다보지 않는 게임 메시지(불투명 페이로드) */
export type GameMessage = { t: string; [k: string]: unknown };

/**
 * 방의 진행 상태.
 *  lobby     — 대기실. 준비 토글·설정 편집·봇 추가.
 *  countdown — 시작 카운트다운. 보드는 떠 있고 입력만 잠긴다.
 *  playing   — 대전 중. 마지막 1인이 남을 때까지.
 *  results   — 순위표. 잠시 후 자동으로 lobby로 돌아간다.
 */
export type RoomPhase = "lobby" | "countdown" | "playing" | "results";

/** 참가자는 이번 매치를 뛰고, 관전자는 다음 매치를 기다린다. */
export type PlayerRole = "player" | "spectator";

export interface PlayerInfo {
  id: string;
  nick: string;
  isHost: boolean;
  /** 봇 경로(`/bot`)로 접속한 참가자 여부 */
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
 * 매치 설정 — 서버는 rule/handling의 내용을 해석하지 않고 보관·전달만 한다.
 * 다만 리플레이 검증에서 서버가 같은 조건으로 재현해야 하므로,
 * simRate와 handling을 반드시 함께 싣는다(둘 중 하나만 달라도 결과가 갈린다).
 */
export interface MatchConfig {
  rule: unknown;
  handling: unknown;
  /** 시뮬레이션 주파수(60/120/240). 재현 시 동일해야 한다. */
  simRate: number;
  /** 모든 참가자가 같은 조각 순서를 받을지 */
  sharePieces: boolean;
  /** 교육 모드(되돌리기) 허용 */
  undo: boolean;
  /** 참가자 공통 공격 배수 */
  attackMul: number;
}

/** 방 전체 상태 스냅샷 — 대기실 변화가 있을 때마다 브로드캐스트한다. */
export interface RoomState {
  code: string;
  phase: RoomPhase;
  maxPlayers: number;
  players: PlayerInfo[];
  config: MatchConfig | null;
  /** 매치를 구분하는 일련번호(0 = 아직 한 판도 안 함) */
  matchId: number;
}

/** `GET /bots`와 봇 등록 응답에서 노출하는 러너 상태 */
export interface BotRunnerInfo {
  id: string;
  name: string;
  capacity: number;
  active: number;
}

/** 클라이언트 → 서버 */
export type ClientControl =
  | { t: "create"; maxPlayers?: number; nick?: string }
  /** ticket이 있으면 add-bot으로 예약된 슬롯에 착석(봇 경로 전용) */
  | { t: "join"; code: string; nick?: string; ticket?: string }
  | { t: "leave" }
  | { t: "relay"; msg: GameMessage }
  | { t: "relay-to"; targetId: string; msg: GameMessage }
  /** 준비 토글(lobby 전용) */
  | { t: "ready"; ready: boolean }
  /** 참가자 ↔ 관전자 전환(lobby 전용) */
  | { t: "set-role"; role: PlayerRole }
  /** 호스트 전용: 매치 설정 갱신 */
  | { t: "config"; config: MatchConfig }
  /** 호스트 전용: 카운트다운 시작 */
  | { t: "start-match" }
  /** 내가 탈락했다는 자기 신고(playing 전용) */
  | { t: "ko" }
  /** 매치 종료 후 리플레이 제출(검증용) */
  | { t: "replay"; matchId: number; frames: number; keys: number[] }
  /** 호스트 전용: 대기 중인 러너에게 봇 한 명을 이 방으로 초대 요청 */
  | { t: "add-bot"; nick?: string }
  /** 호스트 전용: 방에 있는 봇 퇴장 */
  | { t: "kick-bot"; playerId: string }
  /** 봇 러너 등록(봇 경로 전용) */
  | { t: "bot-hello"; name?: string; capacity?: number };

/** 서버 → 클라이언트 */
export type ServerControl =
  | { t: "created"; code: string; myId: string; state: RoomState }
  | { t: "joined"; code: string; myId: string; state: RoomState }
  /** 방 상태가 바뀔 때마다(입퇴장·준비·역할·설정·페이즈) 전체 스냅샷 */
  | { t: "state"; state: RoomState }
  /** 카운트다운 시작 — startsAt은 서버 기준 epoch ms */
  | { t: "countdown"; matchId: number; startsAt: number; seconds: number }
  /** 매치 개시 — 참가자는 이 시드로 동시에 시작한다 */
  | { t: "match-start"; matchId: number; seed: number; config: MatchConfig; players: string[] }
  /** 누군가 탈락 — placement는 확정된 순위, remaining은 남은 생존자 수 */
  | { t: "ko"; playerId: string; placement: number; remaining: number }
  /** 매치 종료 — standings는 1위부터 정렬 */
  | { t: "match-end"; matchId: number; winnerId: string | null; standings: { playerId: string; placement: number }[] }
  | { t: "error"; reason: string }
  | { t: "relay"; from: string; msg: GameMessage }
  /** 러너 등록 완료 */
  | { t: "bot-ready"; runner: BotRunnerInfo }
  /** 서버 → 러너: 이 방에 봇을 하나 붙여달라는 초대 */
  | { t: "bot-invite"; code: string; ticket: string; nick: string }
  /** 서버 → 호스트: add-bot 접수됨(착석하면 state로 반영된다) */
  | { t: "bot-pending"; ticket: string; nick: string; runnerId: string };
