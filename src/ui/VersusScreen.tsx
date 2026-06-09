import { useEffect, useRef, useState } from "react";
import { Button, Text } from "@studio-baeks/funky-ui";
import type { Settings } from "../app/store";
import type { RuleSet } from "../engine/types";
import { NetClient } from "../net/client";
import type { GameMessage } from "../net/protocol";
import { Side } from "../net/protocol";
import { VersusSession } from "../app/VersusSession";
import type { MatchResult } from "../app/VersusMatch";
import { FUNKY } from "../render/theme";

// ============================================================================
// VersusScreen — 커스텀 1대1 방.
//  lobby:  방 만들기 / 코드로 입장
//  room:   대기실 — 코드·로스터·설정(호스트 편집, 게스트 표시) + 대결 시작
//  playing: 좌(나)/우(상대) 대전. 게임오버 → 결과 → 대기실로 복귀(재대결).
// 연결은 대기실에 머무는 동안 유지되어, 같은 세팅으로 재대결할 수 있다.
// ============================================================================

type Phase = "lobby" | "room" | "playing";

interface RoomConfig {
  rule: RuleSet;
  attackMul: [number, number];
  undo: boolean;
  sharePieces: boolean;
}

interface PlayParams {
  rule: RuleSet;
  seed: number;
  side: Side;
  myAttackMul: number;
  undo: boolean;
}

const rnd = () => (Math.random() * 0xffffffff) >>> 0;

function humanError(reason: string): string {
  if (reason === "room-not-found") return "방을 찾을 수 없어요. 코드를 확인해주세요.";
  if (reason === "room-full") return "이미 꽉 찬 방이에요.";
  return "오류가 발생했어요: " + reason;
}

const P1_COLOR = FUNKY.sky;
const P2_COLOR = FUNKY.pink;

export function VersusScreen({ settings, onExit }: { settings: Settings; onExit: () => void }) {
  const [phase, setPhase] = useState<Phase>("lobby");
  const [isHost, setIsHost] = useState(true);
  const [code, setCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [opponentPresent, setOpponentPresent] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<MatchResult>(null);
  const [lastResult, setLastResult] = useState<MatchResult>(null);

  const [serverUrl, setServerUrl] = useState(() => {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    return env?.VITE_FETRIS_WS_URL || "ws://localhost:8787";
  });

  // 룸 설정(호스트 편집 / 게스트는 수신 표시)
  const [mulP1, setMulP1] = useState(1);
  const [mulP2, setMulP2] = useState(1);
  const [undo, setUndo] = useState(false);
  const [garbage, setGarbage] = useState(true);
  const [sharePieces, setSharePieces] = useState(true);

  const netRef = useRef<NetClient | null>(null);
  const sessionRef = useRef<VersusSession | null>(null);
  const playParamsRef = useRef<PlayParams | null>(null);
  const roomCfgRef = useRef<RoomConfig | null>(null); // 게스트: 마지막 수신 설정(start 시 사용)
  const localCanvasRef = useRef<HTMLCanvasElement>(null);
  const remoteCanvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef<Phase>("lobby");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  // 설정 source of truth(ref) — 콜백/타이머의 stale closure 방지. 화면 state는 표시용.
  const cfgRef = useRef({ mulP1: 1, mulP2: 1, undo: false, garbage: true, sharePieces: true });
  const isHostRef = useRef(true);

  useEffect(() => {
    return () => {
      netRef.current?.disconnect();
      netRef.current = null;
    };
  }, []);

  type Cfg = { mulP1: number; mulP2: number; undo: boolean; garbage: boolean; sharePieces: boolean };
  const ruleFromCfg = (c: Cfg): RuleSet => ({ ...settings.rulesets.custom, garbageEnabled: c.garbage });

  const beginPlaying = (p: PlayParams) => {
    playParamsRef.current = p;
    setResult(null);
    setPhase("playing");
  };

  // 호스트: 현재 설정(ref)을 게스트에게 전송
  const sendSettings = (net: NetClient) => {
    const c = cfgRef.current;
    net.sendGame({ t: "settings", rule: ruleFromCfg(c), attackMul: [c.mulP1, c.mulP2], undo: c.undo, sharePieces: c.sharePieces });
  };

  // 호스트 설정 편집 — ref를 즉시 갱신하고(동기), 표시 state 갱신 + 게스트에 전송
  const applyEdit = (patch: Partial<Cfg>) => {
    const next = { ...cfgRef.current, ...patch };
    cfgRef.current = next;
    if ("mulP1" in patch) setMulP1(next.mulP1);
    if ("mulP2" in patch) setMulP2(next.mulP2);
    if ("undo" in patch) setUndo(next.undo);
    if ("garbage" in patch) setGarbage(next.garbage);
    if ("sharePieces" in patch) setSharePieces(next.sharePieces);
    const net = netRef.current;
    if (net && isHostRef.current && phaseRef.current === "room") sendSettings(net);
  };

  const host = async () => {
    setError("");
    setIsHost(true);
    isHostRef.current = true;
    setLastResult(null);
    const net = new NetClient(serverUrl);
    netRef.current = net;
    net.onError = (r) => setError(humanError(r));
    net.onDisconnect = () => {
      if (phaseRef.current !== "playing") setError("서버 연결이 끊겼습니다.");
    };
    net.onCreated = (c) => {
      setCode(c);
      setOpponentPresent(false);
      setPhase("room");
    };
    net.onPeerJoined = () => {
      setOpponentPresent(true);
      sendSettings(net); // 입장한 게스트에게 현재 설정 동기화
    };
    net.onPeerLeft = () => {
      setOpponentPresent(false);
      if (phaseRef.current === "playing") setResult("win");
    };
    try {
      await net.connect();
      net.createRoom();
    } catch {
      setError("서버에 연결할 수 없습니다. 주소를 확인해주세요.");
    }
  };

  const join = async () => {
    setError("");
    if (!joinCode.trim()) {
      setError("방 코드를 입력해주세요.");
      return;
    }
    setIsHost(false);
    isHostRef.current = false;
    setLastResult(null);
    const net = new NetClient(serverUrl);
    netRef.current = net;
    net.onError = (r) => setError(humanError(r));
    net.onDisconnect = () => {
      if (phaseRef.current !== "playing") setError("서버 연결이 끊겼습니다.");
    };
    net.onJoined = () => {
      setOpponentPresent(true); // 호스트가 방에 있음
      setPhase("room");
    };
    net.onPeerLeft = () => {
      setOpponentPresent(false);
      if (phaseRef.current === "playing") setResult("win");
      else setError("상대가 방을 떠났어요.");
    };
    net.onGameMessage = (m: GameMessage) => {
      if (m.t === "settings") {
        roomCfgRef.current = { rule: m.rule, attackMul: m.attackMul, undo: m.undo, sharePieces: m.sharePieces };
        setMulP1(m.attackMul[0]);
        setMulP2(m.attackMul[1]);
        setGarbage(m.rule.garbageEnabled);
        setUndo(m.undo);
        setSharePieces(m.sharePieces);
      } else if (m.t === "start") {
        const cfg = roomCfgRef.current;
        if (!cfg) return;
        const seed = cfg.sharePieces ? m.seed : rnd();
        beginPlaying({ rule: cfg.rule, seed, side: Side.P2, myAttackMul: cfg.attackMul[1], undo: cfg.undo });
      }
    };
    try {
      await net.connect();
      net.joinRoom(joinCode);
    } catch {
      setError("서버에 연결할 수 없습니다. 주소를 확인해주세요.");
    }
  };

  // 호스트: 대결 시작(매번 새 시드)
  const startMatch = () => {
    const net = netRef.current;
    if (!net || !isHost || !opponentPresent) return;
    const c = cfgRef.current;
    sendSettings(net); // 최신 설정 확정 전송
    const seed = rnd();
    net.sendGame({ t: "start", seed });
    beginPlaying({ rule: ruleFromCfg(c), seed, side: Side.P1, myAttackMul: c.mulP1, undo: c.undo });
  };

  const returnToRoom = () => {
    setLastResult(result);
    setResult(null);
    setPhase("room");
  };

  const leaveRoom = () => {
    netRef.current?.disconnect();
    netRef.current = null;
    setResult(null);
    setLastResult(null);
    setCode("");
    setOpponentPresent(false);
    setPhase("lobby");
  };

  // 대전 세션 구동
  useEffect(() => {
    if (phase !== "playing") return;
    const p = playParamsRef.current;
    const net = netRef.current;
    const lc = localCanvasRef.current;
    const rc = remoteCanvasRef.current;
    if (!p || !net || !lc || !rc) return;

    const session = new VersusSession(
      lc,
      rc,
      {
        rule: p.rule,
        handling: settings.handling,
        keymap: settings.keymap,
        gfx: { ...settings.gfx, nextCount: p.rule.nextCount },
        audio: settings.audio,
        perf: settings.perf,
        seed: p.seed,
        myAttackMul: p.myAttackMul,
        side: p.side,
        transport: net.transport(),
        undoEnabled: p.undo,
      },
      { onResult: (r) => setResult(r) },
    );
    sessionRef.current = session;
    session.start();
    if (import.meta.env.DEV) (window as unknown as { __fetrisVersus?: VersusSession }).__fetrisVersus = session;

    const onResize = () => session.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => session.resize());
    if (lc.parentElement) ro.observe(lc.parentElement);
    if (rc.parentElement) ro.observe(rc.parentElement);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      session.destroy();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const mySide = playParamsRef.current?.side ?? (isHost ? Side.P1 : Side.P2);
  const myColor = mySide === Side.P1 ? P1_COLOR : P2_COLOR;
  const oppColor = mySide === Side.P1 ? P2_COLOR : P1_COLOR;

  // ---- 대전 화면 ----
  if (phase === "playing") {
    return (
      <div className="fx-versus">
        <div className="fx-versus-boards">
          <BoardPane canvasRef={localCanvasRef} label={`YOU (${mySide === Side.P1 ? "P1" : "P2"})`} color={myColor} />
          <BoardPane canvasRef={remoteCanvasRef} label={`OPP (${mySide === Side.P1 ? "P2" : "P1"})`} color={oppColor} />
        </div>

        {result && (
          <div className="fx-overlay">
            <div className="fx-panel">
              <h2 style={{ color: result === "win" ? FUNKY.green : FUNKY.danger }}>{result === "win" ? "WIN!" : "LOSE"}</h2>
              <Button variant="primary" size="lg" onClick={returnToRoom}>
                대기실로
              </Button>
              <Button variant="neutral" size="md" onClick={leaveRoom}>
                방 나가기
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ---- 로비 / 대기실 ----
  return (
    <div className="fx-menu">
      <div className="fx-logo" style={{ fontSize: "2.5rem" }}>
        <span style={{ color: P1_COLOR }}>VERSUS</span> <span style={{ color: P2_COLOR }}>1 v 1</span>
      </div>
      <Text variant="chrome" muted>
        커스텀 룸 대전
      </Text>

      {error && (
        <div style={{ color: FUNKY.danger, fontWeight: 900, padding: "0.5rem 1rem", border: `3px solid ${FUNKY.danger}`, borderRadius: 8 }}>
          {error}
        </div>
      )}

      {phase === "lobby" && (
        <div className="fx-panel" style={{ gap: "1rem", minWidth: 360 }}>
          <label style={fieldCol}>
            <span>서버 주소</span>
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} style={inputStyle} placeholder="ws://localhost:8787" />
          </label>
          <Button variant="primary" size="lg" onClick={host}>
            방 만들기
          </Button>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="방 코드"
              style={{ ...inputStyle, flex: 1, textTransform: "uppercase", letterSpacing: "0.2em", textAlign: "center" }}
            />
            <Button variant="secondary" size="lg" onClick={join}>
              입장
            </Button>
          </div>
          <Button variant="neutral" size="md" onClick={onExit}>
            메뉴로
          </Button>
        </div>
      )}

      {phase === "room" && (
        <div className="fx-panel" style={{ gap: "0.9rem", minWidth: 400 }}>
          {/* 방 코드 */}
          <div style={{ textAlign: "center" }}>
            <Text variant="chrome" muted>
              방 코드
            </Text>
            <div style={{ fontSize: "2.6rem", fontWeight: 900, letterSpacing: "0.3em", color: P1_COLOR }}>{code || joinCode}</div>
          </div>

          {/* 로스터 */}
          <div style={{ display: "flex", gap: 8 }}>
            <RosterChip label={isHost ? "P1 (나)" : "P1 (상대)"} color={P1_COLOR} present />
            <RosterChip label={isHost ? "P2 (상대)" : "P2 (나)"} color={P2_COLOR} present={opponentPresent} />
          </div>

          {lastResult && (
            <div style={{ textAlign: "center", fontWeight: 900, color: lastResult === "win" ? FUNKY.green : FUNKY.danger }}>
              지난 판: {lastResult === "win" ? "승리" : "패배"}
            </div>
          )}

          {/* 설정 — 호스트 편집, 게스트 표시 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", opacity: isHost ? 1 : 0.85 }}>
            <NumField label="P1 공격 배수" value={mulP1} disabled={!isHost} onChange={(v) => applyEdit({ mulP1: v })} />
            <NumField label="P2 공격 배수" value={mulP2} disabled={!isHost} onChange={(v) => applyEdit({ mulP2: v })} />
            <ToggleField label="가비지(공격) 사용" value={garbage} disabled={!isHost} onChange={(v) => applyEdit({ garbage: v })} />
            <ToggleField label="교육 모드 (Ctrl+Z 되돌리기)" value={undo} disabled={!isHost} onChange={(v) => applyEdit({ undo: v })} />
            <ToggleField label="같은 조각 순서 공유" value={sharePieces} disabled={!isHost} onChange={(v) => applyEdit({ sharePieces: v })} />
          </div>
          <Text variant="chrome" muted style={{ fontSize: "0.72rem" }}>
            룰·킥테이블은 설정의 Custom 룰셋을 따릅니다. {isHost ? "" : "설정은 호스트가 조정합니다."}
          </Text>

          {isHost ? (
            <Button variant="primary" size="lg" onClick={startMatch} disabled={!opponentPresent}>
              {opponentPresent ? "대결 시작" : "상대 대기 중…"}
            </Button>
          ) : (
            <Text variant="chrome" muted style={{ textAlign: "center" }}>
              호스트가 시작하길 기다리는 중…
            </Text>
          )}
          <Button variant="neutral" size="md" onClick={leaveRoom}>
            방 나가기
          </Button>
        </div>
      )}
    </div>
  );
}

function BoardPane({ canvasRef, label, color }: { canvasRef: React.RefObject<HTMLCanvasElement>; label: string; color: string }) {
  return (
    <div className="fx-versus-pane" style={{ borderColor: color }}>
      <div className="fx-versus-label" style={{ color, borderColor: color }}>
        {label}
      </div>
      <div className="fx-canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

function RosterChip({ label, color, present }: { label: string; color: string; present: boolean }) {
  return (
    <div
      style={{
        flex: 1,
        textAlign: "center",
        fontWeight: 900,
        padding: "0.5rem",
        border: `3px solid ${present ? color : "#bbb"}`,
        borderRadius: 8,
        color: present ? color : "#bbb",
        background: present ? "rgba(0,0,0,0.03)" : "transparent",
      }}
    >
      {label}
      <div style={{ fontSize: "0.7rem", fontWeight: 800, opacity: 0.8 }}>{present ? "접속" : "대기"}</div>
    </div>
  );
}

const fieldCol: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontWeight: 800, fontSize: "0.85rem" };
const fieldRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 800, fontSize: "0.85rem" };
const inputStyle: React.CSSProperties = { padding: "0.6rem 0.8rem", border: "3px solid #000", borderRadius: 8, fontWeight: 800, fontSize: "1rem" };

function NumField({ label, value, onChange, disabled }: { label: string; value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <label style={fieldRow}>
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step={0.1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        style={{ ...inputStyle, width: 90, textAlign: "right", opacity: disabled ? 0.6 : 1 }}
      />
    </label>
  );
}

function ToggleField({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (b: boolean) => void; disabled?: boolean }) {
  return (
    <label style={{ ...fieldRow, cursor: disabled ? "default" : "pointer" }}>
      <span>{label}</span>
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ width: 22, height: 22 }} />
    </label>
  );
}
