import { useEffect, useRef, useState } from "react";
import { FUNKY } from "../render/theme";
import { VersusSession } from "../app/VersusSession";
import type { Settings } from "../app/store";
import type { RoomSession } from "../app/roomSession";
import type { MatchStartInfo } from "../app/roomSession";
import type { PlayerInfo, TargetStrategy } from "../net/protocol";
import { TARGET_LABELS, TARGET_STRATEGIES } from "../net/protocol";

// ============================================================================
// MatchStage — 대전과 관전을 함께 다루는 무대.
//
//  - 살아 있을 때: 내 보드가 주역, 상대들은 썸네일.
//  - KO된 뒤:    관전으로 넘어가 포커스한 상대가 주역이 된다.
//  - 생존 2명:   좌우 분할 결승 뷰로 좁혀진다.
//
// 캔버스는 React가 만들지만 그리기는 VersusSession이 직접 한다 —
// 매 프레임 리렌더를 피하려고 보드 정보는 React state로 올리지 않는다.
// ============================================================================

const OPP_PALETTE = [FUNKY.pink, FUNKY.orange, FUNKY.green, FUNKY.purple, FUNKY.yellow, FUNKY.danger, FUNKY.sky];

export function MatchStage({
  settings,
  room,
  match,
}: {
  settings: Settings;
  room: RoomSession;
  match: MatchStartInfo;
}) {
  const myId = room.myId ?? "";
  const players = room.state?.players ?? [];
  const byId = (id: string): PlayerInfo | undefined => players.find((p) => p.id === id);

  const opponents = match.players.filter((id) => id !== myId);
  const localCanvasRef = useRef<HTMLCanvasElement>(null);
  const oppCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const sessionRef = useRef<VersusSession | null>(null);

  const [focusId, setFocusId] = useState<string | null>(opponents[0] ?? null);
  const [strategy, setStrategy] = useState<TargetStrategy>("random");
  /** 이미 KO 연출을 태운 상대 — 중복 실행 방지 */
  const koneRef = useRef<Set<string>>(new Set());

  /** 이번 매치에 아예 참가하지 않은 사람(관전자) */
  const iAmSpectator = !match.players.includes(myId);
  /** 관전 화면을 보는 상태 — 처음부터 관전이거나, 뛰다가 KO됐거나 */
  const spectating = iAmSpectator || room.koed;
  /**
   * 판이 끝났다. 이때 서버는 우승자까지 alive=false로 내린다("아무도 안 뛴다"는
   * 뜻이지 KO가 아니다). 그래서 생존자 기준으로 짜인 레이아웃이 통째로 비어버리는데,
   * 마지막 보드는 결과와 함께 계속 보여야 하므로 여기서 화면을 얼려 둔다.
   */
  const ended = !!room.matchEnd;
  /**
   * 로스터가 이번 판의 것인가.
   *
   * 서버는 match-start를 먼저 보내고 방 상태를 뒤이어 보낸다. 그 사이 한 렌더
   * 동안은 **지난 판에서 죽은 사람이 그대로 죽은 걸로 보인다.** 그걸 믿으면
   * 새 판이 열리자마자 멀쩡한 상대에게 KO 연출을 태워, 보드가 투명해진 채
   * 화면 밖으로 밀려나 새까만 칸만 남는다(시리즈 다음 판에서 나던 증상).
   */
  const rosterReady = room.state?.matchId === match.matchId;
  const aliveOpponents = rosterReady
    ? opponents.filter((id) => byId(id)?.alive !== false)
    : opponents;
  /** 판이 끝나기 직전에 살아 있던 상대들 — 끝난 뒤 레이아웃은 이 구성을 유지한다 */
  const lastAliveRef = useRef<string[]>(aliveOpponents);
  if (!ended) lastAliveRef.current = aliveOpponents;
  const stageOpponents = ended ? lastAliveRef.current : aliveOpponents;

  // ---- 레이아웃 결정 -------------------------------------------------------
  // 1대1(봇 포함)은 좌우로 나란히 크게. 내가 죽고 둘만 남은 결승도 마찬가지다.
  // 셋 이상일 때만 "주역 하나 + 썸네일" 구성을 쓴다.
  //
  // 상대가 하나뿐이면 내가 죽었든 아니든 좌우 배치가 맞다. 여기서 관전 여부를
  // 따지면 KO되는 순간 레이아웃이 통째로 갈아엎히면서 남은 보드 하나가 화면
  // 가운데로 튀어나오는데, 판이 끝나는 순간에 그게 일어나면 아주 지저분하다.
  const duel = opponents.length === 1;
  // 관전 중이고 둘만 남았으면 좌우로 크게 본다
  const finalTwo = spectating && stageOpponents.length === 2;
  const sideBySide = duel || finalTwo;
  // 좌우 배치에 놓일 상대들
  const duelOpponents = duel ? opponents : finalTwo ? stageOpponents : [];
  // 셋 이상에서 크게 볼 상대(관전 중일 때만)
  const mainOpponent = !sideBySide && spectating ? (focusId ?? stageOpponents[0] ?? null) : null;
  /**
   * 지금 크게 떠 있는 보드들. 고빈도 스냅샷도 소리도 여기에 맞춘다 —
   * 화면에 보이는 것과 들리는 것이 어긋나면 판을 읽을 수 없다.
   */
  const featured = sideBySide ? duelOpponents : mainOpponent ? [mainOpponent] : [];
  const featuredKey = featured.join(",");

  // ---- 세션 구동 (매치당 한 번) --------------------------------------------
  useEffect(() => {
    const lc = localCanvasRef.current;
    const net = room.net;
    if (!lc || !net) return;

    // 지난 판에 떨군 사람들 기억을 비운다 — 안 그러면 시리즈 다음 판부터
    // "이미 처리했다"고 보고 KO 연출이 아예 뜨지 않는다
    koneRef.current.clear();

    const remoteCanvases = new Map<string, HTMLCanvasElement>();
    for (const id of opponents) {
      const cv = oppCanvasRefs.current.get(id);
      if (cv) remoteCanvases.set(id, cv);
    }

    const session = new VersusSession(
      lc,
      remoteCanvases,
      {
        rule: match.config.rule,
        // 감도는 개인 설정이다 — 방이 정한 값이 아니라 내 값으로 뛴다.
        // (룰·simRate는 방이 정한 대로 따라야 판이 공평하다)
        handling: settings.handling,
        keymap: settings.keymap,
        gfx: { ...settings.gfx, nextCount: match.config.rule.nextCount },
        audio: settings.audio,
        perf: { ...settings.perf, simRate: match.config.simRate },
        // 시드는 서버가 나눠준다 — 조각 순서를 공유하지 않는 방이라도 서버가
        // 각자의 시드를 알아야 리플레이를 재현해 볼 수 있다
        seed: match.sim.find((s) => s.id === myId)?.seed ?? match.seed,
        myAttackMul: match.config.attackMul,
        transport: net.transport(),
        opponents,
        sim: match.sim,
        // 이름은 캔버스가 필드 바로 아래에 그린다 — DOM으로는 이만큼 붙일 수 없다
        myLabel: { text: byId(myId)?.nick ?? "나", color: FUNKY.sky },
        labels: Object.fromEntries(
          opponents.map((id, i) => [id, { text: byId(id)?.nick ?? `P${i + 2}`, color: colorOf(i) }]),
        ),
        strategy: "random",
        undoEnabled: match.config.undo,
        spectating: iAmSpectator,
      },
      {
        onSelfKO: () => net.reportKO(),
        onStrategyChange: (s) => setStrategy(s),
      },
    );
    sessionRef.current = session;
    session.setFocus(featured);
    session.start();

    const onResize = () => session.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => session.resize());
    if (lc.parentElement) ro.observe(lc.parentElement);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      session.destroy();
      sessionRef.current = null;
    };
    // 매치 하나당 한 번만 만든다 — 의존성에 화면 상태를 넣으면 판이 리셋된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.matchId]);

  // ---- 서버가 알린 KO를 연출로 반영 ---------------------------------------
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    // 지난 판의 로스터로 이번 판 사람을 떨구지 않는다
    if (!rosterReady) return;
    for (const id of opponents) {
      const p = byId(id);
      if (!p || p.alive || koneRef.current.has(id)) continue;
      koneRef.current.add(id);
      // 판이 끝나며 우승자의 alive도 내려간다 — 그건 KO가 아니니 떨구지 않는다
      if (room.matchEnd?.winnerId === id) continue;
      session.koRemote(id);
      // 보고 있던 사람이 죽으면 다음 생존자로 옮긴다(판이 끝났으면 그대로 둔다)
      if (focusId === id && !ended) {
        setFocusId(opponents.find((o) => o !== id && byId(o)?.alive !== false) ?? null);
      }
    }
  }, [players, opponents, focusId, ended, rosterReady]);

  // 판이 끝나면 우승자 보드를 크게 남긴다(내가 이겼으면 내 보드가 그대로 주역이다)
  useEffect(() => {
    const winner = room.matchEnd?.winnerId;
    if (winner && winner !== myId && opponents.includes(winner)) setFocusId(winner);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.matchEnd]);

  // 크게 뜬 보드가 바뀌면 세션에 알린다(고빈도 스냅샷·소리 대상 변경)
  useEffect(() => {
    sessionRef.current?.setFocus(featuredKey ? featuredKey.split(",") : []);
  }, [featuredKey]);

  // 매치가 끝나면 입력 로그를 서버에 제출하고(재현해 대조), 같은 기록을
  // 내려받기용으로 남긴다. storeReplay는 방에도 공유되어 관전자가 받아 간다.
  const submittedRef = useRef(-1);
  useEffect(() => {
    const end = room.matchEnd;
    const session = sessionRef.current;
    if (!end || !session || !room.net) return;
    if (submittedRef.current === end.matchId) return;
    if (iAmSpectator) return; // 관전자는 남길 판이 없다
    submittedRef.current = end.matchId;

    const payload = session.replayPayload();
    room.net.submitReplay(
      end.matchId,
      payload.seed,
      payload.handling,
      payload.frames,
      payload.keys,
      payload.garbage,
      payload.fingerprint,
      payload.stats,
    );

    room.storeReplay(
      session.replayEntry({
        playerId: myId,
        nick: byId(myId)?.nick ?? "player",
        placement: end.standings.find((s) => s.playerId === myId)?.placement,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.matchEnd, room.net]);

  const colorOf = (idx: number) => OPP_PALETTE[idx % OPP_PALETTE.length];

  const thumbs = sideBySide ? [] : opponents.filter((id) => id !== mainOpponent);
  // 썸네일이 몇 줄로 설지 — 많아질수록 열을 늘려 세로로 흘러넘치지 않게 한다
  const thumbCols = thumbs.length <= 2 ? 1 : thumbs.length <= 6 ? 2 : 3;

  const koBadge = (id: string) => {
    const p = byId(id);
    if (!p || p.alive || !p.placement) return null;
    // 1위는 끝까지 살아남은 사람이다 — 판이 끝나며 alive가 내려갔을 뿐 KO가 아니다
    if (p.placement === 1) return null;
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 900,
          fontSize: "1.1rem",
          color: FUNKY.danger,
          pointerEvents: "none",
        }}
      >
        KO #{p.placement}
      </div>
    );
  };

  return (
    <div className="fx-versus" style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* 좌우 분할 — 1대1이거나 결승(둘만 생존) */}
      {sideBySide ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", gap: 12, padding: 12, paddingBottom: 48, boxSizing: "border-box" }}>
          {/*
            내가 뛰면 왼쪽이 내 보드다. 관전 중이면 보여줄 게 없지만 캔버스는
            남겨둔다 — 세션이 로컬 캔버스를 요구해서, 없으면 세션 자체가 안 만들어지고
            상대 보드까지 통째로 비어버린다.
          */}
          <div
            style={
              duel
                ? { flex: "1 1 50%", display: "flex" }
                : { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none", overflow: "hidden" }
            }
          >
            <BoardPane
              canvasRef={localCanvasRef}
              onCanvas={(el) => sessionRef.current?.rebindLocal(el)}
            />
          </div>
          {duelOpponents.map((id) => (
            <div key={id} style={{ flex: "1 1 50%", display: "flex", position: "relative" }}>
              <OppPane
                id={id}
                refs={oppCanvasRefs}
                onCanvas={(el) => sessionRef.current?.rebindRemote(id, el)}
                onClick={() => setFocusId(id)}
              />
              {koBadge(id)}
            </div>
          ))}
        </div>
      ) : (
        /*
          주역 하나 + 썸네일. 예전엔 썸네일을 화면 위에 절대 배치로 얹었는데,
          인원이 늘면 고정 크기 썸네일이 줄바꿈하며 화면 밖으로 넘치고 주역 보드의
          NEXT까지 덮어버렸다. 그래서 겹치지 않는 2단 배치로 바꾸고, 썸네일은
          개수에 맞춰 칸을 나눠 갖도록 했다 — 몇 명이 들어와도 화면 안에 들어온다.
        */
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            gap: 10,
            padding: 12,
            paddingBottom: 48,
            boxSizing: "border-box",
            minWidth: 0,
          }}
        >
          {/* 주역 — 살아 있으면 내 보드, 죽었으면 포커스한 상대 */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              justifyContent: "center",
              position: "relative",
            }}
          >
            <div
              style={{
                width: "100%",
                maxWidth: 520,
                height: "100%",
                display: "flex",
                opacity: spectating ? 0 : 1,
                pointerEvents: spectating ? "none" : "auto",
                transition: "opacity 0.4s",
                position: "absolute",
              }}
            >
              <BoardPane
                canvasRef={localCanvasRef}
                onCanvas={(el) => sessionRef.current?.rebindLocal(el)}
              />
            </div>
            {spectating && mainOpponent && (
              <div style={{ width: "100%", maxWidth: 520, height: "100%", display: "flex", position: "relative" }}>
                <OppPane
                  id={mainOpponent}
                  refs={oppCanvasRefs}
                  onCanvas={(el) => sessionRef.current?.rebindRemote(mainOpponent, el)}
                  onClick={() => {}}
                />
              </div>
            )}
          </div>

          {/* 썸네일 — 나머지 상대들. 칸을 나눠 가지므로 인원이 늘어도 넘치지 않는다 */}
          {thumbs.length > 0 && (
            <div
              style={{
                flex: `0 0 ${thumbCols * 22}%`,
                maxWidth: thumbCols * 190,
                display: "grid",
                gridTemplateColumns: `repeat(${thumbCols}, minmax(0, 1fr))`,
                gridAutoRows: "minmax(0, 1fr)",
                gap: 8,
                minWidth: 0,
              }}
            >
              {thumbs.map((id) => (
                // display:flex가 없으면 .fx-versus-pane의 flex:1이 먹지 않아
                // 캔버스 높이가 0으로 찌그러진다
                <div key={id} style={{ position: "relative", display: "flex", minWidth: 0, minHeight: 0 }}>
                  <OppPane
                    id={id}
                    refs={oppCanvasRefs}
                    onCanvas={(el) => sessionRef.current?.rebindRemote(id, el)}
                    onClick={() => setFocusId(id)}
                  />
                  {koBadge(id)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 타깃 전략 — 직접 뛰는 동안에만 의미가 있다 */}
      {!spectating && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: 10,
            display: "flex",
            gap: 6,
            zIndex: 8,
            fontSize: "0.7rem",
            fontWeight: 900,
          }}
        >
          {TARGET_STRATEGIES.map((s, i) => (
            <button
              key={s}
              onClick={() => sessionRef.current?.setStrategy(s)}
              style={{
                padding: "4px 8px",
                border: `2px solid ${strategy === s ? FUNKY.danger : "var(--funky-line)"}`,
                background: strategy === s ? FUNKY.danger : "var(--funky-surface)",
                color: strategy === s ? "#fff" : "inherit",
                cursor: "pointer",
              }}
            >
              {i + 1} {TARGET_LABELS[s]}
            </button>
          ))}
        </div>
      )}

      {/* 관전 안내 */}
      {spectating && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: 12,
            zIndex: 8,
            fontWeight: 900,
            fontSize: "0.8rem",
            color: FUNKY.danger,
            whiteSpace: "nowrap",
          }}
        >
          {iAmSpectator ? "관전 중" : "KO · 관전 중"} — 보드를 클릭하면 크게 봅니다
        </div>
      )}

    </div>
  );
}

function BoardPane({
  canvasRef,
  onCanvas,
}: {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  /** 레이아웃이 바뀌어 캔버스가 새로 만들어지면 세션에 다시 붙인다 */
  onCanvas: (el: HTMLCanvasElement) => void;
}) {
  return (
    <div className="fx-versus-pane" style={{ flex: 1 }}>
      <div className="fx-canvas-wrap">
        <canvas
          ref={(el) => {
            canvasRef.current = el;
            if (el) onCanvas(el);
          }}
        />
      </div>
    </div>
  );
}

function OppPane({
  id,
  refs,
  onCanvas,
  onClick,
}: {
  id: string;
  refs: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  onCanvas: (el: HTMLCanvasElement) => void;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="fx-versus-pane"
      style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
    >
      <div className="fx-canvas-wrap">
        <canvas
          ref={(el) => {
            if (el) {
              refs.current.set(id, el);
              onCanvas(el);
            } else {
              refs.current.delete(id);
            }
          }}
        />
      </div>
    </div>
  );
}
