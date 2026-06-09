import { useEffect, useRef } from "react";
import { Button, Text } from "@studio-baeks/funky-ui";
import type { GameModeName } from "../engine/types";
import type { Settings } from "../app/store";
import { loadRecords } from "../app/store";
import { fmtTime } from "../engine/modes";
import { SoundEngine } from "../audio/sound";

const MODES: { mode: GameModeName; name: string; desc: string }[] = [
  { mode: "sprint", name: "40 Lines", desc: "40줄을 가장 빠르게" },
  { mode: "blitz", name: "Blitz", desc: "2분간 최고 점수" },
  { mode: "zen", name: "Zen", desc: "톱아웃 없는 무한 연습" },
  { mode: "marathon", name: "Marathon", desc: "중력이 점점 빨라진다" },
  { mode: "fourwide", name: "4-Wide", desc: "4칸 좁은 보드 Zen" },
  { mode: "combo", name: "Combo", desc: "4칸 보드 · 가비지 보충 콤보 연습" },
  { mode: "custom", name: "Custom 1v1", desc: "온라인 커스텀 방 대전" },
];

const SHAPES = [
  { c: "#ff4eba", x: "8%", y: "20%", s: 70 },
  { c: "#3decfd", x: "85%", y: "15%", s: 90 },
  { c: "#ffd500", x: "78%", y: "70%", s: 60 },
  { c: "#7828c8", x: "12%", y: "72%", s: 80 },
  { c: "#00c22a", x: "90%", y: "45%", s: 50 },
  { c: "#ff9100", x: "5%", y: "45%", s: 45 },
];

export function MenuScreen({
  settings,
  onPlay,
  onPlayVersus,
  onSettings,
}: {
  settings: Settings;
  onPlay: (m: GameModeName) => void;
  onPlayVersus: () => void;
  onSettings: () => void;
}) {
  const records = loadRecords();

  // 로비 음악 — 메뉴 진입 시 재생(첫 사용자 제스처에서 자동 활성화)
  const engineRef = useRef<SoundEngine | null>(null);
  useEffect(() => {
    const eng = new SoundEngine(settings.audio);
    engineRef.current = eng;
    eng.startMusic("lobby");
    return () => eng.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fx-menu">
      <div className="fx-bg-shapes">
        {SHAPES.map((s, i) => (
          <div
            key={i}
            className="fx-shape"
            style={{ left: s.x, top: s.y, width: s.s, height: s.s, background: s.c, animationDelay: `${i * 0.7}s` }}
          />
        ))}
      </div>

      <div className="fx-logo" style={{ zIndex: 2 }}>
        <span style={{ color: "#ff4eba" }}>F</span>
        <span style={{ color: "#ff9100" }}>E</span>
        <span style={{ color: "#ffd500" }}>T</span>
        <span style={{ color: "#00c22a" }}>R</span>
        <span style={{ color: "#00c8ff" }}>I</span>
        <span style={{ color: "#7828c8" }}>S</span>
      </div>
      <Text variant="chrome" muted style={{ zIndex: 2 }}>
        funky offline tetris
      </Text>

      <div className="fx-mode-grid">
        {MODES.map((m) => {
          let rec = "";
          if (m.mode === "sprint" && records.sprint40 != null) rec = fmtTime(records.sprint40);
          if (m.mode === "blitz" && records.blitz != null) rec = records.blitz.toLocaleString();
          return (
            <button key={m.mode} className="fx-mode-card" onClick={() => (m.mode === "custom" ? onPlayVersus() : onPlay(m.mode))}>
              <div className="name">{m.name}</div>
              <div className="desc">{m.desc}</div>
              {rec && <div className="desc" style={{ marginTop: 6, fontWeight: 900, color: "#222" }}>★ {rec}</div>}
            </button>
          );
        })}
      </div>

      <div style={{ zIndex: 2 }}>
        <Button variant="neutral" size="lg" onClick={onSettings}>
          ⚙ 설정
        </Button>
      </div>
    </div>
  );
}
