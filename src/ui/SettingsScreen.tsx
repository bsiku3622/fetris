import { Button, Tabs, Text } from "@studio-baeks/funky-ui";
import type { Settings } from "../app/store";
import type { Handling, GameModeName, RuleSet } from "../engine/types";
import type { KeyMap } from "../engine/input";
import { Row, Slider, Toggle, Segmented, KeyBind } from "./controls";

const fmtFrameMs = (f: number) => `${f}f / ${Math.round((f * 1000) / 60)}ms`;

export function SettingsScreen({
  settings,
  updateSettings,
  onReset,
  onBack,
}: {
  settings: Settings;
  updateSettings: (p: Partial<Settings> | ((s: Settings) => Settings)) => void;
  onReset: () => void;
  onBack: () => void;
}) {
  const setHandling = (patch: Partial<Handling>) => updateSettings((s) => ({ ...s, handling: { ...s.handling, ...patch } }));
  const setGfx = (patch: Partial<Settings["gfx"]>) => updateSettings((s) => ({ ...s, gfx: { ...s.gfx, ...patch } }));
  const setAudio = (patch: Partial<Settings["audio"]>) => updateSettings((s) => ({ ...s, audio: { ...s.audio, ...patch } }));
  const setPerf = (patch: Partial<Settings["perf"]>) => updateSettings((s) => ({ ...s, perf: { ...s.perf, ...patch } }));
  const setKey = (action: keyof KeyMap, codes: string[]) =>
    updateSettings((s) => ({ ...s, keymap: { ...s.keymap, [action]: codes } }));

  const h = settings.handling;

  return (
    <div className="fx-settings">
      <div className="fx-settings-head">
        <Text variant="heading" as="h1" style={{ margin: 0 }}>
          설정
        </Text>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button variant="danger" onClick={onReset}>
            초기화
          </Button>
          <Button variant="primary" onClick={onBack}>
            완료
          </Button>
        </div>
      </div>

      <div className="fx-settings-body">
        <Tabs defaultValue="handling">
          <Tabs.List>
            <Tabs.Trigger value="handling">Handling</Tabs.Trigger>
            <Tabs.Trigger value="controls">Controls</Tabs.Trigger>
            <Tabs.Trigger value="graphics">Graphics</Tabs.Trigger>
            <Tabs.Trigger value="audio">Audio</Tabs.Trigger>
            <Tabs.Trigger value="perf">Performance</Tabs.Trigger>
            <Tabs.Trigger value="rules">Rules</Tabs.Trigger>
          </Tabs.List>

          {/* ---- Handling ---- */}
          <Tabs.Panel value="handling">
            <div className="fx-section">
              <Row label="DAS" desc="좌우 자동 이동 시작 지연 (낮을수록 빠름)">
                <Slider value={h.das} min={0} max={20} step={0.5} onChange={(v) => setHandling({ das: v })} format={fmtFrameMs} />
              </Row>
              <Row label="ARR" desc="자동 이동 간격 (0 = 즉시 벽까지)">
                <Slider value={h.arr} min={0} max={5} step={0.5} onChange={(v) => setHandling({ arr: v })} format={fmtFrameMs} />
              </Row>
              <Row label="DCD" desc="회전/스폰 시 DAS 컷 (0 = 비활성)">
                <Slider value={h.dcd} min={0} max={5} step={0.5} onChange={(v) => setHandling({ dcd: v })} format={fmtFrameMs} />
              </Row>
              <Row label="SDF" desc="소프트드롭 배속 (41 = 즉시)">
                <Slider value={h.sdf == null || h.sdf > 41 ? 41 : h.sdf} min={5} max={41} step={1} onChange={(v) => setHandling({ sdf: v })} format={(v) => (v >= 41 ? "∞" : `${v}×`)} />
              </Row>
              <Row label="Prevent Accidental Hard Drops" desc="하드드롭 후 키를 떼야 다시 발동(실수 방지)">
                <Toggle value={h.safelock} onChange={(v) => setHandling({ safelock: v })} />
              </Row>
              <Row label="Cancel DAS When Changing Directions" desc="방향 전환 시 DAS 리셋">
                <Toggle value={h.cancelDas} onChange={(v) => setHandling({ cancelDas: v })} />
              </Row>
              <Row label="Prefer Soft Drop Over Movement" desc="같은 프레임에 소프트드롭을 좌우 이동보다 우선">
                <Toggle value={h.preferSoftDrop} onChange={(v) => setHandling({ preferSoftDrop: v })} />
              </Row>
            </div>
          </Tabs.Panel>

          {/* ---- Controls ---- */}
          <Tabs.Panel value="controls">
            <div className="fx-section">
              {(
                [
                  ["moveLeft", "왼쪽 이동"],
                  ["moveRight", "오른쪽 이동"],
                  ["softDrop", "소프트 드롭"],
                  ["hardDrop", "하드 드롭"],
                  ["rotateCW", "시계 회전"],
                  ["rotateCCW", "반시계 회전"],
                  ["rotate180", "180° 회전"],
                  ["hold", "홀드"],
                  ["retry", "다시하기"],
                  ["pause", "일시정지"],
                ] as [keyof KeyMap, string][]
              ).map(([action, label]) => (
                <Row key={action} label={label}>
                  <KeyBind codes={settings.keymap[action]} onChange={(c) => setKey(action, c)} />
                </Row>
              ))}
              <Text variant="body" muted style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
                키 버튼을 누르고 새 키를 입력하세요. Esc로 취소. 최대 2개까지 매핑됩니다.
              </Text>
            </div>
          </Tabs.Panel>

          {/* ---- Graphics ---- */}
          <Tabs.Panel value="graphics">
            <div className="fx-section">
              <Row label="고스트 피스">
                <Toggle value={settings.gfx.ghost} onChange={(v) => setGfx({ ghost: v })} />
              </Row>
              <Row label="고스트 투명도">
                <Slider value={settings.gfx.ghostOpacity} min={0} max={1} step={0.05} onChange={(v) => setGfx({ ghostOpacity: v })} format={(v) => v.toFixed(2)} />
              </Row>
              <Row label="그리드">
                <Toggle value={settings.gfx.grid} onChange={(v) => setGfx({ grid: v })} />
              </Row>
              <Row label="블록 3D 입체감">
                <Toggle value={settings.gfx.block3d} onChange={(v) => setGfx({ block3d: v })} />
              </Row>
              <Row label="보드 불투명도">
                <Slider value={settings.gfx.boardOpacity} min={0.3} max={1} step={0.05} onChange={(v) => setGfx({ boardOpacity: v })} format={(v) => v.toFixed(2)} />
              </Row>
              <Row label="라인클리어 플래시">
                <Toggle value={settings.gfx.flashOnClear} onChange={(v) => setGfx({ flashOnClear: v })} />
              </Row>
              <Row label="화면 흔들림" desc="강도">
                <Slider value={settings.gfx.screenShake} min={0} max={1} step={0.05} onChange={(v) => setGfx({ screenShake: v })} format={(v) => v.toFixed(2)} />
              </Row>
              <Row label="파티클" desc="양">
                <Slider value={settings.gfx.particles} min={0} max={1} step={0.05} onChange={(v) => setGfx({ particles: v })} format={(v) => v.toFixed(2)} />
              </Row>
            </div>
          </Tabs.Panel>

          {/* ---- Audio ---- */}
          <Tabs.Panel value="audio">
            <div className="fx-section">
              <Row label="사운드 켜기">
                <Toggle value={settings.audio.enabled} onChange={(v) => setAudio({ enabled: v })} />
              </Row>
              <Row label="마스터 볼륨">
                <Slider value={settings.audio.master} min={0} max={1} step={0.05} onChange={(v) => setAudio({ master: v })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="효과음 볼륨">
                <Slider value={settings.audio.sfx} min={0} max={1} step={0.05} onChange={(v) => setAudio({ sfx: v })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="음악 볼륨">
                <Slider value={settings.audio.music} min={0} max={1} step={0.05} onChange={(v) => setAudio({ music: v })} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
            </div>
          </Tabs.Panel>

          {/* ---- Performance ---- */}
          <Tabs.Panel value="perf">
            <div className="fx-section">
              <Row label="시뮬레이션 레이트" desc="입력→반응 지연. 높을수록 반응 빠름 (메커니즘은 60Hz 기준 일관)">
                <Segmented
                  value={settings.perf.simRate}
                  options={[
                    { label: "60Hz", value: 60 },
                    { label: "120Hz", value: 120 },
                    { label: "240Hz", value: 240 },
                  ]}
                  onChange={(v) => setPerf({ simRate: v })}
                />
              </Row>
              <Row label="프레임 제한" desc="렌더 상한. 무제한 = 디스플레이 주사율">
                <Segmented
                  value={settings.perf.renderFps}
                  options={[
                    { label: "무제한", value: 0 },
                    { label: "60", value: 60 },
                    { label: "120", value: 120 },
                    { label: "144", value: 144 },
                  ]}
                  onChange={(v) => setPerf({ renderFps: v })}
                />
              </Row>
              <Row label="보간(Interpolation)" desc="고주사율 부드러운 낙하">
                <Toggle value={settings.perf.interpolate} onChange={(v) => setPerf({ interpolate: v })} />
              </Row>
              <Row label="Low-latency 입력">
                <Toggle value={settings.perf.lowLatency} onChange={(v) => setPerf({ lowLatency: v })} />
              </Row>
            </div>
          </Tabs.Panel>

          {/* ---- Rules ---- */}
          <Tabs.Panel value="rules">
            <RulesEditor settings={settings} updateSettings={updateSettings} />
          </Tabs.Panel>
        </Tabs>
      </div>
    </div>
  );
}

const MODE_NAMES: { mode: GameModeName; label: string }[] = [
  { mode: "zen", label: "Zen" },
  { mode: "custom", label: "Custom" },
  { mode: "marathon", label: "Marathon" },
];

function RulesEditor({ settings, updateSettings }: { settings: Settings; updateSettings: (p: (s: Settings) => Settings) => void }) {
  const setRule = (mode: GameModeName, patch: Partial<RuleSet>) =>
    updateSettings((s) => ({ ...s, rulesets: { ...s.rulesets, [mode]: { ...s.rulesets[mode], ...patch } } }));

  return (
    <div className="fx-section">
      <Text variant="body" muted style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}>
        Zen·Custom·Marathon은 룰을 자유롭게 조정할 수 있습니다. 40 Lines·Blitz는 공정성을 위해 표준 룰 고정입니다.
      </Text>
      <Tabs defaultValue="zen">
        <Tabs.List>
          {MODE_NAMES.map((m) => (
            <Tabs.Trigger key={m.mode} value={m.mode}>
              {m.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {MODE_NAMES.map((m) => {
          const r = settings.rulesets[m.mode];
          return (
            <Tabs.Panel key={m.mode} value={m.mode}>
              <Row label="보드 너비">
                <Slider value={r.cols} min={4} max={20} step={1} onChange={(v) => setRule(m.mode, { cols: v })} />
              </Row>
              <Row label="중력 (G)">
                <Slider value={r.gravity} min={0} max={20} step={0.01} onChange={(v) => setRule(m.mode, { gravity: v })} format={(v) => v.toFixed(2)} />
              </Row>
              <Row label="Lock Delay">
                <Slider value={r.lockDelay} min={0} max={120} step={1} onChange={(v) => setRule(m.mode, { lockDelay: v })} format={fmtFrameMs} />
              </Row>
              <Row label="Kickset">
                <Segmented
                  value={r.kickset}
                  options={[
                    { label: "SRS+", value: "SRS+" as const },
                    { label: "SRS", value: "SRS" as const },
                    { label: "SRS-X", value: "SRS-X" as const },
                    { label: "None", value: "none" as const },
                  ]}
                  onChange={(v) => setRule(m.mode, { kickset: v })}
                />
              </Row>
              <Row label="180° 회전">
                <Toggle value={r.allow180} onChange={(v) => setRule(m.mode, { allow180: v })} />
              </Row>
              <Row label="Spin Bonus">
                <Segmented
                  value={r.spinBonus}
                  options={[
                    { label: "None", value: "none" as const },
                    { label: "T", value: "t-spins" as const },
                    { label: "All-Mini+", value: "all-mini+" as const },
                    { label: "All", value: "all" as const },
                  ]}
                  onChange={(v) => setRule(m.mode, { spinBonus: v })}
                />
              </Row>
              <Row label="Bag Type">
                <Segmented
                  value={r.randomizer}
                  options={[
                    { label: "7-bag", value: "7-bag" as const },
                    { label: "14-bag", value: "14-bag" as const },
                    { label: "Classic", value: "classic" as const },
                    { label: "Random", value: "random" as const },
                  ]}
                  onChange={(v) => setRule(m.mode, { randomizer: v })}
                />
              </Row>
              <Row label="NEXT 개수">
                <Slider value={r.nextCount} min={0} max={7} step={1} onChange={(v) => setRule(m.mode, { nextCount: v })} />
              </Row>
              <Row label="Hold">
                <Toggle value={r.holdEnabled} onChange={(v) => setRule(m.mode, { holdEnabled: v })} />
              </Row>
              <Row label="B2B 모드">
                <Segmented
                  value={r.b2bMode}
                  options={[
                    { label: "Surge", value: "surge" as const },
                    { label: "Chaining", value: "chaining" as const },
                    { label: "None", value: "none" as const },
                  ]}
                  onChange={(v) => setRule(m.mode, { b2bMode: v })}
                />
              </Row>
            </Tabs.Panel>
          );
        })}
      </Tabs>
    </div>
  );
}
