import { useCallback, useEffect, useState } from "react";
import type { GameModeName } from "@fetris/engine/types";
import { loadSettings, saveSettings, defaultSettings } from "./store";
import type { Settings } from "./store";
import { useRoomSession } from "./roomSession";
import { MenuScreen } from "../ui/MenuScreen";
import { GameScreen } from "../ui/GameScreen";
import { SettingsScreen } from "../ui/SettingsScreen";
import { VersusScreen } from "../ui/VersusScreen";
import { RoomBanner } from "../ui/RoomBanner";

type Screen = { name: "menu" } | { name: "game"; mode: GameModeName } | { name: "settings" } | { name: "versus" };

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [screen, setScreen] = useState<Screen>({ name: "menu" });
  // 방 연결은 화면보다 위에서 산다 — 대기 중 Zen을 하러 나가도 방은 유지된다
  const room = useRoomSession();

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // 매치가 시작되면 어디에 있든 대전 화면으로 소환한다
  const pending = room.matchStart;
  useEffect(() => {
    if (pending && screen.name !== "versus") setScreen({ name: "versus" });
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
          onSettings={() => setScreen({ name: "settings" })}
        />
      )}
      {screen.name === "versus" && (
        <VersusScreen
          settings={settings}
          room={room}
          onExit={() => setScreen({ name: "menu" })}
          // 대기 중에는 Zen만 할 수 있다(기록 모드는 소환당하면 판이 날아간다)
          onPlayZen={() => setScreen({ name: "game", mode: "zen" })}
        />
      )}
      {screen.name === "game" && (
        <GameScreen mode={screen.mode} settings={settings} onExit={() => setScreen({ name: "menu" })} updateSettings={updateSettings} />
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
