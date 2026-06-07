import { useEffect, useRef, useState } from "react";
import { Button } from "@studio-baeks/funky-ui";
import type { GameModeName } from "../engine/types";
import type { Settings } from "../app/store";
import { loadRecords, saveRecords } from "../app/store";
import { GameSession } from "../app/GameSession";
import type { HudInfo, ModeResult } from "../engine/modes";

export function GameScreen({
  mode,
  settings,
  onExit,
}: {
  mode: GameModeName;
  settings: Settings;
  onExit: () => void;
  updateSettings: (p: Partial<Settings> | ((s: Settings) => Settings)) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const fpsRef = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<ModeResult | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const rule = settings.rulesets[mode];
    const seed = (Math.random() * 0xffffffff) >>> 0;

    // 통계는 캔버스에 직접 그려짐(필드 가장자리 정렬). 여기선 FPS만 갱신.
    const applyHud = (_hud: HudInfo, fps: number) => {
      if (fpsRef.current) fpsRef.current.textContent = `${fps} FPS`;
    };

    const session = new GameSession(
      canvas,
      mode,
      {
        rule,
        handling: settings.handling,
        keymap: settings.keymap,
        gfx: { ...settings.gfx, nextCount: rule.nextCount },
        audio: settings.audio,
        perf: settings.perf,
        seed,
      },
      {
        onHud: applyHud,
        onPauseToggle: () => setPaused((p) => !p),
        onEnd: (r) => {
          setResult(r);
          // 기록 갱신
          const rec = loadRecords();
          if (mode === "sprint" && r.completed && (rec.sprint40 == null || r.timeMs < rec.sprint40)) {
            rec.sprint40 = r.timeMs;
            saveRecords(rec);
          }
          if (mode === "blitz" && (rec.blitz == null || r.score > rec.blitz)) {
            rec.blitz = r.score;
            saveRecords(rec);
          }
        },
      },
    );
    sessionRef.current = session;
    session.start();

    // dev 전용: Playwright 검증/성능 측정용 핸들 노출
    if (import.meta.env.DEV) {
      (window as unknown as { __fetris?: GameSession }).__fetris = session;
    }

    const onResize = () => session.resize();
    window.addEventListener("resize", onResize);
    // canvas가 아니라 부모(wrap)를 관찰 — canvas 버퍼 변경이 루프를 만들지 않게
    const ro = new ResizeObserver(() => session.resize());
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    return () => {
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      session.destroy();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // pause 상태를 세션에 반영
  useEffect(() => {
    const s = sessionRef.current;
    if (!s) return;
    if (paused) s.pause();
    else s.resume();
  }, [paused]);

  const retry = () => {
    setResult(null);
    setPaused(false);
    sessionRef.current?.retry();
  };

  return (
    <div className="fx-game">
      <div className="fx-canvas-wrap">
        <canvas ref={canvasRef} />
        <div className="fx-fps" ref={fpsRef}>
          60 FPS
        </div>

        {paused && !result && (
          <div className="fx-overlay">
            <div className="fx-panel">
              <h2>일시정지</h2>
              <Button variant="primary" size="lg" onClick={() => setPaused(false)}>
                계속하기
              </Button>
              <Button variant="secondary" size="lg" onClick={retry}>
                다시하기
              </Button>
              <Button variant="neutral" size="lg" onClick={onExit}>
                메뉴로
              </Button>
            </div>
          </div>
        )}

        {result && (
          <div className="fx-overlay">
            <div className="fx-panel">
              <h2>{result.completed ? "완료!" : "게임 오버"}</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <ResultRow label={result.metricLabel} value={result.metricValue} big />
                <ResultRow label="LINES" value={String(result.lines)} />
                <ResultRow label="PPS" value={result.pps.toFixed(2)} />
              </div>
              <Button variant="primary" size="lg" onClick={retry}>
                다시하기
              </Button>
              <Button variant="neutral" size="lg" onClick={onExit}>
                메뉴로
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultRow({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "2px solid #000", paddingBottom: 4 }}>
      <span style={{ fontWeight: 900, color: "#6f6a52", fontSize: "0.8rem", letterSpacing: "0.05em" }}>{label}</span>
      <span style={{ fontWeight: 900, fontSize: big ? "2rem" : "1.1rem", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
