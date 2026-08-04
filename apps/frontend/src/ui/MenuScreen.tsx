import { useEffect, useRef } from "react";
import { Button, Text } from "@studio-baeks/funky-ui";
import type { GameModeName } from "@fetris/engine/types";
import type { Settings } from "../app/store";
import { loadRecords } from "../app/store";
import { fmtTime } from "@fetris/engine/modes";
import { SoundEngine } from "../audio/sound";

/**
 * 혼자 하는 여섯 판.
 *
 * 온라인 대전은 여기서 뺐다 — 성격이 다른 데다, 일곱 칸은 어떻게 놓아도 격자가
 * 어긋나 화면이 정돈되지 않는다. 여섯이면 3×2로 딱 떨어지고 대전은 아래에서
 * 넓은 칸 하나로 따로 눈에 띈다.
 */
const MODES: { mode: GameModeName; name: string; desc: string }[] = [
  { mode: "sprint", name: "40 Lines", desc: "40줄을 가장 빠르게" },
  { mode: "blitz", name: "Blitz", desc: "2분간 최고 점수" },
  { mode: "zen", name: "Zen", desc: "톱아웃 없는 무한 연습" },
  { mode: "marathon", name: "Marathon", desc: "중력이 점점 빨라진다" },
  { mode: "fourwide", name: "4-Wide", desc: "4칸 좁은 보드 Zen" },
  { mode: "combo", name: "Combo", desc: "4칸 보드 · 콤보 연습" },
];

/**
 * 배경에서 천천히 흐르는 빛.
 *
 * 셋이면 충분하다. 여섯 색을 사방에 번지게 두면 무대 그라디언트를 덮어버려
 * 배경이 배경 노릇을 못 한다 — 뒤에서 은은하게 움직이기만 하면 된다.
 * 색도 무대와 같은 계열로 좁혀 화면이 한 덩어리로 읽히게 한다.
 */
const SHAPES = [
  { c: "#7828c8", x: "-6%", y: "10%", s: 420 },
  { c: "#ff4eba", x: "72%", y: "58%", s: 380 },
  { c: "#3decfd", x: "58%", y: "-10%", s: 300 },
];

export function MenuScreen({
  settings,
  onPlay,
  onPlayVersus,
  onReplays,
  onSettings,
}: {
  settings: Settings;
  onPlay: (m: GameModeName) => void;
  onPlayVersus: () => void;
  onReplays: () => void;
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
        funky online tetris
      </Text>

      <div className="fx-mode-grid">
        {MODES.map((m) => {
          let rec = "";
          if (m.mode === "sprint" && records.sprint40 != null) rec = fmtTime(records.sprint40);
          if (m.mode === "blitz" && records.blitz != null) rec = records.blitz.toLocaleString();
          return (
            <button key={m.mode} className="fx-mode-card" onClick={() => onPlay(m.mode)}>
              <div className="name">{m.name}</div>
              <div className="desc">{m.desc}</div>
              {rec && <div className="rec">★ {rec}</div>}
            </button>
          );
        })}
      </div>

      {/* 온라인 대전은 성격이 달라 따로 둔다 — 넓은 칸 하나로 눈에 띄게 */}
      <button className="fx-versus-cta" onClick={onPlayVersus}>
        <span className="name">Custom Room</span>
        <span className="desc">온라인 커스텀 방 · 라스트맨 스탠딩</span>
      </button>

      <div style={{ zIndex: 2, display: "flex", gap: "0.6rem" }}>
        <Button variant="neutral" size="lg" onClick={onReplays}>
          ▶ 리플레이
        </Button>
        <Button variant="neutral" size="lg" onClick={onSettings}>
          ⚙ 설정
        </Button>
      </div>
    </div>
  );
}
