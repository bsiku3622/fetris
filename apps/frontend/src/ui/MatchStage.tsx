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

  // 결승 뷰 — 내가 죽었고 생존자가 둘이면 좌우로 크게 본다
  const finalTwo = iAmDead && aliveOpponents.length === 2;
  const mainOpponent = iAmDead ? (focusId ?? aliveOpponents[0] ?? null) : null;

  return (
    <div className="fx-versus" style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* 내 보드 — 살아 있으면 주역, 죽으면 사라진 자리로 남는다 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: 12,
          boxSizing: "border-box",
          opacity: iAmDead ? 0 : 1,
          pointerEvents: iAmDead ? "none" : "auto",
          transition: "opacity 0.4s",
        }}
      >
        <div style={{ width: finalTwo ? "0%" : "44%", height: "94%", display: "flex" }}>
          <BoardPane canvasRef={localCanvasRef} label={byId(myId)?.nick ?? "나"} color={FUNKY.sky} />
        </div>
      </div>

      {/* 관전 주역 — 내가 죽은 뒤 크게 보는 상대 */}
      {iAmDead && !finalTwo && mainOpponent && (
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
          <div style={{ width: "44%", height: "94%", display: "flex" }}>
            <OppPane
              id={mainOpponent}
              label={byId(mainOpponent)?.nick ?? "상대"}
              color={colorOf(opponents.indexOf(mainOpponent))}
              refs={oppCanvasRefs}
              onClick={() => {}}
              focused
            />
          </div>
        </div>
      )}

      {/* 결승 뷰 — 마지막 두 명을 좌우로 */}
      {finalTwo && (
        <div style={{ position: "absolute", inset: 0, display: "flex", gap: 12, padding: 12, boxSizing: "border-box" }}>
          {aliveOpponents.map((id) => (
            <div key={id} style={{ flex: "1 1 50%", display: "flex" }}>
              <OppPane
                id={id}
                label={byId(id)?.nick ?? "상대"}
                color={colorOf(opponents.indexOf(id))}
                refs={oppCanvasRefs}
                onClick={() => setFocusId(id)}
                focused={focusId === id}
              />
            </div>
          ))}
        </div>
      )}

      {/* 썸네일 — 결승 뷰가 아닐 때 나머지 상대들 */}
      {!finalTwo && (
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
          {opponents
            .filter((id) => id !== mainOpponent)
            .map((id, idx) => {
              const p = byId(id);
              const dead = p && !p.alive;
              return (
                // display:flex가 없으면 .fx-versus-pane의 flex:1이 먹지 않아
                // 캔버스 높이가 0으로 찌그러진다(상대 보드가 안 보이던 원인)
                <div key={id} style={{ width: 150, height: 220, flex: "0 0 auto", position: "relative", display: "flex" }}>
                  <OppPane
                    id={id}
                    label={p?.nick ?? `P${idx + 2}`}
                    color={colorOf(opponents.indexOf(id))}
                    refs={oppCanvasRefs}
                    onClick={() => setFocusId(id)}
                    focused={focusId === id}
                  />
                  {dead && p?.placement ? (
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
                  ) : null}
                </div>
              );
            })}
        </div>
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
  label,
  color,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  label: string;
  color: string;
}) {
  return (
    <div className="fx-versus-pane" style={{ borderColor: color, flex: 1 }}>
      <div className="fx-versus-label" style={{ color, borderColor: color }}>
        {label}
      </div>
      <div className="fx-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

function OppPane({
  id,
  label,
  color,
  refs,
  onClick,
  focused,
}: {
  id: string;
  label: string;
  color: string;
  refs: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
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
            if (el) refs.current.set(id, el);
            else refs.current.delete(id);
          }}
        />
      </div>
    </div>
  );
}
