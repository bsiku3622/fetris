// ============================================================================
// 릴레이 프로토콜 — N인 멀티플레이어 지원.
// 서버는 GameMessage 내용을 해석하지 않고 중계(sender-authoritative).
// relay → 방 전체 브로드캐스트, relay-to → 특정 플레이어에게만.
// ============================================================================

/** 서버가 들여다보지 않는 게임 메시지(불투명 페이로드) */
export type GameMessage = { t: string; [k: string]: unknown };

export interface PlayerInfo {
  id: string;
  isHost: boolean;
}

/** 클라이언트 → 서버 */
export type ClientControl =
  | { t: "create"; maxPlayers?: number }
  | { t: "join"; code: string }
  | { t: "leave" }
  | { t: "relay"; msg: GameMessage }
  | { t: "relay-to"; targetId: string; msg: GameMessage };

/** 서버 → 클라이언트 */
export type ServerControl =
  | { t: "created"; code: string; myId: string }
  | { t: "joined"; code: string; myId: string; players: PlayerInfo[] }
  | { t: "peer-joined"; player: PlayerInfo }
  | { t: "peer-left"; playerId: string }
  | { t: "error"; reason: string }
  | { t: "relay"; from: string; msg: GameMessage };
