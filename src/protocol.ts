// ============================================================================
// 릴레이 프로토콜 — N인 멀티플레이어 지원.
// 서버는 GameMessage 내용을 해석하지 않고 중계(sender-authoritative).
// relay → 방 전체 브로드캐스트, relay-to → 특정 플레이어에게만.
//
// 봇 연결: WS 경로 `/bot`으로 붙은 소켓만 봇으로 취급한다(사람 클라이언트는 `/`).
//  - 러너(control-plane): bot-hello로 등록 → 대기 → bot-invite 수신.
//  - 봇(data-plane): 초대의 ticket을 들고 join → 방에 isBot으로 착석.
// ============================================================================

/** 서버가 들여다보지 않는 게임 메시지(불투명 페이로드) */
export type GameMessage = { t: string; [k: string]: unknown };

export interface PlayerInfo {
  id: string;
  isHost: boolean;
  nick: string;
  /** 봇 경로(`/bot`)로 접속한 참가자 여부 */
  isBot: boolean;
}

/** `GET /bots`와 봇 등록 응답에서 노출하는 러너 상태 */
export interface BotRunnerInfo {
  id: string;
  name: string;
  /** 동시에 맡을 수 있는 봇 수 */
  capacity: number;
  /** 예약(초대 대기) + 착석 중인 봇 수 */
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
  /** 호스트 전용: 대기 중인 러너에게 봇 한 명을 이 방으로 초대 요청 */
  | { t: "add-bot"; nick?: string }
  /** 호스트 전용: 방에 있는 봇 퇴장 */
  | { t: "kick-bot"; playerId: string }
  /** 봇 러너 등록(봇 경로 전용) */
  | { t: "bot-hello"; name?: string; capacity?: number };

/** 서버 → 클라이언트 */
export type ServerControl =
  | { t: "created"; code: string; myId: string }
  | { t: "joined"; code: string; myId: string; players: PlayerInfo[] }
  | { t: "peer-joined"; player: PlayerInfo }
  | { t: "peer-left"; playerId: string }
  | { t: "error"; reason: string }
  | { t: "relay"; from: string; msg: GameMessage }
  /** 러너 등록 완료 */
  | { t: "bot-ready"; runner: BotRunnerInfo }
  /** 서버 → 러너: 이 방에 봇을 하나 붙여달라는 초대 */
  | { t: "bot-invite"; code: string; ticket: string; nick: string }
  /** 서버 → 호스트: add-bot 접수됨(착석하면 peer-joined가 따로 온다) */
  | { t: "bot-pending"; ticket: string; nick: string; runnerId: string };
