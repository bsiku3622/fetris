import { useCallback, useEffect, useRef, useState } from "react";
import type { GameModeName } from "@fetris/engine/types";
import { loadSettings, saveSettings, defaultSettings } from "./store";
import type { Settings } from "./store";
import { useRoomSession } from "./roomSession";
import { MenuScreen } from "../ui/MenuScreen";
import { GameScreen } from "../ui/GameScreen";
import { SettingsScreen } from "../ui/SettingsScreen";
import { VersusScreen } from "../ui/VersusScreen";
import { ReplayScreen } from "../ui/ReplayScreen";
import { RoomBanner } from "../ui/RoomBanner";

type Screen =
  | { name: "menu" }
  | { name: "game"; mode: GameModeName }
  | { name: "settings" }
  | { name: "versus" }
  | { name: "replay" };

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [screen, setScreen] = useState<Screen>({ name: "menu" });
  // 방 연결은 화면보다 위에서 산다 — 대기 중 Zen을 하러 나가도 방은 유지된다
  const room = useRoomSession();

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  /*
    매치가 시작되면 어디에 있든 대전 화면으로 소환한다 — 단 **판마다 한 번만**.

    `matchStart`는 대전 화면이 계속 참조하므로 판이 끝나도 비워지지 않는다.
    "값이 있으면 소환"으로 두면 지난 판 정보 때문에 대기실에서 다른 화면으로
    갈 수가 없다 — Zen을 눌러도 즉시 되돌려져 버튼이 죽은 것처럼 보인다.
  */
  const pending = room.matchStart;
  const summoned = useRef(-1);
  useEffect(() => {
    if (!pending || summoned.current === pending.matchId) return;
    summoned.current = pending.matchId;
    if (screen.name !== "versus") setScreen({ name: "versus" });
  }, [pending, screen.name]);

  const updateSettings = useCallback((patch: Partial<Settings> | ((s: Settings) => Settings)) => {
    setSettings((prev) => (typeof patch === "function" ? patch(prev) : { ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => setSettings(defaultSettings()), []);

  const inRoom = !!room.state;

  return (
    <div className="fx-app">
      {screen.name === "menu" && (
        <MenuScreen
          settings={settings}
          onPlay={(mode) => setScreen({ name: "game", mode })}
          onPlayVersus={() => setScreen({ name: "versus" })}
          onReplays={() => setScreen({ name: "replay" })}
          onSettings={() => setScreen({ name: "settings" })}
        />
      )}
      {screen.name === "versus" && (
        <VersusScreen
          settings={settings}
          updateSettings={updateSettings}
          room={room}
          onExit={() => setScreen({ name: "menu" })}
          // 대기 중에는 Zen만 할 수 있다(기록 모드는 소환당하면 판이 날아간다)
          onPlayZen={() => setScreen({ name: "game", mode: "zen" })}
        />
      )}
      {screen.name === "game" && (
        <GameScreen mode={screen.mode} settings={settings} onExit={() => setScreen({ name: "menu" })} updateSettings={updateSettings} />
      )}
      {screen.name === "replay" && (
        <ReplayScreen settings={settings} onExit={() => setScreen({ name: "menu" })} />
      )}
      {screen.name === "settings" && (
        <SettingsScreen settings={settings} updateSettings={updateSettings} onReset={reset} onBack={() => setScreen({ name: "menu" })} />
      )}

      {inRoom && screen.name !== "versus" && (
        <RoomBanner room={room} onReturn={() => setScreen({ name: "versus" })} />
      )}
    </div>
  );
}
