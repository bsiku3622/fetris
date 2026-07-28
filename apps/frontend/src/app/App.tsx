import { useCallback, useEffect, useState } from "react";
import type { GameModeName } from "../engine/types";
import { loadSettings, saveSettings, defaultSettings } from "./store";
import type { Settings } from "./store";
import { MenuScreen } from "../ui/MenuScreen";
import { GameScreen } from "../ui/GameScreen";
import { SettingsScreen } from "../ui/SettingsScreen";
import { VersusScreen } from "../ui/VersusScreen";

type Screen = { name: "menu" } | { name: "game"; mode: GameModeName } | { name: "settings" } | { name: "versus" };

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [screen, setScreen] = useState<Screen>({ name: "menu" });

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<Settings> | ((s: Settings) => Settings)) => {
    setSettings((prev) => (typeof patch === "function" ? patch(prev) : { ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => setSettings(defaultSettings()), []);

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
      {screen.name === "versus" && <VersusScreen settings={settings} onExit={() => setScreen({ name: "menu" })} />}
      {screen.name === "game" && (
        <GameScreen mode={screen.mode} settings={settings} onExit={() => setScreen({ name: "menu" })} updateSettings={updateSettings} />
      )}
      {screen.name === "settings" && (
        <SettingsScreen settings={settings} updateSettings={updateSettings} onReset={reset} onBack={() => setScreen({ name: "menu" })} />
      )}
    </div>
  );
}
