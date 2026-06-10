import { useEffect, useRef, useState } from "react";
import { Button, Text } from "@studio-baeks/funky-ui";
import type { Settings } from "../app/store";
import type { RuleSet, KicksetName, SpinBonusName, GarbageHoleMode } from "../engine/types";
import { NetClient } from "../net/client";
import type { GameMessage, PlayerInfo } from "../net/protocol";
import { Side, FALLBACK_PEER_ID } from "../net/protocol";
import { VersusSession } from "../app/VersusSession";
import type { MatchResult } from "../app/VersusMatch";
import { FUNKY } from "../render/theme";

// ============================================================================
// VersusScreen — Custom Room 대전 (1v1 ~ 다대일 FFA, 최대 8인).
//  lobby:  방 만들기(인원 설정) / 코드로 입장
//  room:   대기실 — 코드·로스터·설정(호스트 편집, 게스트 표시) + 대결 시작
//  playing: 내 보드(크게) + 상대 보드들(그리드). 게임오버 → 라운드 집계 → 재대결.
// ============================================================================

type Phase = "lobby" | "room" | "playing";

interface RoomConfig {
  rule: RuleSet;
  attackMul: [number, number];
  undo: boolean;
  sharePieces: boolean;
  rounds: number;
}

interface PlayParams {
  rule: RuleSet;
  seed: number;
  side: Side;
  myAttackMul: number;
  undo: boolean;
  rounds: number;
  opponents: PlayerInfo[];
}

interface RoundState {
  myWins: number;
  oppWins: number;
}

const rnd = () => (Math.random() * 0xffffffff) >>> 0;

function humanError(reason: string): string {
  if (reason === "room-not-found") return "방을 찾을 수 없어요. 코드를 확인해주세요.";
  if (reason === "room-full") return "이미 꽉 찬 방이에요.";
  return "오류가 발생했어요: " + reason;
}

const P1_COLOR = FUNKY.sky;
const P2_COLOR = FUNKY.pink;
// 상대 보드 컬러 팔레트(FFA에서 순환)
const OPP_PALETTE = [FUNKY.pink, FUNKY.orange, FUNKY.green, FUNKY.purple, FUNKY.yellow, FUNKY.danger, FUNKY.sky];

type Cfg = {
  mulP1: number;
  mulP2: number;
  undo: boolean;
  garbage: boolean;
  sharePieces: boolean;
  kickset: KicksetName;
  spinBonus: SpinBonusName;
  b2bMode: "surge" | "chaining" | "none";
  garbageMultiplier: number;
  garbageMessiness: number;
  garbageCap: number;
  garbageHoleMode: GarbageHoleMode;
  perfectClearDamage: number;
  rounds: number;
};

const DEFAULT_CFG: Cfg = {
  mulP1: 1,
  mulP2: 1,
  undo: false,
  garbage: true,
  sharePieces: true,
  kickset: "SRS+",
  spinBonus: "all-mini+",
  b2bMode: "surge",
  garbageMultiplier: 1,
  garbageMessiness: 0.4,
  garbageCap: 8,
  garbageHoleMode: "clean",
  perfectClearDamage: 5,
  rounds: 3,
};

export function VersusScreen({ settings, onExit }: { settings: Settings; onExit: () => void }) {
  const [phase, setPhase] = useState<Phase>("lobby");
  const [isHost, setIsHost] = useState(true);
  const [code, setCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<MatchResult>(null);
  const [roundState, setRoundState] = useState<RoundState>({ myWins: 0, oppWins: 0 });
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [roster, setRoster] = useState<PlayerInfo[]>([]); // 나를 제외한 상대들
  const [targetId, setTargetId] = useState<string | null>(null);

  const roundStateRef = useRef<RoundState>({ myWins: 0, oppWins: 0 });
  const activeRoundsRef = useRef(3);
  const rosterRef = useRef<PlayerInfo[]>([]);

  const [serverUrl, setServerUrl] = useState(() => {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    return env?.VITE_FETRIS_WS_URL || "ws://localhost:8787";
  });

  const [cfg, setCfg] = useState<Cfg>(DEFAULT_CFG);

  const matchKeyRef = useRef(0);
  const [matchKey, setMatchKey] = useState(0);
  const nextRoundTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const netRef = useRef<NetClient | null>(null);
  const sessionRef = useRef<VersusSession | null>(null);
  const playParamsRef = useRef<PlayParams | null>(null);
  const roomCfgRef = useRef<RoomConfig | null>(null);
  const localCanvasRef = useRef<HTMLCanvasElement>(null);
  const oppCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const phaseRef = useRef<Phase>("lobby");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const cfgRef = useRef<Cfg>({ ...DEFAULT_CFG });
  const isHostRef = useRef(true);

  useEffect(() => {
    return () => {
      netRef.current?.disconnect();
      netRef.current = null;
      if (nextRoundTimerRef.current) clearTimeout(nextRoundTimerRef.current);
    };
  }, []);

  // 네트워크 입력은 신뢰 불가 — 구버전 서버나 누락 필드로 undefined가 섞이는 걸 방어
  const setRosterBoth = (next: PlayerInfo[] | undefined) => {
    const clean = (Array.isArray(next) ? next : []).filter((p): p is PlayerInfo => !!p && typeof p.id === "string");
    rosterRef.current = clean;
    setRoster(clean);
  };

  const ruleFromCfg = (c: Cfg): RuleSet => ({
    ...settings.rulesets.custom,
    garbageEnabled: c.garbage,
    kickset: c.kickset,
    spinBonus: c.spinBonus,
    b2bMode: c.b2bMode,
    garbageMultiplier: c.garbageMultiplier,
    garbageMessiness: c.garbageMessiness,
    garbageCap: c.garbageCap,
    garbageHoleMode: c.garbageHoleMode,
    perfectClearDamage: c.perfectClearDamage,
  });

  const beginPlaying = (p: PlayParams) => {
    if (nextRoundTimerRef.current) {
      clearTimeout(nextRoundTimerRef.current);
      nextRoundTimerRef.current = null;
    }
    matchKeyRef.current += 1;
    playParamsRef.current = p;
    activeRoundsRef.current = p.rounds;
    setTargetId(p.opponents[0]?.id ?? null);
    setResult(null);
    setMatchKey(matchKeyRef.current);
    setPhase("playing");
  };

  // 호스트: 다음 라운드를 새 시드로 시작(라운드 스코어 유지). 게스트는 start 메시지로 자동 전환.
  const startNextRound = () => {
    const net = netRef.current;
    if (!net || !isHostRef.current) return;
    const c = cfgRef.current;
    const seed = rnd();
    net.sendGame({ t: "start", seed });
    beginPlaying({ rule: ruleFromCfg(c), seed, side: Side.P1, myAttackMul: c.mulP1, undo: c.undo, rounds: c.rounds, opponents: [...rosterRef.current] });
  };

  const sendSettings = (net: NetClient) => {
    const c = cfgRef.current;
    net.sendGame({
      t: "settings",
      rule: ruleFromCfg(c),
      attackMul: [c.mulP1, c.mulP2],
      undo: c.undo,
      sharePieces: c.sharePieces,
      rounds: c.rounds,
    });
  };

  const applyEdit = (patch: Partial<Cfg>) => {
    const next = { ...cfgRef.current, ...patch };
    cfgRef.current = next;
    setCfg({ ...next });
    const net = netRef.current;
    if (net && isHostRef.current && phaseRef.current === "room") sendSettings(net);
  };

  const resetRound = () => {
    setRoundState({ myWins: 0, oppWins: 0 });
    roundStateRef.current = { myWins: 0, oppWins: 0 };
  };

  const host = async () => {
    setError("");
    setIsHost(true);
    isHostRef.current = true;
    resetRound();
    setRosterBoth([]);
    const net = new NetClient(serverUrl);
    netRef.current = net;
    net.onError = (r) => setError(humanError(r));
    net.onDisconnect = () => {
      if (phaseRef.current !== "playing") setError("서버 연결이 끊겼습니다.");
    };
    net.onCreated = (c) => {
      setCode(c);
      setRosterBoth([]);
      setPhase("room");
    };
    net.onPeerJoinedFull = (player) => {
      // 구버전 서버는 player를 안 보냄 → placeholder로 단일 상대 인식(1대1만 가능)
      const p: PlayerInfo = player && typeof player.id === "string" ? player : { id: FALLBACK_PEER_ID, isHost: false };
      setRosterBoth([...rosterRef.current.filter((x) => x.id !== p.id), p]);
      sendSettings(net); // 입장자에게 현재 설정 동기화
    };
    net.onPeerLeftById = (playerId) => {
      setRosterBoth(rosterRef.current.filter((p) => p.id !== playerId));
    };
    try {
      await net.connect();
      net.createRoom(maxPlayers);
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
    resetRound();
    setRosterBoth([]);
    const net = new NetClient(serverUrl);
    netRef.current = net;
    net.onError = (r) => setError(humanError(r));
    net.onDisconnect = () => {
      if (phaseRef.current !== "playing") setError("서버 연결이 끊겼습니다.");
    };
    net.onPlayerList = (players) => {
      setRosterBoth(players); // 입장 시점의 기존 플레이어들(나 제외)
    };
    net.onJoined = () => {
      // 구버전 서버는 players를 안 보냄 → 호스트 placeholder로 단일 상대 인식
      if (rosterRef.current.length === 0) setRosterBoth([{ id: FALLBACK_PEER_ID, isHost: true }]);
      setPhase("room");
    };
    net.onPeerJoinedFull = (player) => {
      if (!player || typeof player.id !== "string") return;
      setRosterBoth([...rosterRef.current.filter((p) => p.id !== player.id), player]);
    };
    net.onPeerLeftById = (playerId) => {
      setRosterBoth(rosterRef.current.filter((p) => p.id !== playerId));
    };
    net.onGameMessage = (m: GameMessage) => {
      if (m.t === "settings") {
        const newCfg: Cfg = {
          ...cfgRef.current,
          mulP1: m.attackMul[0],
          mulP2: m.attackMul[1],
          undo: m.undo,
          sharePieces: m.sharePieces,
          rounds: m.rounds ?? 3,
          garbage: m.rule.garbageEnabled,
          kickset: m.rule.kickset,
          spinBonus: m.rule.spinBonus,
          b2bMode: m.rule.b2bMode,
          garbageMultiplier: m.rule.garbageMultiplier,
          garbageMessiness: m.rule.garbageMessiness,
          garbageCap: m.rule.garbageCap ?? 8,
          garbageHoleMode: m.rule.garbageHoleMode ?? "clean",
          perfectClearDamage: m.rule.perfectClearDamage ?? 5,
        };
        cfgRef.current = newCfg;
        setCfg({ ...newCfg });
        roomCfgRef.current = { rule: m.rule, attackMul: m.attackMul, undo: m.undo, sharePieces: m.sharePieces, rounds: m.rounds ?? 3 };
      } else if (m.t === "start") {
        const roomCfg = roomCfgRef.current;
        if (!roomCfg) return;
        const seed = roomCfg.sharePieces ? m.seed : rnd();
        beginPlaying({
          rule: roomCfg.rule,
          seed,
          side: Side.P2,
          myAttackMul: roomCfg.attackMul[1],
          undo: roomCfg.undo,
          rounds: roomCfg.rounds,
          opponents: [...rosterRef.current],
        });
      }
    };
    try {
      await net.connect();
      net.joinRoom(joinCode);
    } catch {
      setError("서버에 연결할 수 없습니다. 주소를 확인해주세요.");
    }
  };

  const startMatch = () => {
    const net = netRef.current;
    if (!net || !isHost || rosterRef.current.length === 0) return;
    const c = cfgRef.current;
    sendSettings(net);
    const seed = rnd();
    net.sendGame({ t: "start", seed });
    beginPlaying({
      rule: ruleFromCfg(c),
      seed,
      side: Side.P1,
      myAttackMul: c.mulP1,
      undo: c.undo,
      rounds: c.rounds,
      opponents: [...rosterRef.current],
    });
  };

  const resetAndReturnToRoom = () => {
    resetRound();
    setResult(null);
    setPhase("room");
  };

  const leaveRoom = () => {
    netRef.current?.disconnect();
    netRef.current = null;
    if (nextRoundTimerRef.current) {
      clearTimeout(nextRoundTimerRef.current);
      nextRoundTimerRef.current = null;
    }
    setResult(null);
    resetRound();
    setRosterBoth([]);
    setCode("");
    setPhase("lobby");
  };

  // 대전 세션 구동
  useEffect(() => {
    if (phase !== "playing") return;
    const p = playParamsRef.current;
    const net = netRef.current;
    const lc = localCanvasRef.current;
    if (!p || !net || !lc) return;

    // roster 상대들의 canvas를 모아 Map 구성
    const remoteCanvases = new Map<string, HTMLCanvasElement>();
    for (const opp of p.opponents) {
      const cv = oppCanvasRefs.current.get(opp.id);
      if (cv) remoteCanvases.set(opp.id, cv);
    }

    const session = new VersusSession(
      lc,
      remoteCanvases,
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
      {
        onResult: (r) => {
          const next = {
            myWins: roundStateRef.current.myWins + (r === "win" ? 1 : 0),
            oppWins: roundStateRef.current.oppWins + (r === "lose" ? 1 : 0),
          };
          roundStateRef.current = next;
          setRoundState({ ...next });
          setResult(r);
          // FT 미달이면 호스트가 잠시 후 다음 라운드를 자동 시작(게스트는 start 메시지로 따라감)
          const ftN = activeRoundsRef.current;
          const matchOver = next.myWins >= ftN || next.oppWins >= ftN;
          if (!matchOver && isHostRef.current) {
            nextRoundTimerRef.current = setTimeout(() => startNextRound(), 2500);
          }
        },
      },
    );
    sessionRef.current = session;
    // 초기 타겟 설정
    session.match.setTarget(p.opponents[0]?.id ?? null);
    session.start();
    if (import.meta.env.DEV) (window as unknown as { __fetrisVersus?: VersusSession }).__fetrisVersus = session;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, matchKey]);

  // 타겟 변경 시 세션에 반영
  useEffect(() => {
    sessionRef.current?.match.setTarget(targetId);
  }, [targetId]);

  const myColor = isHost ? P1_COLOR : P2_COLOR;
  const matchOpponents = playParamsRef.current?.opponents ?? [];
  const isFFA = matchOpponents.length > 1;
  const ft = activeRoundsRef.current;
  const oppColorOf = (idx: number) => (isFFA ? OPP_PALETTE[idx % OPP_PALETTE.length] : isHost ? P2_COLOR : P1_COLOR);

  const isMatchOver = result !== null && (roundState.myWins >= ft || roundState.oppWins >= ft);
  const isMatchWin = isMatchOver && roundState.myWins >= ft;

  // 상대 보드 패널 (타겟 클릭 가능) — 공용 렌더러
  const renderOppPane = (opp: PlayerInfo, idx: number, style: React.CSSProperties, labelOverride?: string) => {
    const c = oppColorOf(idx);
    const isTargeted = targetId === opp.id;
    return (
      <div
        key={opp.id}
        onClick={() => setTargetId(opp.id)}
        style={{
          position: "relative",
          cursor: "pointer",
          border: isTargeted ? `3px solid ${FUNKY.danger}` : "3px solid transparent",
          borderRadius: 8,
          display: "flex",
          boxSizing: "border-box",
          ...style,
        }}
      >
        <OppBoardPane
          canvasRef={(el) => {
            if (el) oppCanvasRefs.current.set(opp.id, el);
            else oppCanvasRefs.current.delete(opp.id);
          }}
          label={labelOverride ?? `P${idx + 2}`}
          color={c}
        />
        {isTargeted && (
          <div style={{ position: "absolute", top: 4, right: 6, fontWeight: 900, fontSize: "0.7rem", color: FUNKY.danger, pointerEvents: "none", zIndex: 2 }}>
            🎯 TARGET
          </div>
        )}
      </div>
    );
  };

  // ---- 대전 화면 ----
  if (phase === "playing") {
    return (
      <div className="fx-versus">
        {/* 라운드 스코어보드 (1v1만) */}
        {!isFFA && (
          <div style={{ position: "absolute", top: 8, left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 10, pointerEvents: "none" }}>
            <RoundScoreboard myWins={roundState.myWins} oppWins={roundState.oppWins} ft={ft} myColor={myColor} oppColor={oppColorOf(0)} />
          </div>
        )}

        {!isFFA ? (
          // 2인: 나 | 상대 좌우 분할. 상단 스코어보드와 안 겹치게 보드를 아래로.
          <div style={{ display: "flex", width: "100%", height: "100%", gap: 8, padding: 8, paddingTop: 48, boxSizing: "border-box" }}>
            <div style={{ flex: "1 1 50%", display: "flex" }}>
              <BoardPane canvasRef={localCanvasRef} label={`YOU (${isHost ? "P1" : "P2"})`} color={myColor} />
            </div>
            {matchOpponents[0] && renderOppPane(matchOpponents[0], 0, { flex: "1 1 50%" }, `OPP (${isHost ? "P2" : "P1"})`)}
          </div>
        ) : (
          // 다대일(FFA): 나를 가운데 크게, 상대들은 오른쪽 위 구석부터 작게
          <div style={{ position: "relative", width: "100%", height: "100%", boxSizing: "border-box" }}>
            {/* 내 보드 — 화면 중앙 */}
            <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "center", alignItems: "center", padding: 12, boxSizing: "border-box" }}>
              <div style={{ width: "44%", height: "94%", display: "flex" }}>
                <BoardPane canvasRef={localCanvasRef} label={`YOU (${isHost ? "P1" : "P2"})`} color={myColor} />
              </div>
            </div>
            {/* 상대 보드들 — 오른쪽 위 구석부터 작게 작게, 줄바꿈(아래로) */}
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
              {matchOpponents.map((opp, idx) =>
                renderOppPane(opp, idx, { width: 150, height: 220, flex: "0 0 auto" }),
              )}
            </div>
          </div>
        )}

        {result && (
          <div className="fx-overlay">
            <div className="fx-panel">
              {isMatchOver ? (
                <>
                  <h2 style={{ color: isMatchWin ? FUNKY.green : FUNKY.danger }}>{isMatchWin ? "MATCH WIN!" : "MATCH LOSE"}</h2>
                  <div style={{ fontWeight: 800, opacity: 0.7, marginBottom: 8 }}>
                    {roundState.myWins} — {roundState.oppWins}
                  </div>
                  <Button variant="primary" size="lg" onClick={resetAndReturnToRoom}>
                    대기실로
                  </Button>
                </>
              ) : (
                <>
                  <h2 style={{ color: result === "win" ? FUNKY.green : FUNKY.danger }}>{result === "win" ? "ROUND WIN" : "ROUND LOSE"}</h2>
                  <div style={{ fontWeight: 800, opacity: 0.7, marginBottom: 8 }}>
                    {roundState.myWins} — {roundState.oppWins} / FT{ft}
                  </div>
                  <div style={{ fontWeight: 800, opacity: 0.6, marginBottom: 8 }}>
                    {isHost ? "다음 라운드 시작 중…" : "호스트가 다음 라운드를 시작합니다…"}
                  </div>
                </>
              )}
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
  const totalPlayers = roster.length + 1;
  return (
    <div className="fx-menu">
      <div className="fx-logo" style={{ fontSize: "2.5rem" }}>
        <span style={{ color: P1_COLOR }}>CUSTOM</span> <span style={{ color: P2_COLOR }}>ROOM</span>
      </div>
      <Text variant="chrome" muted>
        커스텀 룸 대전 (최대 8인)
      </Text>

      {error && (
        <div style={{ color: FUNKY.danger, fontWeight: 900, padding: "0.5rem 1rem", border: `3px solid ${FUNKY.danger}`, borderRadius: 8 }}>
          {error}
        </div>
      )}

      {phase === "lobby" && (
        <div className="fx-panel" style={{ gap: "1rem", minWidth: 360 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontWeight: 800, fontSize: "0.85rem" }}>
            <span>서버 주소</span>
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} style={inputStyle} placeholder="ws://localhost:8787" />
          </label>
          <SelectField
            label="방 인원"
            value={String(maxPlayers)}
            options={[2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: `${n}인` }))}
            onChange={(v) => setMaxPlayers(Number(v))}
          />
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
        <div className="fx-panel" style={{ gap: "0.8rem", minWidth: 440, maxHeight: "90vh", overflowY: "auto" }}>
          <div style={{ textAlign: "center" }}>
            <Text variant="chrome" muted>방 코드</Text>
            <div style={{ fontSize: "2.6rem", fontWeight: 900, letterSpacing: "0.3em", color: P1_COLOR }}>{code || joinCode}</div>
            <Text variant="chrome" muted style={{ fontSize: "0.72rem" }}>{totalPlayers}명 접속 중</Text>
          </div>

          {/* 로스터 */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <RosterChip label={isHost ? "나 (호스트)" : "나"} color={myColor} present />
            {roster.map((p, i) => (
              <RosterChip key={p.id} label={p.isHost ? "호스트" : `P${i + 2}`} color={oppColorOf(i)} present />
            ))}
          </div>

          {(roundState.myWins > 0 || roundState.oppWins > 0) && (
            <div style={{ textAlign: "center", fontWeight: 900, fontSize: "0.9rem" }}>
              <span style={{ color: myColor }}>{roundState.myWins}</span>
              <span style={{ opacity: 0.5 }}> — </span>
              <span style={{ color: P2_COLOR }}>{roundState.oppWins}</span>
              <span style={{ opacity: 0.5, fontSize: "0.75rem" }}> / FT{cfg.rounds}</span>
            </div>
          )}

          {/* 설정 */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", opacity: isHost ? 1 : 0.8 }}>
            <SectionLabel>매치 설정</SectionLabel>
            <SelectField
              label="라운드 (FT)"
              value={String(cfg.rounds)}
              disabled={!isHost}
              options={[
                { value: "1", label: "FT-1 (단판)" },
                { value: "3", label: "FT-3" },
                { value: "5", label: "FT-5" },
                { value: "7", label: "FT-7" },
              ]}
              onChange={(v) => applyEdit({ rounds: Number(v) })}
            />
            <NumField label="호스트 공격 배수" value={cfg.mulP1} min={0} step={0.1} disabled={!isHost} onChange={(v) => applyEdit({ mulP1: v })} />
            <NumField label="게스트 공격 배수" value={cfg.mulP2} min={0} step={0.1} disabled={!isHost} onChange={(v) => applyEdit({ mulP2: v })} />

            <SectionLabel>가비지 설정</SectionLabel>
            <ToggleField label="가비지(공격) 사용" value={cfg.garbage} disabled={!isHost} onChange={(v) => applyEdit({ garbage: v })} />
            <NumField label="가비지 배수" value={cfg.garbageMultiplier} min={0} max={5} step={0.1} disabled={!isHost} onChange={(v) => applyEdit({ garbageMultiplier: v })} />
            <NumField label="가비지 혼잡도" value={cfg.garbageMessiness} min={0} max={1} step={0.05} disabled={!isHost} onChange={(v) => applyEdit({ garbageMessiness: v })} />
            <NumField label="가비지 캡 (한 번에, 줄)" value={cfg.garbageCap} min={1} max={40} step={1} disabled={!isHost} onChange={(v) => applyEdit({ garbageCap: Math.round(v) })} />
            <SelectField
              label="방해줄 모양"
              value={cfg.garbageHoleMode}
              disabled={!isHost}
              options={[
                { value: "clean", label: "깔끔 (한 공격=한 줄)" },
                { value: "cheese", label: "치즈 (줄마다 랜덤)" },
              ]}
              onChange={(v) => applyEdit({ garbageHoleMode: v as GarbageHoleMode })}
            />
            <NumField label="퍼펙트 클리어 데미지" value={cfg.perfectClearDamage} min={0} max={20} step={1} disabled={!isHost} onChange={(v) => applyEdit({ perfectClearDamage: Math.round(v) })} />

            <SectionLabel>게임 규칙</SectionLabel>
            <SelectField
              label="킥 테이블"
              value={cfg.kickset}
              disabled={!isHost}
              options={[
                { value: "SRS+", label: "SRS+" },
                { value: "SRS-X", label: "SRS-X" },
                { value: "SRS", label: "SRS" },
                { value: "none", label: "없음" },
              ]}
              onChange={(v) => applyEdit({ kickset: v as KicksetName })}
            />
            <SelectField
              label="스핀 보너스"
              value={cfg.spinBonus}
              disabled={!isHost}
              options={[
                { value: "all-mini+", label: "올스핀 (all-mini+)" },
                { value: "all-mini", label: "올스핀 (all-mini)" },
                { value: "all", label: "올스핀 (all)" },
                { value: "t-spins", label: "T-스핀만" },
                { value: "none", label: "없음" },
              ]}
              onChange={(v) => applyEdit({ spinBonus: v as SpinBonusName })}
            />
            <SelectField
              label="B2B 모드"
              value={cfg.b2bMode}
              disabled={!isHost}
              options={[
                { value: "surge", label: "Surge (시즌2)" },
                { value: "chaining", label: "Chaining (시즌1)" },
                { value: "none", label: "없음" },
              ]}
              onChange={(v) => applyEdit({ b2bMode: v as "surge" | "chaining" | "none" })}
            />

            <SectionLabel>기타</SectionLabel>
            <ToggleField label="같은 조각 순서 공유" value={cfg.sharePieces} disabled={!isHost} onChange={(v) => applyEdit({ sharePieces: v })} />
            <ToggleField label="교육 모드 (Ctrl+Z)" value={cfg.undo} disabled={!isHost} onChange={(v) => applyEdit({ undo: v })} />
          </div>

          {!isHost && (
            <Text variant="chrome" muted style={{ fontSize: "0.72rem" }}>
              설정은 호스트가 조정합니다.
            </Text>
          )}

          {isHost ? (
            <Button variant="primary" size="lg" onClick={startMatch} disabled={roster.length === 0}>
              {roster.length > 0 ? "대결 시작" : "상대 대기 중…"}
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

function RoundScoreboard({ myWins, oppWins, ft, myColor, oppColor }: {
  myWins: number; oppWins: number; ft: number; myColor: string; oppColor: string;
}) {
  const dots = (wins: number, color: string) =>
    Array.from({ length: ft }, (_, i) => (
      <span
        key={i}
        style={{
          display: "inline-block",
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: i < wins ? color : "transparent",
          border: `2px solid ${color}`,
          margin: "0 2px",
        }}
      />
    ));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, background: "rgba(0,0,0,0.5)", padding: "4px 16px", borderRadius: 20, backdropFilter: "blur(4px)" }}>
      <span>{dots(myWins, myColor)}</span>
      <span style={{ fontWeight: 900, fontSize: "0.85rem", opacity: 0.7 }}>FT{ft}</span>
      <span>{dots(oppWins, oppColor)}</span>
    </div>
  );
}

function BoardPane({ canvasRef, label, color }: { canvasRef: React.RefObject<HTMLCanvasElement>; label: string; color: string }) {
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

function OppBoardPane({ canvasRef, label, color }: { canvasRef: (el: HTMLCanvasElement | null) => void; label: string; color: string }) {
  return (
    <div className="fx-versus-pane" style={{ borderColor: color, flex: 1, minWidth: 0 }}>
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
        flex: "1 1 auto",
        minWidth: 80,
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontWeight: 900, fontSize: "0.7rem", letterSpacing: "0.08em", opacity: 0.5, marginTop: 4, textTransform: "uppercase" }}>
      {children}
    </div>
  );
}

const fieldRow: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 800, fontSize: "0.85rem" };
const inputStyle: React.CSSProperties = { padding: "0.6rem 0.8rem", border: "3px solid #000", borderRadius: 8, fontWeight: 800, fontSize: "1rem" };

function NumField({
  label, value, onChange, disabled, min = 0, max, step = 0.1,
}: {
  label: string; value: number; onChange: (n: number) => void; disabled?: boolean; min?: number; max?: number; step?: number;
}) {
  return (
    <label style={fieldRow}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          const clamped = max !== undefined ? Math.min(max, Math.max(min, v)) : Math.max(min, v);
          onChange(isNaN(clamped) ? min : clamped);
        }}
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

function SelectField({
  label, value, options, onChange, disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label style={fieldRow}>
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, width: 160, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1, appearance: "auto" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
