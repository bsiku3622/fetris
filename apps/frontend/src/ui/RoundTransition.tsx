import { useEffect, useRef, useState } from "react";
import { FUNKY } from "../render/theme";
import type { MatchEndInfo, RoomSession } from "../app/roomSession";

// ============================================================================
// RoundTransition — FT 승부 도중 한 판이 끝나고 다음 판이 열리기까지의 연출.
//
// 순서가 중요하다.
//  1. 보드가 무너지는 연출이 **완전히 끝날 때까지 기다린다.** 두 동작이 겹치면
//     무슨 일이 일어나는지 읽히지 않는다.
//  2. 양끝에서 슬라이드가 닫히며 좌(나)·우(상대) 점수를 크게 보여준다.
//  3. 다음 판이 열리면 슬라이드가 걷힌다. 그래야 열리는 순간 두 보드가 새 판으로
//     준비된 채 드러난다 — 빈 화면이나 뒤늦게 튀어나오는 보드를 보여주지 않는다.
//  4. 걷히고 나서 3·2·1을 센다. 그건 여기가 아니라 무대(MatchStage)의 몫이다.
//
// 카운트다운을 여기서 세지 않는 이유가 있다. 여기서 시간으로 재면 화면의 숫자와
// 판이 실제로 열리는 순간이 따로 논다. 엔진이 판을 열기 전 잠가두는 프레임을
// 그대로 숫자로 바꾸면 둘이 어긋날 수 없고, 무대에 하나만 뜨므로 사람마다 다른
// 숫자가 보이지도 않는다.
//
// 3인 이상은 슬라이드 대신 화면 전체가 검게 덮이고 순위가 흰 글씨로 뜬다(TOP 5).
//
// 승부가 완전히 끝난 경우(누군가 FT를 채웠다)는 이 연출을 쓰지 않는다. 그때는
// 리플레이 내려받기와 대기실 이동이 필요해 기존 결과 화면이 그대로 뜬다.
// ============================================================================

/** 보드가 무너지는 연출(0.7초)이 완전히 가라앉기를 기다린다 */
const FALL_MS = 1000;
/** 슬라이드가 걷히는 데 걸리는 시간 — 부모가 이만큼 더 붙들어 준다 */
export const OPEN_MS = 700;
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
  const firstTo = room.state?.config?.firstTo ?? 1;
  const isHost = !!players.find((p) => p.id === myId)?.isHost;

  const nickOf = (id: string) => players.find((p) => p.id === id)?.nick ?? "player";
  const winsOf = (id: string) => players.find((p) => p.id === id)?.wins ?? 0;

  const standings = end.standings;
  const duel = standings.length === 2;

  /** 보드가 가라앉기를 기다렸다가 닫는다 */
  const [shut, setShut] = useState(false);
  const [slam, setSlam] = useState(false);
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
    return () => {
      for (const x of t) clearTimeout(x);
      timers.current = [];
    };
  }, []);

  /**
   * 승수는 판이 끝났다는 메시지에 함께 실려 온다.
   *
   * 방 상태에서 읽으면 안 된다 — 그건 이 메시지 뒤에 따라오므로, 화면을 짜는
   * 시점엔 아직 이번 판 승리가 반영되기 전이다. 이겨놓고 점수가 그대로인 화면이
   * 그래서 나왔다. 게다가 다음 판이 열리며 방 상태가 또 바뀌는데, 연출이 도는
   * 동안 숫자가 흔들리면 무엇을 읽고 있었는지 알 수 없다.
   */
  const scoreOf = (id: string) => standings.find((s) => s.playerId === id)?.wins ?? winsOf(id);

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
        <div className="fx-rt-of">{firstTo}선승</div>
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
      {isHost && <button onClick={() => room.abortSeries()}>승부 그만</button>}
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
