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
 *  lobby   — 대기실. 설정 편집·봇 추가.
 *  playing — 대전 중. 마지막 1인이 남을 때까지.
 *  results — 순위표. 잠시 후 자동으로 lobby로 돌아간다.
 *
 * 시작 카운트다운은 별도 페이즈가 아니다. 엔진이 판을 열 때 자체 Ready
 * 카운트다운을 돌리므로(보드는 떠 있고 입력만 잠긴다) 서버가 또 셀 필요가 없다.
 */
export type RoomPhase = "lobby" | "playing" | "results";

/** 참가자는 이번 매치를 뛰고, 관전자는 다음 매치를 기다린다. */
export type PlayerRole = "player" | "spectator";

export interface PlayerInfo {
  id: string;
  nick: string;
  isHost: boolean;
  /** 봇 경로(`/bot`)로 접속한 참가자 여부 */
  isBot: boolean;
  /** 봇이라면 이 봇을 올린 사람(토큰 소유자). 사람 참가자는 없음. */
  botOwner?: string;
  role: PlayerRole;
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
  /**
   * 시리즈 목표 승수(먼저 N승). 0이면 목표 없이 계속 반복한다.
   * 도달하면 match-end에 seriesWinnerId가 실리고 모두의 승수가 초기화된다.
   */
  firstTo: number;
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
  /** 이 러너를 올린 사람 — 토큰에 묶여 있어 러너가 스스로 사칭할 수 없다 */
  owner: string;
  /** 토큰에 달린 메모(어떤 봇인지) */
  label?: string;
}

/** 클라이언트 → 서버 */
export type ClientControl =
  | { t: "create"; maxPlayers?: number; nick?: string }
  /** ticket이 있으면 add-bot으로 예약된 슬롯에 착석(봇 경로 전용) */
  | { t: "join"; code: string; nick?: string; ticket?: string }
  | { t: "leave" }
  | { t: "relay"; msg: GameMessage }
  | { t: "relay-to"; targetId: string; msg: GameMessage }
  /** 참가자 ↔ 관전자 전환(lobby 전용) */
  | { t: "set-role"; role: PlayerRole }
  /** 호스트 전용: 매치 설정 갱신 */
  | { t: "config"; config: MatchConfig }
  /** 호스트 전용: 매치 시작 */
  | { t: "start-match" }
  /** 결과 화면 대기시간을 건너뛴다 — 시리즈 도중이면 곧바로 다음 판 (results 전용) */
  | { t: "skip-results" }
  /** 호스트 전용: 진행 중인 FT 시리즈를 접고 대기실로 */
  | { t: "abort-series" }
  /** 내가 탈락했다는 자기 신고(playing 전용) */
  | { t: "ko" }
  /**
   * 매치 종료 후 리플레이 제출(검증용).
   * keys는 [frame, action, down], garbage는 [frame, n, ...holes] 평탄 배열이고
   * fingerprint는 최종 상태 지문. 서버가 같은 시드·핸들링·simRate로 재현해
   * 지문을 대조한다. 가비지는 바깥에서 들어온 입력이라 같이 받아야 재현된다.
   */
  | {
      t: "replay";
      matchId: number;
      /** 이 판에서 실제로 쓴 시드. sharePieces가 꺼져 있으면 참가자마다 다르다. */
      seed?: number;
      /** 제출자가 쓴 감도. 감도는 개인 설정이라 방 설정으로 재현하면 어긋난다. */
      handling?: unknown;
      frames: number;
      keys: number[];
      garbage?: number[];
      fingerprint: string;
      /** 참고용 최종 성적(재생에는 쓰이지 않는다) */
      stats?: { piecesPlaced: number; lines: number; attack: number };
    }
  /**
   * 호스트 전용: 봇 한 명을 이 방으로 초대 요청.
   * runnerId를 주면 그 러너에게만 보내고, 없으면 여유가 가장 많은 러너를 고른다.
   */
  | { t: "add-bot"; nick?: string; runnerId?: string }
  /** 호스트 전용: 방에 있는 봇 퇴장 */
  | { t: "kick-bot"; playerId: string }
  /** 대기 중인 봇 러너 목록 요청(누구 봇을 부를지 고르기 위해) */
  | { t: "list-runners" }
  /**
   * 방금 끝난 판의 녹화 요청. 서버가 중계하며 직접 받아 적은 것이라 참가자의
   * 협조와 무관하게 존재한다. 용량이 크므로 필요할 때만 보낸다.
   */
  | { t: "get-recording" }
  /** 봇 러너 등록(봇 경로 전용) */
  | { t: "bot-hello"; name?: string; capacity?: number };

/** 서버 → 클라이언트 */
export type ServerControl =
  | { t: "created"; code: string; myId: string; state: RoomState }
  | { t: "joined"; code: string; myId: string; state: RoomState }
  /** 방 상태가 바뀔 때마다(입퇴장·역할·설정·페이즈) 전체 스냅샷 */
  | { t: "state"; state: RoomState }
  /** 매치 개시 — 참가자는 이 시드로 동시에 시작한다 */
  | { t: "match-start"; matchId: number; seed: number; config: MatchConfig; players: string[] }
  /** 누군가 탈락 — placement는 확정된 순위, remaining은 남은 생존자 수 */
  | { t: "ko"; playerId: string; placement: number; remaining: number }
  /**
   * 매치 종료 — standings는 1위부터 정렬.
   * seriesWinnerId가 있으면 이번 판으로 시리즈(FT)까지 끝났다는 뜻이다.
   */
  | {
      t: "match-end";
      matchId: number;
      winnerId: string | null;
      standings: { playerId: string; placement: number }[];
      /** 결과 화면이 걷히면 서버가 다음 판을 이어 연다(FT 시리즈 진행 중) */
      nextRound?: boolean;
      seriesWinnerId?: string;
    }
  /**
   * 누군가 제출한 판 기록 — 검증용 제출을 방에 그대로 흘려준 것이다.
   * 관전자는 자기 로그가 없으므로 이걸로만 그 경기를 내려받을 수 있다.
   */
  | {
      t: "replay-record";
      matchId: number;
      playerId: string;
      seed: number;
      handling?: unknown;
      frames: number;
      keys: number[];
      garbage: number[];
      fingerprint: string;
      /** 참고용 최종 성적(재생에는 쓰이지 않는다) */
      stats?: { piecesPlaced: number; lines: number; attack: number };
    }
  /** get-recording 응답 — 요청한 사람에게만 보낸다 */
  | {
      t: "recording";
      matchId: number;
      code: string;
      startedAt: number;
      winnerId: string | null;
      players: { id: string; nick: string; placement: number | null; isBot: boolean }[];
      /** 상한에 걸려 뒷부분이 잘렸는지 */
      truncated: boolean;
      /** 시간축 위의 장면들 — 보드 스냅샷과 표시용 계획 고스트가 섞여 있다 */
      frames: { ms: number; id: string; snap?: unknown; plan?: unknown }[];
    }
  | { t: "error"; reason: string }
  | { t: "relay"; from: string; msg: GameMessage }
  /** 러너 등록 완료 */
  | { t: "bot-ready"; runner: BotRunnerInfo }
  /** list-runners 응답 — 지금 붙일 수 있는 러너들 */
  | { t: "runners"; runners: BotRunnerInfo[] }
  /** 서버 → 러너: 이 방에 봇을 하나 붙여달라는 초대 */
  | { t: "bot-invite"; code: string; ticket: string; nick: string }
  /** 서버 → 호스트: add-bot 접수됨(착석하면 state로 반영된다) */
  | { t: "bot-pending"; ticket: string; nick: string; runnerId: string };
