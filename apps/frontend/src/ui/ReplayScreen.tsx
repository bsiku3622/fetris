import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Text, Badge } from "@studio-baeks/funky-ui";
import { MATCH_REPLAY_FORMAT, REPLAY_FORMAT, verifyMatchReplayFile } from "@fetris/engine/replay";
import type { MatchReplayFile, ReplayFile } from "@fetris/engine/replay";
import { ReplaySession } from "../app/ReplaySession";
import type { Settings } from "../app/store";
import { FUNKY } from "../render/theme";

// ============================================================================
// ReplayScreen — 저장한 판을 열어 다시 보는 화면.
//
// 파일 하나에 그 판의 참가자가 전부 들어 있어, 모든 보드를 나란히 되돌려 본다.
// 열 때 참가자별로 지문을 대조해 온전한지 알려주고(재생 자체는 막지 않는다),
// 재생·정지·속도·탐색을 붙인다. 보드 그리기는 ReplaySession이 React 밖에서 한다.
// ============================================================================

const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** 보드마다 다른 테두리색 — 누구 화면인지 한눈에 */
const PANE_COLORS = [FUNKY.sky, FUNKY.pink, FUNKY.green, FUNKY.orange, FUNKY.purple, FUNKY.yellow];

/** 60Hz 프레임을 mm:ss로 */
function timeOf(frames: number): string {
  const total = Math.floor(frames / 60);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Loaded = {
  file: MatchReplayFile;
  /** 참가자별 지문 대조 결과 — 손상됐거나 다른 엔진 버전이면 어긋난다 */
  broken: string[];
};

/** 참가자 한 명짜리 옛 파일(v1)을 매치 파일로 감싼다 */
function fromLegacy(f: ReplayFile): MatchReplayFile {
  return {
    format: MATCH_REPLAY_FORMAT,
    game: "fetris",
    recordedAt: f.recordedAt,
    match: { code: f.match.code, matchId: f.match.matchId },
    rule: f.rule,
    handling: f.handling,
    simRate: f.simRate,
    players: [
      {
        id: f.player.id ?? f.player.nick,
        nick: f.player.nick,
        placement: f.player.placement,
        seed: f.seed,
        frames: f.frames,
        keys: f.keys,
        garbage: f.garbage,
        fingerprint: f.fingerprint,
        stats: f.stats,
      },
    ],
  };
}

export function ReplayScreen({ settings, onExit }: { settings: Settings; onExit: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const sessionRef = useRef<ReplaySession | null>(null);

  // ---- 파일 열기 -----------------------------------------------------------
  const openFile = useCallback(async (f: File) => {
    setError("");
    try {
      const parsed = JSON.parse(await f.text()) as MatchReplayFile | ReplayFile;
      if (parsed?.game !== "fetris") {
        setError("Fetris 리플레이 파일이 아닌 것 같아요.");
        return;
      }
      let match: MatchReplayFile;
      if (parsed.format === MATCH_REPLAY_FORMAT) {
        match = parsed as MatchReplayFile;
        if (!Array.isArray(match.players) || match.players.length === 0) {
          setError("참가자 기록이 비어 있어요.");
          return;
        }
      } else if (parsed.format === REPLAY_FORMAT) {
        match = fromLegacy(parsed as ReplayFile);
      } else {
        const v = (parsed as { format?: number }).format;
        setError(`지원하지 않는 리플레이 버전이에요 (파일 v${v} · 현재 v${MATCH_REPLAY_FORMAT})`);
        return;
      }
      const broken = verifyMatchReplayFile(match)
        .filter((r) => !r.ok)
        .map((r) => r.nick);
      setLoaded({ file: match, broken });
      setFrame(0);
      setPlaying(false);
    } catch (e) {
      setError("파일을 읽을 수 없어요: " + (e instanceof Error ? e.message : String(e)));
    }
  }, []);

  // ---- 세션 구동 -----------------------------------------------------------
  useEffect(() => {
    if (!loaded) return;
    const canvases = new Map(canvasRefs.current);
    if (canvases.size === 0) return;

    const session = new ReplaySession(
      canvases,
      loaded.file,
      { ...settings.gfx, nextCount: loaded.file.rule.nextCount },
      settings.audio,
      {
        onProgress: (f, p) => {
          setFrame(f);
          setPlaying(p);
        },
        onEnd: () => setPlaying(false),
      },
    );
    sessionRef.current = session;

    const onResize = () => session.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => session.resize());
    for (const c of canvases.values()) if (c.parentElement) ro.observe(c.parentElement);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      session.destroy();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // ---- 단축키 --------------------------------------------------------------
  useEffect(() => {
    if (!loaded) return;
    const onKey = (e: KeyboardEvent) => {
      const s = sessionRef.current;
      if (!s) return;
      if (e.code === "Space") {
        e.preventDefault();
        s.toggle();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        s.seek(s.frame - (e.shiftKey ? 60 : 1));
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        s.seek(s.frame + (e.shiftKey ? 60 : 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loaded]);

  // ---- 파일 선택 화면 ------------------------------------------------------
  if (!loaded) {
    return (
      <div className="fx-menu">
        <div className="fx-logo" style={{ fontSize: "2.2rem" }}>
          <span style={{ color: FUNKY.sky }}>REPLAY</span>
        </div>
        <Text variant="chrome" muted>저장한 판을 다시 봅니다</Text>

        {error && (
          <div
            style={{
              color: "#ffb4b4",
              fontWeight: 800,
              padding: "0.55rem 1.1rem",
              borderRadius: 10,
              border: `1px solid ${FUNKY.danger}`,
              background: "rgba(255,59,59,0.14)",
            }}
          >
            {error}
          </div>
        )}

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files[0];
            if (f) void openFile(f);
          }}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            width: 420,
            height: 220,
            border: `2px dashed ${dragging ? FUNKY.sky : "var(--funky-line)"}`,
            borderRadius: 14,
            background: dragging ? "rgba(0,200,255,0.08)" : "var(--funky-surface)",
            cursor: "pointer",
            fontWeight: 800,
            transition: "border-color 0.14s ease-out, background-color 0.14s ease-out",
          }}
        >
          <div style={{ fontSize: "1.1rem", fontWeight: 900 }}>리플레이 파일 열기</div>
          <div style={{ opacity: 0.6, fontSize: "0.82rem" }}>여기로 끌어다 놓거나 클릭해서 고르세요</div>
          <div style={{ opacity: 0.45, fontSize: "0.72rem" }}>대전이 끝난 뒤 "리플레이 저장"으로 받은 .json</div>
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void openFile(f);
            }}
          />
        </label>

        <Button variant="neutral" size="md" onClick={onExit}>
          메뉴로
        </Button>
      </div>
    );
  }

  // ---- 재생 화면 -----------------------------------------------------------
  const { file, broken } = loaded;
  const intact = broken.length === 0;
  const winner = file.players.find((p) => p.id === file.match.winnerId);
  // 보드가 늘어날수록 한 칸을 좁게 — 2명까지는 크게, 그 이상은 격자로 채운다
  const cols = Math.min(file.players.length, file.players.length <= 2 ? 2 : 3);
  // 길이는 입력 로그와 서버 녹화 중 더 긴 쪽을 따른다
  const lastMs = file.timeline?.length ? file.timeline[file.timeline.length - 1].ms : 0;
  const frames = Math.max(
    file.players.reduce((m, p) => Math.max(m, p.frames ?? 0), 0),
    Math.ceil((lastMs / 1000) * 60),
  );
  const paneWidth = `calc(${(100 / cols).toFixed(2)}% - ${((cols - 1) * 10) / cols}px)`;
  // 세션은 effect에서 만들어지므로 렌더 시점 값을 굳혀두면 항상 null이다.
  // 컨트롤은 누를 때마다 ref에서 최신 세션을 읽는다.
  const ctl = () => sessionRef.current;

  return (
    <div className="fx-room" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header className="fx-room-bar">
        <div className="fx-room-bar__title">
          REPLAY · {file.match.code ?? "LOCAL"} #{file.match.matchId}
          {winner ? ` · ${winner.nick} 승리` : ""}
        </div>
        <button className="fx-room-exit" onClick={() => setLoaded(null)}>
          다른 파일
        </button>
      </header>

      {!intact && (
        <div
          style={{
            padding: "8px 14px",
            background: "rgba(255,59,59,0.16)",
            borderBottom: `1px solid ${FUNKY.danger}`,
            color: "#ffb4b4",
            fontWeight: 800,
            fontSize: "0.82rem",
          }}
        >
          {broken.join(", ")} 의 기록이 재현 결과와 어긋납니다 — 파일이 손상됐거나 다른 버전에서
          만들어졌을 수 있어요. 재생은 되지만 실제 판과 다를 수 있습니다.
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0, padding: 12, gap: 12, boxSizing: "border-box" }}>
        {/* 보드 — 참가자 전원을 나란히 */}
        <div
          style={{
            flex: "1 1 auto",
            display: "flex",
            flexWrap: "wrap",
            alignContent: "stretch",
            justifyContent: "center",
            gap: 10,
            minWidth: 0,
          }}
        >
          {file.players.map((p, i) => {
            const color = PANE_COLORS[i % PANE_COLORS.length];
            return (
              <div
                key={p.id}
                style={{
                  width: paneWidth,
                  minWidth: 160,
                  display: "flex",
                  height: cols >= 3 && file.players.length > 3 ? "calc(50% - 5px)" : "100%",
                }}
              >
                <div className="fx-versus-pane" style={{ borderColor: color, flex: 1 }}>
                  <div className="fx-versus-label" style={{ color, borderColor: color }}>
                    {p.nick}
                    {p.placement ? ` #${p.placement}` : ""}
                  </div>
                  <div className="fx-canvas-wrap">
                    <canvas
                      ref={(el) => {
                        if (el) {
                          canvasRefs.current.set(p.id, el);
                          sessionRef.current?.rebind(p.id, el);
                        } else {
                          canvasRefs.current.delete(p.id);
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* 정보 */}
        <aside style={{ width: 230, flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
          <InfoCard title="매치">
            {file.match.code && <Row k="방" v={file.match.code} />}
            <Row k="판" v={`#${file.match.matchId}`} />
            <Row k="참가" v={`${file.players.length}명`} />
            <Row k="길이" v={timeOf(frames)} />
            <Row k="일시" v={new Date(file.recordedAt).toLocaleString("ko-KR")} />
          </InfoCard>

          <InfoCard title="성적">
            {file.players.map((p) => (
              <Row
                key={p.id}
                k={`${p.placement ? `#${p.placement} ` : ""}${p.nick}`}
                v={`${p.stats?.lines ?? "―"}줄 · ${p.stats?.attack ?? "―"}공격`}
              />
            ))}
          </InfoCard>

          <InfoCard title="조건">
            <Row k="simRate" v={`${file.simRate}Hz`} />
            <Row k="입력" v={`${file.players.reduce((n, p) => n + Math.floor((p.keys?.length ?? 0) / 3), 0)}회`} />
            {file.timeline?.length ? <Row k="녹화" v={`${file.timeline.length}장`} /> : null}
            <div style={{ marginTop: 6 }}>
              {intact ? <Badge color="green">검증됨</Badge> : <Badge color="pink">불일치</Badge>}
            </div>
          </InfoCard>
        </aside>
      </div>

      {/* 컨트롤 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          borderTop: "1px solid var(--funky-line)",
          background: "rgba(0,0,0,0.22)",
        }}
      >
        <Button variant="primary" size="md" onClick={() => ctl()?.toggle()}>
          {playing ? "⏸ 일시정지" : "▶ 재생"}
        </Button>
        <Button variant="neutral" size="md" onClick={() => ctl()?.seek(0)}>
          ⏮ 처음
        </Button>

        <input
          type="range"
          min={0}
          max={frames}
          value={frame}
          onChange={(e) => ctl()?.seek(Number(e.target.value))}
          style={{ flex: 1, minWidth: 120, accentColor: FUNKY.sky }}
        />

        <span style={{ fontWeight: 900, fontSize: "0.8rem", fontVariantNumeric: "tabular-nums", minWidth: 96 }}>
          {timeOf(frame)} / {timeOf(frames)}
        </span>

        <div style={{ display: "flex", gap: 4 }}>
          {SPEEDS.map((x) => (
            <button
              key={x}
              onClick={() => {
                ctl()?.setSpeed(x);
                setSpeed(x);
              }}
              style={{
                padding: "4px 9px",
                borderRadius: 6,
                border: `1px solid ${speed === x ? "transparent" : "var(--funky-line)"}`,
                background: speed === x ? FUNKY.sky : "transparent",
                color: speed === x ? "#14101f" : "var(--funky-ink-muted)",
                fontWeight: 900,
                fontSize: "0.72rem",
                cursor: "pointer",
              }}
            >
              {x}×
            </button>
          ))}
        </div>

        <Button variant="neutral" size="md" onClick={onExit}>
          메뉴로
        </Button>
      </div>

      <div style={{ padding: "0 14px 10px", fontSize: "0.7rem", opacity: 0.5, fontWeight: 700 }}>
        Space 재생/정지 · ← → 한 프레임 · Shift+← → 1초
      </div>
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--funky-line)", borderRadius: 10, background: "var(--funky-surface)", padding: "10px 12px" }}>
      <div
        style={{
          fontSize: "0.66rem",
          fontWeight: 900,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--funky-ink-muted)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: "0.78rem", fontWeight: 800, padding: "2px 0" }}>
      <span style={{ opacity: 0.55 }}>{k}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right", wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}
