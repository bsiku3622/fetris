import { useEffect, useRef, useState } from "react";
import { FUNKY } from "../render/theme";
import type { MatchEndInfo, RoomSession } from "../app/roomSession";

// ============================================================================
// RoundTransition — 시리즈에서 한 판이 끝나고 다음 판이 열리기까지의 연출.
//
// 순서가 중요하다.
//  1. 보드가 무너지는 연출이 **완전히 끝날 때까지 기다린다.** 두 동작이 겹치면
//     무슨 일이 일어나는지 읽히지 않는다.
//  2. 양끝에서 슬라이드가 닫히며 좌(나)·우(상대) 점수를 크게 보여준다.
//  3. 닫힌 문 뒤에서 3·2·1을 센다. 마지막 숫자가 꺼지는 순간 다음 판이 열린다.
//  4. 슬라이드는 **다음 판이 실제로 열린 뒤에** 걷힌다. 그래야 열리는 순간
//     두 보드가 새 판으로 준비된 채 드러난다 — 빈 화면이나 뒤늦게 튀어나오는
//     보드를 보여주지 않는다.
//
// 카운트다운을 여기서 세는 이유가 있다. 시작 대기를 룰에 실어 각자 세게 하면,
// 그 항목을 모르는 참가자(안 고친 봇)만 먼저 두기 시작한다 — 모르는 필드는 그냥
// 무시되기 때문이다. **출발 신호는 `match-start`가 도착하는 순간**이고, 여기서는
// 그 순간에 맞춰 숫자만 보여준다.
//
// 3인 이상은 슬라이드 대신 화면 전체가 검게 덮이고 순위가 흰 글씨로 뜬다(TOP 5).
//
// 판이 완전히 끝난 경우(시리즈 종료·단판)는 이 연출을 쓰지 않는다. 그때는
// 리플레이 내려받기와 대기실 이동이 필요해 기존 결과 화면이 그대로 뜬다.
// ============================================================================

/** 보드가 무너지는 연출(0.7초)이 완전히 가라앉기를 기다린다 */
const FALL_MS = 1000;
/** 슬라이드가 걷히는 데 걸리는 시간 — 부모가 이만큼 더 붙들어 준다 */
export const OPEN_MS = 700;
/** 숫자 하나가 쓰는 시간 */
const TICK_MS = 1000;
/** 카운트다운이 차지하는 구간 — 다음 판 시작 직전 3초 */
const COUNT_MS = TICK_MS * 3;
/** 한 번에 보여주는 순위 최대 인원 */
const TOP_N = 5;

export function RoundTransition({
  room,
  end,
  opened,
}: {
  room: RoomSession;
  /** 이 연출이 다루는 판 — matchEnd가 비워진 뒤에도 붙들고 있어야 한다 */
  end: MatchEndInfo;
  /** 다음 판이 열렸다 — 이제 슬라이드를 걷는다 */
  opened: boolean;
}) {
  const myId = room.myId ?? "";
  const players = room.state?.players ?? [];
  const firstTo = room.state?.config?.firstTo ?? 0;
  const isHost = !!players.find((p) => p.id === myId)?.isHost;

  const nickOf = (id: string) => players.find((p) => p.id === id)?.nick ?? "player";
  const winsOf = (id: string) => players.find((p) => p.id === id)?.wins ?? 0;

  const standings = end.standings;
  const duel = standings.length === 2;

  /** 보드가 가라앉기를 기다렸다가 닫는다 */
  const [shut, setShut] = useState(false);
  const [slam, setSlam] = useState(false);
  /** 3 → 2 → 1. 0이면 아직 카운트다운 전 */
  const [count, setCount] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const t = timers.current;
    t.push(setTimeout(() => setShut(true), FALL_MS));
    // 섬광과 흔들림은 슬라이드가 실제로 맞물리는 순간에 터뜨린다
    t.push(
      setTimeout(() => {
        setSlam(true);
        t.push(setTimeout(() => setSlam(false), 440));
      }, FALL_MS + 530),
    );
    // 마지막 숫자가 꺼지는 순간이 다음 판 시작이다 — 끝에서부터 역산한다
    const startsIn = Math.max(0, end.nextIn ?? 7600);
    const countAt = Math.max(FALL_MS, startsIn - COUNT_MS);
    for (let i = 0; i < 3; i++) {
      t.push(setTimeout(() => setCount(3 - i), countAt + i * TICK_MS));
    }
    return () => {
      for (const x of t) clearTimeout(x);
      timers.current = [];
    };
  }, [end.nextIn]);

  /**
   * 승수는 다음 판이 열리면서 방 상태가 갱신돼도 그대로여야 한다 — 연출이
   * 도는 동안 숫자가 바뀌면 무엇을 읽고 있었는지 알 수 없다.
   */
  const frozen = useRef<Map<string, number> | null>(null);
  if (!frozen.current && players.length > 0) {
    frozen.current = new Map(standings.map((s) => [s.playerId, winsOf(s.playerId)]));
  }
  const scoreOf = (id: string) => frozen.current?.get(id) ?? winsOf(id);

  // ---- 1대1 — 양끝 슬라이드 -----------------------------------------------
  if (duel) {
    const mine = standings.find((s) => s.playerId === myId) ?? standings[0];
    const theirs = standings.find((s) => s.playerId !== mine.playerId) ?? standings[1];

    const wing = (side: "l" | "r", id: string, color: string, won: boolean) => (
      <div
        className={`fx-rt-wing fx-rt-wing--${side}${shut ? " is-shut" : ""}${opened ? " is-open" : ""}`}
        style={{ background: color }}
      >
        <div className="fx-rt-nick">{nickOf(id)}</div>
        {/* 이번 판에 올라간 쪽 숫자만 한 박자 늦게 튄다 */}
        <div className={`fx-rt-score${won && shut ? " is-bumped" : ""}`}>{scoreOf(id)}</div>
        {firstTo > 0 && <div className="fx-rt-of">{firstTo}선승</div>}
        {shut && (
          <div
            className="fx-rt-stamp"
            style={{
              background: won ? FUNKY.yellow : "rgba(0,0,0,0.4)",
              color: won ? "#000" : "#fff",
            }}
          >
            {won ? "WIN" : "LOSE"}
          </div>
        )}
      </div>
    );

    return (
      <div className={`fx-rt${slam ? " is-slam" : ""}`}>
        {!shut && <div className="fx-rt-scrim" />}
        {shut && <div className="fx-rt-scrim" style={{ animation: "none", opacity: 0.42 }} />}
        {wing("l", mine.playerId, FUNKY.sky, end.winnerId === mine.playerId)}
        {wing("r", theirs.playerId, FUNKY.pink, end.winnerId === theirs.playerId)}
        {shut && !opened && <div className="fx-rt-seam" />}
        {slam && <div className="fx-rt-flash" />}
        {!opened && <Countdown n={count} />}
        {shut && !opened && <Tools room={room} isHost={isHost} />}
      </div>
    );
  }

  // ---- 3인 이상 — 검은 화면에 흰 글씨 순위 --------------------------------
  const top = standings.slice(0, TOP_N);

  return (
    <div className="fx-rt">
      {!shut && <div className="fx-rt-scrim" />}
      {shut && (
        <div className={`fx-rt-board${opened ? " is-out" : ""}`}>
          <div className="fx-rt-title">Standings</div>
          {top.map((s, i) => (
            <div
              key={s.playerId}
              className={
                "fx-rt-row" +
                (s.placement === 1 ? " fx-rt-row--top" : "") +
                (s.playerId === myId ? " fx-rt-row--me" : "")
              }
              // 위에서부터 한 줄씩 차례로
              style={{ animationDelay: `${140 + i * 110}ms` }}
            >
              <span className="fx-rt-rank">{s.placement}</span>
              <span className="fx-rt-name">{nickOf(s.playerId)}</span>
              <span className="fx-rt-wins">{scoreOf(s.playerId)}</span>
            </div>
          ))}
          {!opened && <Tools room={room} isHost={isHost} />}
        </div>
      )}
      {!opened && <Countdown n={count} />}
    </div>
  );
}

/** 3 · 2 · 1 — 조용하게. 숫자 하나만 가운데에 뜬다. */
function Countdown({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <div className="fx-rt-count" key={n}>
      <b>{n}</b>
    </div>
  );
}

/**
 * 연출이 도는 동안에도 눌러야 할 수 있는 것들.
 * 화면을 가리지 않게 구석에 작게 둔다.
 */
function Tools({ room, isHost }: { room: RoomSession; isHost: boolean }) {
  return (
    <div className="fx-rt-tools">
      {room.canDownloadMatch && <button onClick={() => void downloadMatch(room)}>↓ 리플레이</button>}
      <button onClick={() => room.skipResults()}>바로 시작</button>
      {isHost && <button onClick={() => room.abortSeries()}>시리즈 그만</button>}
    </div>
  );
}

/** 방금 끝난 판을 파일로 내려받는다(결과 화면의 버튼과 같은 동작) */
async function downloadMatch(room: RoomSession): Promise<void> {
  try {
    const file = await room.buildMatchReplay();
    const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fetris-${file.match.code ?? "match"}-match${file.match.matchId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // 연출 중에 경고창을 띄울 자리가 없다 — 실패하면 조용히 넘어간다
  }
}
