import type { RuleSet } from "../engine/types";
import type { GameSnapshot } from "../engine/game";

// ============================================================================
// 대전 네트워크 프로토콜 — 클라이언트 ↔ 서버(릴레이) ↔ 상대 클라이언트.
// 서버는 sender-authoritative 릴레이라 페이로드를 그대로 전달한다.
// ============================================================================

/** 방 안에서 두 플레이어가 주고받는 게임 메시지(서버는 상대에게 그대로 중계) */
export type GameMessage =
  /** 호스트→게스트: 대기실 룸 설정(룰·공격배수·옵션) 동기화. 입장 시·편집 시 전송. */
  | { t: "settings"; rule: RuleSet; attackMul: [number, number]; undo: boolean; sharePieces: boolean }
  /** 호스트→게스트: 이번 판 시작(시드 포함). 매 대결/재대결마다 새 시드. */
  | { t: "start"; seed: number }
  /** 상쇄 후 보낸 순수 공격(holes = 줄별 구멍 컬럼) */
  | { t: "attack"; holes: number[] }
  /** 상대 화면 표시용 보드 스냅샷 */
  | { t: "board"; snap: GameSnapshot }
  /** 내 게임오버(상대 승리) */
  | { t: "dead" };

/** 클라이언트→서버 제어 메시지(방 수명 관리). 룰/시드는 호스트가 relay로 동기화한다. */
export type ClientControl =
  | { t: "create" }
  | { t: "join"; code: string }
  | { t: "leave" }
  | { t: "relay"; msg: GameMessage }; // 상대에게 중계 요청

/** 서버→클라이언트 제어 메시지 */
export type ServerControl =
  | { t: "created"; code: string } // 방 생성됨(방 코드 발급)
  | { t: "joined"; code: string; asHost: boolean } // 입장 성공
  | { t: "peer-joined" } // 상대가 입장함(호스트에게)
  | { t: "peer-left" } // 상대 이탈
  | { t: "error"; reason: string }
  | { t: "relay"; msg: GameMessage }; // 상대가 보낸 게임 메시지

export type AnyMessage = ClientControl | ServerControl;

/** 플레이어 식별 — 좌(나)/우(상대) 렌더 컬러 구분에 사용 */
export const enum Side {
  P1 = 0,
  P2 = 1,
}
