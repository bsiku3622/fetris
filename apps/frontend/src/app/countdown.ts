import { READY_FRAMES } from "@fetris/engine/game";

// ============================================================================
// 시작 카운트다운 — 화면에 띄울 숫자 하나를 정한다.
//
// 판이 열리면 엔진이 잠깐 입력을 잠그는데(Phase.Ready), 그 남은 프레임을 그대로
// 숫자로 바꾼다. 시간이 아니라 프레임을 세므로 simRate가 달라도, 프레임률이
// 흔들려도 모두가 같은 순간에 같은 숫자를 본다.
//
// 대기 구간을 넷으로 나눠 앞의 하나는 비워 둔다 — 시리즈 도중이면 그 사이에
// 라운드 전환의 장막이 걷힌다. 숫자는 장막이 다 걷힌 뒤부터 세기 시작해야
// 가려지지 않는다. 나눠 쓰기 때문에 대기가 짧아져도(빠른 시작) 3·2·1은 그대로
// 나오고 간격만 좁아진다.
// ============================================================================

/** 카운트다운 상태: 3·2·1은 그 숫자, 0은 GO!, 음수는 아무것도 띄우지 않음 */
export type CountdownState = number;

/** GO!를 띄워두는 시간 */
export const GO_MS = 620;

/**
 * 빠른 시작(EXPERT)에서 쓰는 대기 프레임 — 1초.
 *
 * 남과 맞출 것이 없는 혼자 하는 판에서만 쓴다. 대전은 서버가 나눠준 신호에
 * 모두가 같은 길이로 맞춰야 하므로 여기 값을 쓰지 않는다.
 */
export const EXPERT_READY_FRAMES = 60;

/**
 * 남은 Ready 프레임을 화면에 띄울 숫자로 바꾼다.
 *
 * @param readyTimer `Game.readyTimer` — 이미 시작했으면 음수
 * @param readyFrames 이 판이 쓰는 대기 프레임(`Game.readyFrames`)
 */
export function countdownAt(readyTimer: number, readyFrames: number = READY_FRAMES): CountdownState {
  // 이미 시작했다 — 방금 막 열렸다는 뜻이므로 GO!
  if (readyTimer < 0) return 0;
  const per = Math.max(1, readyFrames / 4);
  // 아직 화면이 정리되는 중(장막이 걷히는 구간)
  if (readyTimer > per * 3) return -1;
  return Math.ceil(readyTimer / per);
}
