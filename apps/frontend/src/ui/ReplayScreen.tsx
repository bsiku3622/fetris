import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Text, Badge } from "@studio-baeks/funky-ui";
import { REPLAY_FORMAT, verifyReplayFile } from "@fetris/engine/replay";
import type { ReplayFile } from "@fetris/engine/replay";
import { ReplaySession } from "../app/ReplaySession";
import type { Settings } from "../app/store";
import { FUNKY } from "../render/theme";

// ============================================================================
// ReplayScreen — 저장한 리플레이 파일을 열어 다시 보는 화면.
//
// 파일에는 시드·룰·핸들링·simRate가 들어 있어 그대로 재현된다. 열 때 한 번
// 지문을 대조해 파일이 온전한지 알려주고(재생 자체는 막지 않는다), 재생·정지·
// 속도·탐색을 붙인다. 보드 그리기는 ReplaySession이 React 밖에서 처리한다.
// ============================================================================

const SPEEDS = [0.25, 0.5, 1, 2, 4];

/** 60Hz 프레임을 mm:ss로 */
function timeOf(frames: number): string {
  const total = Math.floor(frames / 60);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Loaded = {
  file: ReplayFile;
  /** 지문 대조 결과 — 파일이 손상됐거나 다른 엔진 버전이면 어긋난다 */
  intact: boolean;
};

export function ReplayScreen({ settings, onExit }: { settings: Settings; onExit: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<ReplaySession | null>(null);

  // ---- 파일 열기 -----------------------------------------------------------
  const openFile = useCallback(async (f: File) => {
    setError("");
    try {
      const parsed = JSON.parse(await f.text()) as ReplayFile;
      if (parsed?.game !== "fetris" || !Array.isArray(parsed.keys)) {
        setError("Fetris 리플레이 파일이 아닌 것 같아요.");
        return;
      }
      if (parsed.format !== REPLAY_FORMAT) {
        setError(`지원하지 않는 리플레이 버전이에요 (파일 v${parsed.format} · 현재 v${REPLAY_FORMAT})`);
        return;
      }
      const { ok } = verifyReplayFile(parsed);
      setLoaded({ file: parsed, intact: ok });
      setFrame(0);
      setPlaying(false);
    } catch (e) {
      setError("파일을 읽을 수 없어요: " + (e instanceof Error ? e.message : String(e)));
    }
  }, []);

  // ---- 세션 구동 -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!loaded || !canvas) return;

    const session = new ReplaySession(canvas, loaded.file, { ...settings.gfx, nextCount: loaded.file.rule.nextCount }, {
      onProgress: (f, p) => {
        setFrame(f);
        setPlaying(p);
      },
      onEnd: () => setPlaying(false),
    });
    sessionRef.current = session;

    const onResize = () => session.resize();
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => session.resize());
    if (canvas.parentElement) ro.observe(canvas.parentElement);

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
          <div style={{ color: FUNKY.danger, fontWeight: 900, padding: "0.5rem 1rem", border: `3px solid ${FUNKY.danger}` }}>
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
            border: `3px dashed ${dragging ? FUNKY.sky : "var(--funky-line)"}`,
            background: dragging ? "var(--funky-sunken)" : "var(--funky-surface)",
            cursor: "pointer",
            fontWeight: 800,
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
  const { file, intact } = loaded;
  // 세션은 effect에서 만들어지므로 렌더 시점 값을 굳혀두면 항상 null이다.
  // 컨트롤은 누를 때마다 ref에서 최신 세션을 읽는다.
  const ctl = () => sessionRef.current;

  return (
    <div className="fx-room" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header className="fx-room-bar">
        <div className="fx-room-bar__title">
          REPLAY · {file.player.nick}
          {file.player.placement ? ` · #${file.player.placement}` : ""}
        </div>
        <button className="fx-room-exit" onClick={() => setLoaded(null)}>
          다른 파일
        </button>
      </header>

      {!intact && (
        <div
          style={{
            padding: "8px 14px",
            background: FUNKY.danger,
            color: "#fff",
            fontWeight: 800,
            fontSize: "0.82rem",
          }}
        >
          기록과 재현 결과가 어긋납니다 — 파일이 손상됐거나 다른 버전에서 만들어졌을 수 있어요. 재생은 되지만 실제 판과 다를 수 있습니다.
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0, padding: 12, gap: 12, boxSizing: "border-box" }}>
        {/* 보드 */}
        <div style={{ flex: "1 1 auto", display: "flex", justifyContent: "center" }}>
          <div style={{ width: "min(46%, 560px)", height: "100%", display: "flex" }}>
            <div className="fx-versus-pane" style={{ borderColor: FUNKY.sky, flex: 1 }}>
              <div className="fx-versus-label" style={{ color: FUNKY.sky, borderColor: FUNKY.sky }}>
                {file.player.nick}
              </div>
              <div className="fx-canvas-wrap">
                <canvas ref={canvasRef} />
              </div>
            </div>
          </div>
        </div>

        {/* 정보 */}
        <aside style={{ width: 230, flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
          <InfoCard title="기록">
            <Row k="플레이어" v={file.player.nick} />
            {file.match.code && <Row k="방" v={file.match.code} />}
            {file.player.placement ? <Row k="순위" v={`#${file.player.placement}`} /> : null}
            <Row k="일시" v={new Date(file.recordedAt).toLocaleString("ko-KR")} />
          </InfoCard>

          <InfoCard title="성적">
            <Row k="조각" v={String(file.stats?.piecesPlaced ?? "―")} />
            <Row k="라인" v={String(file.stats?.lines ?? "―")} />
            <Row k="공격" v={String(file.stats?.attack ?? "―")} />
            <Row k="길이" v={timeOf(file.frames)} />
          </InfoCard>

          <InfoCard title="조건">
            <Row k="simRate" v={`${file.simRate}Hz`} />
            <Row k="시드" v={String(file.seed)} />
            <Row k="입력" v={`${Math.floor(file.keys.length / 3)}회`} />
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
          borderTop: "3px solid var(--funky-line)",
          background: "var(--funky-surface)",
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
          max={file.frames}
          value={frame}
          onChange={(e) => ctl()?.seek(Number(e.target.value))}
          style={{ flex: 1, minWidth: 120, accentColor: FUNKY.sky }}
        />

        <span style={{ fontWeight: 900, fontSize: "0.8rem", fontVariantNumeric: "tabular-nums", minWidth: 96 }}>
          {timeOf(frame)} / {timeOf(file.frames)}
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
                padding: "4px 8px",
                border: `2px solid ${speed === x ? FUNKY.sky : "var(--funky-line)"}`,
                background: speed === x ? FUNKY.sky : "transparent",
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
    <div style={{ border: "2px solid var(--funky-line)", background: "var(--funky-surface)", padding: "10px 12px" }}>
      <div
        style={{
          fontSize: "0.66rem",
          fontWeight: 900,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          opacity: 0.5,
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
