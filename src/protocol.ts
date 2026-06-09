// ============================================================================
// 릴레이 프로토콜 — 프론트(src/net/protocol.ts)와 형태를 맞춘다.
// 서버는 GameMessage 내용을 해석하지 않고 상대에게 그대로 중계(sender-authoritative).
// ============================================================================

/** 서버가 들여다보지 않는 게임 메시지(불투명 페이로드) */
export type GameMessage = { t: string; [k: string]: unknown };

/** 클라이언트 → 서버 */
export type ClientControl =
  | { t: "create" }
  | { t: "join"; code: string }
  | { t: "leave" }
  | { t: "relay"; msg: GameMessage };

/** 서버 → 클라이언트 */
export type ServerControl =
  | { t: "created"; code: string }
  | { t: "joined"; code: string; asHost: boolean }
  | { t: "peer-joined" }
  | { t: "peer-left" }
  | { t: "error"; reason: string }
  | { t: "relay"; msg: GameMessage };
