import { useState } from "react";
import { Button, Tabs, Text } from "@studio-baeks/funky-ui";
import type { Settings, KeymapPreset } from "../app/store";
import type { Handling, GameModeName, RuleSet } from "../engine/types";
import type { KeyMap } from "../engine/input";
import { KEYMAP_PRESETS, keymapHasPreset, addPresetToKeymap, removePresetFromKeymap, GAME_ACTIONS, SYSTEM_ACTIONS } from "../engine/input";
import { GFX_PRESETS } from "../render/renderer";
import { Row, Slider, Toggle, Segmented, KeySlot } from "./controls";

const fmtFrameMs = (f: number) => `${f}f / ${Math.round((f * 1000) / 60)}ms`;

const ACTION_LABELS: Record<keyof KeyMap, string> = {
  moveLeft: "왼쪽 이동",
  moveRight: "오른쪽 이동",
  softDrop: "소프트 드롭",
  hardDrop: "하드 드롭",
  rotateCW: "시계 회전",
  rotateCCW: "반시계 회전",
  rotate180: "180° 회전",
  hold: "홀드",
  retry: "다시하기",
  pause: "일시정지",
};

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
  const [gfxPreset, setGfxPreset] = useState<string | null>(null);
  const setGfx = (patch: Partial<Settings["gfx"]>) => {
    setGfxPreset(null); // 수동 조정 시 프리셋 강조 해제
    updateSettings((s) => ({ ...s, gfx: { ...s.gfx, ...patch } }));
  };
  const applyGfxPreset = (p: (typeof GFX_PRESETS)[number]) => {
    setGfxPreset(p.id);
    updateSettings((s) => ({ ...s, gfx: { ...s.gfx, ...p.gfx } }));
  };
  const setAudio = (patch: Partial<Settings["audio"]>) => updateSettings((s) => ({ ...s, audio: { ...s.audio, ...patch } }));
  const setPerf = (patch: Partial<Settings["perf"]>) => updateSettings((s) => ({ ...s, perf: { ...s.perf, ...patch } }));
  // 슬롯 i에 키 지정 — 같은 액션 내 중복 제거 후 교체/추가(최대 3개)
  const setKeyAt = (action: keyof KeyMap, i: number, code: string) =>
    updateSettings((s) => {
      let arr = (s.keymap[action] ?? []).slice(0, 3).filter(Boolean);
      arr = arr.filter((c) => c !== code); // 다른 슬롯에 있던 동일 키 제거
      if (i < arr.length) arr[i] = code;
      else arr.push(code);
      arr = arr.slice(0, 3);
      return { ...s, keymap: { ...s.keymap, [action]: arr } };
    });
  const clearKeyAt = (action: keyof KeyMap, i: number) =>
    updateSettings((s) => {
      const arr = (s.keymap[action] ?? []).slice(0, 3).filter(Boolean);
      arr.splice(i, 1);
      return { ...s, keymap: { ...s.keymap, [action]: arr } };
    });
  // 프리셋 = 기본 + 유저 커스텀. 활성 여부는 현재 키맵에서 역산(프리셋 키를 모두 포함하면 활성).
  const allPresets: (KeymapPreset & { custom: boolean })[] = [
    ...KEYMAP_PRESETS.map((p) => ({ id: p.id, label: p.label, keymap: p.keymap, custom: false })),
    ...settings.customPresets.map((p) => ({ ...p, custom: true })),
  ];
  // 프리셋 토글 — 비활성이면 현재 키맵에 합치고, 활성이면 그 프리셋 키를 전부 제거.
  const togglePreset = (preset: KeyMap) =>
    updateSettings((s) => ({
      ...s,
      keymap: keymapHasPreset(s.keymap, preset) ? removePresetFromKeymap(s.keymap, preset) : addPresetToKeymap(s.keymap, preset),
    }));
  // 커스텀 프리셋 — 현재 키맵을 이름 붙여 저장 / 삭제.
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const saveCustomPreset = () => {
    const label = draftName.trim();
    if (label) {
      updateSettings((s) => ({
        ...s,
        customPresets: [...s.customPresets, { id: "custom-" + Date.now(), label, keymap: structuredClone(s.keymap) }],
      }));
    }
    setNaming(false);
    setDraftName("");
  };
  const deleteCustomPreset = (id: string) => updateSettings((s) => ({ ...s, customPresets: s.customPresets.filter((p) => p.id !== id) }));

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
        <Tabs defaultValue="profile">
          <Tabs.List>
            <Tabs.Trigger value="profile">Profile</Tabs.Trigger>
            <Tabs.Trigger value="handling">Handling</Tabs.Trigger>
            <Tabs.Trigger value="controls">Controls</Tabs.Trigger>
            <Tabs.Trigger value="graphics">Graphics</Tabs.Trigger>
            <Tabs.Trigger value="audio">Audio</Tabs.Trigger>
            <Tabs.Trigger value="perf">Performance</Tabs.Trigger>
            <Tabs.Trigger value="rules">Rules</Tabs.Trigger>
          </Tabs.List>

          {/* ---- Profile ---- */}
          <Tabs.Panel value="profile">
            <div className="fx-section">
              <Row label="닉네임" desc="대전 방에서 다른 플레이어에게 보이는 이름 (최대 16자)">
                <input
                  value={settings.profile.nickname}
                  maxLength={16}
                  onChange={(e) => updateSettings((s) => ({ ...s, profile: { ...s.profile, nickname: e.target.value } }))}
                  style={{ padding: "0.5rem 0.7rem", border: "3px solid #000", borderRadius: 8, fontWeight: 800, fontSize: "1rem", width: 220 }}
                />
              </Row>
            </div>
          </Tabs.Panel>

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
              <div className="fx-preset-bar">
                <span className="fx-preset-label">프리셋</span>
                {allPresets.map((p) => (
                  <span key={p.id} className="fx-preset-chip">
                    <Button variant={keymapHasPreset(settings.keymap, p.keymap) ? "primary" : "secondary"} onClick={() => togglePreset(p.keymap)}>
                      {p.label}
                    </Button>
                    {p.custom && (
                      <button className="fx-preset-del" title="프리셋 삭제" onClick={() => deleteCustomPreset(p.id)}>
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {naming ? (
                  <input
                    className="fx-preset-name"
                    autoFocus
                    value={draftName}
                    placeholder="프리셋 이름"
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={saveCustomPreset}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveCustomPreset();
                      else if (e.key === "Escape") {
                        setNaming(false);
                        setDraftName("");
                      }
                    }}
                  />
                ) : (
                  <Button variant="secondary" onClick={() => setNaming(true)}>
                    + 현재 키맵 저장
                  </Button>
                )}
                <span className="fx-preset-hint">여러 개 선택 시 합쳐서 적용</span>
              </div>
              <div className="fx-keygroup-label">게임 키</div>
              {GAME_ACTIONS.map((action) => (
                <Row key={action} label={ACTION_LABELS[action]}>
                  <div className="fx-keyslots">
                    {[0, 1, 2].map((i) => (
                      <KeySlot key={i} code={settings.keymap[action][i] ?? null} onSet={(c) => setKeyAt(action, i, c)} onClear={() => clearKeyAt(action, i)} />
                    ))}
                  </div>
                </Row>
              ))}
              <div className="fx-keygroup-label">시스템 키</div>
              {SYSTEM_ACTIONS.map((action) => (
                <Row key={action} label={ACTION_LABELS[action]}>
                  <div className="fx-keyslots">
                    {[0, 1, 2].map((i) => (
                      <KeySlot key={i} code={settings.keymap[action][i] ?? null} onSet={(c) => setKeyAt(action, i, c)} onClear={() => clearKeyAt(action, i)} />
                    ))}
                  </div>
                </Row>
              ))}
              <Text variant="body" muted style={{ fontSize: "0.8rem", marginTop: "0.5rem" }}>
                슬롯을 누르고 새 키를 입력하세요. 한 동작에 최대 3개. 활성화된 슬롯을 다시 누르면 해제, Esc로 취소. 프리셋은 게임 키만 바꿉니다.
              </Text>
            </div>
          </Tabs.Panel>

          {/* ---- Graphics ---- */}
          <Tabs.Panel value="graphics">
            <div className="fx-section">
              <div className="fx-preset-bar">
                <span className="fx-preset-label">프리셋</span>
                {GFX_PRESETS.map((p) => (
                  <Button key={p.id} variant={gfxPreset === p.id ? "primary" : "secondary"} onClick={() => applyGfxPreset(p)}>
                    {p.label}
                  </Button>
                ))}
              </div>
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
              <Row label="배경 화려함" desc="네온 블롭 밝기">
                <Slider value={settings.gfx.bgIntensity} min={0} max={1} step={0.05} onChange={(v) => setGfx({ bgIntensity: v })} format={(v) => v.toFixed(2)} />
              </Row>
              <Row label="블록 글로우" desc="네온 발광 세기">
                <Slider value={settings.gfx.glow} min={0} max={1} step={0.05} onChange={(v) => setGfx({ glow: v })} format={(v) => v.toFixed(2)} />
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
