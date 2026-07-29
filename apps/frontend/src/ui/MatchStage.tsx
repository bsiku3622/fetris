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
  const [countdownLeft, setCountdownLeft] = useState<number | null>(null);
  /** 이미 KO 연출을 태운 상대 — 중복 실행 방지 */
  const koneRef = useRef<Set<string>>(new Set());

  const iAmDead = room.koed;
  const aliveOpponents = opponents.filter((id) => byId(id)?.alive !== false);

  // ---- 세션 구동 (매치당 한 번) --------------------------------------------
  useEffect(() => {
    const lc = localCanvasRef.current;
    const net = room.net;
    if (!lc || !net) return;

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
        handling: match.config.handling ?? settings.handling,
        keymap: settings.keymap,
        gfx: { ...settings.gfx, nextCount: match.config.rule.nextCount },
        audio: settings.audio,
        perf: { ...settings.perf, simRate: match.config.simRate },
        seed: match.config.sharePieces ? match.seed : (Math.random() * 0xffffffff) >>> 0,
        myAttackMul: match.config.attackMul,
        transport: net.transport(),
        opponents,
        strategy: "random",
        undoEnabled: match.config.undo,
      },
      {
        onSelfKO: () => net.reportKO(),
        onStrategyChange: (s) => setStrategy(s),
      },
    );
    sessionRef.current = session;
    session.setFocus(focusId);
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
    for (const id of opponents) {
      const p = byId(id);
      if (p && !p.alive && !koneRef.current.has(id)) {
        koneRef.current.add(id);
        session.koRemote(id);
        if (focusId === id) {
          // 보고 있던 사람이 죽으면 다음 생존자로 옮긴다
          const next = opponents.find((o) => o !== id && byId(o)?.alive !== false) ?? null;
          setFocusId(next);
        }
      }
    }
  }, [players, opponents, focusId]);

  // 포커스가 바뀌면 세션에 알린다(고빈도 스냅샷 대상 변경)
  useEffect(() => {
    sessionRef.current?.setFocus(focusId);
  }, [focusId]);

  // 매치가 끝나면 입력 로그를 제출한다 — 서버가 같은 조건으로 재현해 대조한다
  const submittedRef = useRef(-1);
  useEffect(() => {
    const end = room.matchEnd;
    const session = sessionRef.current;
    if (!end || !session || !room.net) return;
    if (submittedRef.current === end.matchId) return;
    submittedRef.current = end.matchId;
    const payload = session.replayPayload();
    room.net.submitReplay(end.matchId, payload.frames, payload.keys, payload.fingerprint);
  }, [room.matchEnd, room.net]);

  // ---- 카운트다운 ----------------------------------------------------------
  useEffect(() => {
    if (!room.countdown) {
      setCountdownLeft(null);
      return;
    }
    const tick = () => {
      const left = Math.ceil((room.countdown!.startsAt - Date.now()) / 1000);
      setCountdownLeft(left > 0 ? left : 0);
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [room.countdown]);

  const colorOf = (idx: number) => OPP_PALETTE[idx % OPP_PALETTE.length];

  // ---- 레이아웃 결정 -------------------------------------------------------
  // 1대1(봇 포함)은 좌우로 나란히 크게. 내가 죽고 둘만 남은 결승도 마찬가지다.
  // 셋 이상일 때만 "주역 하나 + 썸네일" 구성을 쓴다.
  const duel = !iAmDead && opponents.length === 1;
  const finalTwo = iAmDead && aliveOpponents.length === 2;
  const sideBySide = duel || finalTwo;
  // 좌우 배치에 놓일 상대들
  const duelOpponents = duel ? opponents : finalTwo ? aliveOpponents : [];
  // 셋 이상에서 크게 볼 상대(관전 중일 때만)
  const mainOpponent = !sideBySide && iAmDead ? (focusId ?? aliveOpponents[0] ?? null) : null;
  const thumbs = sideBySide ? [] : opponents.filter((id) => id !== mainOpponent);

  const koBadge = (id: string) => {
    const p = byId(id);
    if (!p || p.alive || !p.placement) return null;
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
          {/* 내가 살아 있으면 왼쪽은 내 보드 */}
          {duel && (
            <div style={{ flex: "1 1 50%", display: "flex" }}>
              <BoardPane
                canvasRef={localCanvasRef}
                onCanvas={(el) => sessionRef.current?.rebindLocal(el)}
                label={byId(myId)?.nick ?? "나"}
                color={FUNKY.sky}
              />
            </div>
          )}
          {duelOpponents.map((id) => (
            <div key={id} style={{ flex: "1 1 50%", display: "flex", position: "relative" }}>
              <OppPane
                id={id}
                label={byId(id)?.nick ?? "상대"}
                color={colorOf(opponents.indexOf(id))}
                refs={oppCanvasRefs}
                onCanvas={(el) => sessionRef.current?.rebindRemote(id, el)}
                onClick={() => setFocusId(id)}
                focused={focusId === id && finalTwo}
              />
              {koBadge(id)}
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* 주역 — 살아 있으면 내 보드, 죽었으면 포커스한 상대 */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              padding: 12,
              boxSizing: "border-box",
            }}
          >
            <div
              style={{
                width: "44%",
                height: "94%",
                display: "flex",
                opacity: iAmDead ? 0 : 1,
                pointerEvents: iAmDead ? "none" : "auto",
                transition: "opacity 0.4s",
                position: "absolute",
              }}
            >
              <BoardPane
                canvasRef={localCanvasRef}
                onCanvas={(el) => sessionRef.current?.rebindLocal(el)}
                label={byId(myId)?.nick ?? "나"}
                color={FUNKY.sky}
              />
            </div>
            {iAmDead && mainOpponent && (
              <div style={{ width: "44%", height: "94%", display: "flex", position: "relative" }}>
                <OppPane
                  id={mainOpponent}
                  label={byId(mainOpponent)?.nick ?? "상대"}
                  color={colorOf(opponents.indexOf(mainOpponent))}
                  refs={oppCanvasRefs}
                  onCanvas={(el) => sessionRef.current?.rebindRemote(mainOpponent, el)}
                  onClick={() => {}}
                  focused
                />
              </div>
            )}
          </div>

          {/* 썸네일 — 나머지 상대들 */}
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              width: "46%",
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              alignContent: "flex-start",
              gap: 8,
              zIndex: 5,
            }}
          >
            {thumbs.map((id, idx) => (
              // display:flex가 없으면 .fx-versus-pane의 flex:1이 먹지 않아
              // 캔버스 높이가 0으로 찌그러진다
              <div key={id} style={{ width: 150, height: 220, flex: "0 0 auto", position: "relative", display: "flex" }}>
                <OppPane
                  id={id}
                  label={byId(id)?.nick ?? `P${idx + 2}`}
                  color={colorOf(opponents.indexOf(id))}
                  refs={oppCanvasRefs}
                  onCanvas={(el) => sessionRef.current?.rebindRemote(id, el)}
                  onClick={() => setFocusId(id)}
                  focused={focusId === id}
                />
                {koBadge(id)}
              </div>
            ))}
          </div>
        </>
      )}

      {/* 타깃 전략 — 살아 있을 때만 의미가 있다 */}
      {!iAmDead && (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
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
      {iAmDead && (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            zIndex: 8,
            fontWeight: 900,
            fontSize: "0.8rem",
            color: FUNKY.danger,
          }}
        >
          KO · 관전 중 — 보드를 클릭하면 크게 봅니다
        </div>
      )}

      {/* 카운트다운 */}
      {countdownLeft !== null && countdownLeft > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 20,
            pointerEvents: "none",
            fontWeight: 900,
            fontSize: "8rem",
            color: FUNKY.yellow,
            textShadow: "6px 6px 0 rgba(0,0,0,0.35)",
          }}
        >
          {countdownLeft}
        </div>
      )}
    </div>
  );
}

function BoardPane({
  canvasRef,
  onCanvas,
  label,
  color,
}: {
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  /** 레이아웃이 바뀌어 캔버스가 새로 만들어지면 세션에 다시 붙인다 */
  onCanvas: (el: HTMLCanvasElement) => void;
  label: string;
  color: string;
}) {
  return (
    <div className="fx-versus-pane" style={{ borderColor: color, flex: 1 }}>
      <div className="fx-versus-label" style={{ color, borderColor: color }}>
        {label}
      </div>
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
  label,
  color,
  refs,
  onCanvas,
  onClick,
  focused,
}: {
  id: string;
  label: string;
  color: string;
  refs: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  onCanvas: (el: HTMLCanvasElement) => void;
  onClick: () => void;
  focused: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className="fx-versus-pane"
      style={{
        borderColor: focused ? FUNKY.danger : color,
        flex: 1,
        minWidth: 0,
        cursor: "pointer",
      }}
    >
      <div className="fx-versus-label" style={{ color, borderColor: color }}>
        {label}
      </div>
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
