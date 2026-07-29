import { useEffect, useRef, useState } from "react";
import { Button, Text, Badge, Tabs } from "@studio-baeks/funky-ui";
import type { Settings } from "../app/store";
import type { RuleSet, KicksetName, SpinBonusName, GarbageHoleMode, RandomizerName } from "@fetris/engine/types";
import { isTauri, lanStart, lanStop, lanDiscover } from "../net/lan";
import type { LanInfo } from "../net/lan";
import type { BotRunnerInfo, MatchConfig, PlayerInfo } from "../net/protocol";
import type { RoomSession } from "../app/roomSession";
import type { ReplayFile } from "@fetris/engine/replay";
import { MatchStage } from "./MatchStage";
import { FUNKY } from "../render/theme";

// ============================================================================
// VersusScreen — 커스텀 룸(라스트맨 스탠딩).
//  연결 없음 → 로비(방 만들기 / 코드 입장)
//  lobby     → 대기실(로스터·설정·봇·채팅)
//  playing   → MatchStage(대전 + 관전)
//  results   → 순위표
//
// 매치 진행은 서버가 소유한다. 이 화면은 서버가 알려준 phase를 그대로 따를 뿐
// 스스로 판을 시작하거나 승패를 정하지 않는다.
// ============================================================================

const OPP_PALETTE = [FUNKY.pink, FUNKY.orange, FUNKY.green, FUNKY.purple, FUNKY.yellow, FUNKY.danger, FUNKY.sky];

type Cfg = {
  /** 먼저 N승하면 시리즈 종료. 0 = 목표 없이 계속 */
  firstTo: number;
  attackMul: number;
  undo: boolean;
  garbage: boolean;
  sharePieces: boolean;
  kickset: KicksetName;
  spinBonus: SpinBonusName;
  b2bMode: "surge" | "chaining" | "none";
  garbageMultiplier: number;
  garbageMessiness: number;
  garbageCap: number;
  garbageHoleMode: GarbageHoleMode;
  garbageSpeed: number;
  perfectClearDamage: number;
  gravity: number;
  lockDelay: number;
  are: number;
  randomizer: RandomizerName;
  nextCount: number;
  allow180: boolean;
};

const DEFAULT_CFG: Cfg = {
  firstTo: 0,
  attackMul: 1,
  undo: false,
  garbage: true,
  sharePieces: true,
  kickset: "SRS+",
  spinBonus: "all-mini+",
  b2bMode: "surge",
  garbageMultiplier: 1,
  garbageMessiness: 0,
  garbageCap: 8,
  garbageHoleMode: "clean",
  garbageSpeed: 20,
  perfectClearDamage: 5,
  gravity: 0.02,
  lockDelay: 30,
  are: 0,
  randomizer: "7-bag",
  nextCount: 5,
  allow180: true,
};

export function VersusScreen({
  settings,
  room,
  onExit,
  onPlayZen,
}: {
  settings: Settings;
  room: RoomSession;
  onExit: () => void;
  onPlayZen: () => void;
}) {
  const [joinCode, setJoinCode] = useState("");
  // 0 = 제한 없음(기본). 관전자는 어차피 정원에 안 잡힌다.
  const [maxPlayers, setMaxPlayers] = useState(0);
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_CFG);
  const [chatInput, setChatInput] = useState("");
  const [serverUrl, setServerUrl] = useState(() => {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    return env?.VITE_FETRIS_WS_URL || "ws://localhost:8787";
  });
  const [lanInfo, setLanInfo] = useState<LanInfo | null>(null);
  const [hostIp, setHostIp] = useState("");
  const [discovering, setDiscovering] = useState(false);

  const myNick = settings.profile?.nickname?.trim() || "Player";
  const state = room.state;
  const me = state?.players.find((p) => p.id === room.myId) ?? null;
  const isHost = !!me?.isHost;
  /**
   * 설정을 실제로 바꿀 수 있는 상태. 서버는 대기실에서만 설정을 받으므로,
   * 그 밖에서는 입력을 잠근다 — 안 그러면 화면의 값만 바뀌고 서버는 예전 설정을
   * 그대로 들고 있어 "골랐는데 안 먹는다"가 된다.
   */
  const canEdit = isHost && state?.phase === "lobby";

  useEffect(() => {
    return () => {
      if (isTauri()) lanStop().catch(() => {});
    };
  }, []);

  const ruleFromCfg = (c: Cfg): RuleSet => ({
    ...settings.rulesets.custom,
    garbageEnabled: c.garbage,
    kickset: c.kickset,
    spinBonus: c.spinBonus,
    b2bMode: c.b2bMode,
    garbageMultiplier: c.garbageMultiplier,
    garbageMessiness: c.garbageMessiness,
    garbageCap: c.garbageCap,
    garbageHoleMode: c.garbageHoleMode,
    garbageSpeed: c.garbageSpeed,
    perfectClearDamage: c.perfectClearDamage,
    gravity: c.gravity,
    lockDelay: c.lockDelay,
    are: c.are,
    randomizer: c.randomizer,
    nextCount: c.nextCount,
    allow180: c.allow180,
  });

  const configFrom = (c: Cfg): MatchConfig => ({
    rule: ruleFromCfg(c),
    handling: settings.handling,
    // 리플레이 검증이 같은 조건으로 재현해야 하므로 simRate를 매치에 못박는다
    simRate: settings.perf.simRate,
    sharePieces: c.sharePieces,
    undo: c.undo,
    attackMul: c.attackMul,
    firstTo: c.firstTo,
  });

  /** 호스트가 설정을 만지면 서버에 밀어넣어 방 전체에 반영한다 */
  const applyEdit = (patch: Partial<Cfg>) => {
    if (!canEdit) return; // 서버가 받지 않을 변경은 화면에도 반영하지 않는다
    const next = { ...cfg, ...patch };
    setCfg(next);
    room.setConfig(configFrom(next));
  };

  // 방을 만든 직후 기본 설정을 한 번 등록해 둔다(설정 없이는 시작할 수 없다)
  const configPushed = useRef(false);
  useEffect(() => {
    if (isHost && state && !state.config && !configPushed.current) {
      configPushed.current = true;
      room.setConfig(configFrom(cfg));
    }
    if (!state) configPushed.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, state]);

  // 게스트는 호스트가 보낸 설정을 화면에 반영한다
  const remoteConfig = state?.config;
  useEffect(() => {
    if (!remoteConfig || isHost) return;
    const rule = remoteConfig.rule;
    setCfg((prev) => ({
      ...prev,
      attackMul: remoteConfig.attackMul,
      undo: remoteConfig.undo,
      sharePieces: remoteConfig.sharePieces,
      firstTo: remoteConfig.firstTo ?? 0,
      garbage: rule.garbageEnabled,
      kickset: rule.kickset,
      spinBonus: rule.spinBonus,
      b2bMode: rule.b2bMode,
      garbageMultiplier: rule.garbageMultiplier,
      garbageMessiness: rule.garbageMessiness,
      garbageCap: rule.garbageCap ?? 8,
      garbageHoleMode: rule.garbageHoleMode ?? "clean",
      garbageSpeed: rule.garbageSpeed ?? 20,
      perfectClearDamage: rule.perfectClearDamage ?? 5,
      gravity: rule.gravity,
      lockDelay: rule.lockDelay,
      are: rule.are,
      randomizer: rule.randomizer,
      nextCount: rule.nextCount,
      allow180: rule.allow180,
    }));
  }, [remoteConfig, isHost]);

  const host = async (urlOverride?: string) => {
    await room.connect(urlOverride ?? serverUrl, "host", { maxPlayers, nick: myNick });
  };
  const join = async (urlOverride?: string) => {
    if (!joinCode.trim()) return;
    await room.connect(urlOverride ?? serverUrl, "join", { code: joinCode, nick: myNick });
  };

  const hostLan = async () => {
    try {
      const info = await lanStart(47474);
      setLanInfo(info);
      await host(`ws://127.0.0.1:${info.port}`);
    } catch {
      // lanStart 실패는 room.error로 드러나지 않으므로 조용히 무시하지 않는다
      room.pushSystemChat("LAN 서버를 시작할 수 없습니다");
    }
  };
  const joinLan = async () => {
    const ip = hostIp.trim();
    if (!ip || !joinCode.trim()) return;
    await join(ip.includes(":") ? `ws://${ip}` : `ws://${ip}:47474`);
  };
  const findHost = async () => {
    setDiscovering(true);
    try {
      const hosts = await lanDiscover();
      if (hosts.length > 0) setHostIp(`${hosts[0].ip}:${hosts[0].port}`);
    } finally {
      setDiscovering(false);
    }
  };

  const leaveRoom = () => {
    room.leave();
    if (lanInfo) {
      lanStop().catch(() => {});
      setLanInfo(null);
    }
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    room.sendChat(myNick, text);
    setChatInput("");
  };

  // ---- 대전 / 관전 / 결과 --------------------------------------------------
  // 결과는 대전 화면 위에 겹쳐 띄운다. 판이 끝났다고 무대를 걷어내면 세션이
  // 함께 사라져 리플레이를 만들 수 없고, 마지막 보드도 볼 수 없다.
  if (state && (state.phase === "playing" || state.phase === "results") && room.matchStart) {
    return (
      <div style={{ position: "relative", width: "100%", height: "100%" }}>
        <MatchStage settings={settings} room={room} match={room.matchStart} />
        {state.phase === "results" && room.matchEnd && <ResultsView room={room} />}
      </div>
    );
  }

  // ---- 로비(연결 전) -------------------------------------------------------
  if (!state) {
    return (
      <div className="fx-menu">
        <div className="fx-logo" style={{ fontSize: "2.5rem" }}>
          <span style={{ color: FUNKY.sky }}>CUSTOM</span> <span style={{ color: FUNKY.pink }}>ROOM</span>
        </div>
        <Text variant="chrome" muted>
          라스트맨 스탠딩 · 관전 자유
        </Text>

        {room.error && (
          <div style={{ color: FUNKY.danger, fontWeight: 900, padding: "0.5rem 1rem", border: `3px solid ${FUNKY.danger}` }}>
            {room.error}
          </div>
        )}

        <div className="fx-panel" style={{ gap: "1rem", minWidth: 360 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontWeight: 800, fontSize: "0.85rem" }}>
            <span>서버 주소</span>
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} style={inputStyle} placeholder="ws://localhost:8787" />
          </label>
          <SelectField
            label="참가 인원"
            value={String(maxPlayers)}
            options={[
              { value: "0", label: "제한 없음" },
              ...[2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: `${n}인까지` })),
            ]}
            onChange={(v) => setMaxPlayers(Number(v))}
          />
          <Button variant="primary" size="lg" onClick={() => host()}>
            방 만들기
          </Button>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="방 코드"
              style={{ ...inputStyle, flex: 1, textTransform: "uppercase", letterSpacing: "0.2em", textAlign: "center" }}
            />
            <Button variant="secondary" size="lg" onClick={() => join()}>
              입장
            </Button>
          </div>

          {isTauri() && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "2px dashed rgba(0,0,0,0.2)", paddingTop: 12 }}>
              <Text variant="chrome" muted>LAN 직결 — 인터넷 없이 (비행기 · USB/Thunderbolt)</Text>
              <Button variant="success" size="lg" onClick={hostLan}>
                LAN 방 만들기 (호스트)
              </Button>
              <Button variant="neutral" size="md" onClick={findHost} disabled={discovering}>
                {discovering ? "찾는 중…" : "주변 호스트 찾기"}
              </Button>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={hostIp} onChange={(e) => setHostIp(e.target.value)} placeholder="호스트 IP (예: 192.168.0.5)" style={{ ...inputStyle, flex: 1 }} />
                <Button variant="success" size="lg" onClick={joinLan}>
                  LAN 참가
                </Button>
              </div>
              <Text variant="chrome" muted style={{ fontSize: "0.7rem" }}>
                ※ 위 "방 코드"도 함께 입력하세요 — 호스트가 IP와 코드를 알려줍니다.
              </Text>
            </div>
          )}

          <Button variant="neutral" size="md" onClick={onExit}>
            메뉴로
          </Button>
        </div>
      </div>
    );
  }

  // ---- 대기실 --------------------------------------------------------------
  const roster = state.players;
  const participants = roster.filter((p) => p.role === "player");
  const spectators = roster.filter((p) => p.role === "spectator");
  const canStart = isHost && participants.length >= 2;
  // 정원이 무제한이면 슬롯을 그리는 대신 "봇 부르기" 한 칸만 둔다
  const unlimited = state.maxPlayers === 0;
  const emptySlots = unlimited ? 1 : Math.max(0, state.maxPlayers - participants.length);

  return (
    <div className="fx-room">
      {room.error && <div className="fx-room-error">{room.error}</div>}

      <header className="fx-room-bar">
        <div className="fx-room-bar__title">CUSTOM ROOM</div>
        <button className="fx-room-exit" onClick={leaveRoom}>
          EXIT
        </button>
      </header>

      <div className="fx-room-body">
        {/* 왼쪽 — 플레이어 / 방 코드 / 준비 */}
        <section className="fx-room-col fx-room-col--players">
          <div className="fx-room-col__head">
            Players
            <span className="fx-room-col__head-count">
              {participants.length}
              {unlimited ? "" : `/${state.maxPlayers}`}
            </span>
          </div>
          <div className="fx-room-col__body">
            <div className="fx-room-code">
              <span className="fx-room-code__label">Room Code</span>
              <span className="fx-room-code__value">{room.code}</span>
              <span className="fx-room-code__count">
                {participants.length}명 참가
                {spectators.length > 0 ? ` · 관전 ${spectators.length}명` : ""}
              </span>
            </div>

            {lanInfo && isHost && (
              <div style={{ marginTop: 8, padding: "8px 10px", border: `2px solid ${FUNKY.green}`, fontWeight: 800, fontSize: "0.8rem" }}>
                <div style={{ opacity: 0.6, fontSize: "0.65rem", letterSpacing: "0.1em", textTransform: "uppercase" }}>LAN 주소</div>
                {lanInfo.addrs.map((a) => (
                  <div key={a} style={{ fontVariantNumeric: "tabular-nums" }}>
                    {a}:{lanInfo.port}
                  </div>
                ))}
              </div>
            )}

            {/* 뛰는 사람만 슬롯을 차지한다 — 관전자는 아래에 따로 모은다 */}
            <div className="fx-roster">
              {participants.map((p, i) => (
                <PlayerRow
                  key={p.id}
                  player={p}
                  color={p.id === room.myId ? FUNKY.sky : OPP_PALETTE[i % OPP_PALETTE.length]}
                  me={p.id === room.myId}
                  firstTo={state.config?.firstTo ?? 0}
                  canKick={isHost && p.isBot}
                  onKick={() => room.kickBot(p.id)}
                />
              ))}
              {Array.from({ length: emptySlots }, (_, i) => (
                <EmptySlot
                  key={`empty-${i}`}
                  canFill={isHost}
                  unlimited={unlimited}
                  runners={room.runners}
                  onRefresh={() => room.refreshRunners()}
                  onFill={(runnerId) => room.addBot(runnerId)}
                />
              ))}
            </div>

            {spectators.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 10, borderTop: "2px dashed rgba(0,0,0,0.15)" }}>
                <div
                  style={{
                    fontSize: "0.68rem",
                    fontWeight: 900,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    opacity: 0.5,
                    marginBottom: 6,
                  }}
                >
                  관전 {spectators.length}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: "0.78rem", fontWeight: 800 }}>
                  {spectators.map((p) => (
                    <span
                      key={p.id}
                      style={{
                        padding: "3px 8px",
                        border: "2px solid var(--funky-line)",
                        opacity: p.id === room.myId ? 1 : 0.65,
                        background: p.id === room.myId ? FUNKY.sunken : "transparent",
                      }}
                    >
                      {p.nick}
                      {p.id === room.myId ? " (나)" : ""}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 직전 판 리플레이 — 결과 화면을 놓쳐도 여기서 받을 수 있다 */}
            {room.sharedReplays.length > 0 && (
              <div style={{ marginTop: 14, paddingTop: 10, borderTop: "2px dashed rgba(0,0,0,0.15)" }}>
                <ReplayList files={room.sharedReplays} align="flex-start" />
              </div>
            )}
          </div>

          <footer className="fx-room-col__foot" style={{ gap: 8 }}>
            {isHost && (
              <Button variant="primary" size="lg" onClick={() => room.startMatch()} disabled={!canStart}>
                {participants.length < 2 ? "참가자 대기 중…" : "매치 시작"}
              </Button>
            )}
            {me?.role === "player" ? (
              <Button variant="neutral" size="md" onClick={() => room.setRole("spectator")}>
                관전으로 전환
              </Button>
            ) : (
              <Button variant="neutral" size="md" onClick={() => room.setRole("player")}>
                참가하기
              </Button>
            )}
            {!isHost && (
              <Text variant="chrome" muted style={{ textAlign: "center", fontSize: "0.78rem" }}>
                호스트가 시작하면 바로 들어갑니다
              </Text>
            )}
            <Button variant="neutral" size="md" onClick={onPlayZen}>
              Zen 하러 가기
            </Button>
          </footer>
        </section>

        {/* 가운데 — 설정 */}
        <section className="fx-room-col fx-room-col--settings">
          <div className="fx-room-col__head">Match Settings</div>
          <div className="fx-room-col__body" style={canEdit ? undefined : { opacity: 0.85 }}>
            {!isHost && <Text variant="chrome" muted>읽기 전용 · 호스트가 설정합니다</Text>}
            {isHost && !canEdit && <Text variant="chrome" muted>매치 중에는 설정을 바꿀 수 없어요</Text>}
            <Tabs defaultValue="match">
              <Tabs.List>
                <Tabs.Trigger value="match">매치</Tabs.Trigger>
                <Tabs.Trigger value="garbage">가비지</Tabs.Trigger>
                <Tabs.Trigger value="rule">규칙</Tabs.Trigger>
                <Tabs.Trigger value="timing">타이밍</Tabs.Trigger>
              </Tabs.List>

              <Tabs.Panel value="match">
                <div className="fx-settings-group">
                  <SelectField
                    label="승부 방식"
                    value={String(cfg.firstTo)}
                    disabled={!canEdit}
                    options={[
                      { value: "0", label: "계속 (목표 없음)" },
                      { value: "1", label: "단판 (FT1)" },
                      { value: "3", label: "3선승 (FT3)" },
                      { value: "5", label: "5선승 (FT5)" },
                      { value: "7", label: "7선승 (FT7)" },
                      { value: "10", label: "10선승 (FT10)" },
                    ]}
                    onChange={(v) => applyEdit({ firstTo: Number(v) })}
                  />
                  <NumField label="공격 배수" value={cfg.attackMul} min={0} step={0.1} disabled={!canEdit} onChange={(v) => applyEdit({ attackMul: v })} />
                  <ToggleField label="같은 조각 순서 공유" value={cfg.sharePieces} disabled={!canEdit} onChange={(v) => applyEdit({ sharePieces: v })} />
                  <ToggleField label="교육 모드 (Ctrl+Z)" value={cfg.undo} disabled={!canEdit} onChange={(v) => applyEdit({ undo: v })} />
                </div>
              </Tabs.Panel>

              <Tabs.Panel value="garbage">
                <div className="fx-settings-group">
                  <ToggleField label="가비지(공격) 사용" value={cfg.garbage} disabled={!canEdit} onChange={(v) => applyEdit({ garbage: v })} />
                  <NumField label="가비지 배수" value={cfg.garbageMultiplier} min={0} max={5} step={0.1} disabled={!canEdit} onChange={(v) => applyEdit({ garbageMultiplier: v })} />
                  <NumField label="가비지 혼잡도" value={cfg.garbageMessiness} min={0} max={1} step={0.05} disabled={!canEdit} onChange={(v) => applyEdit({ garbageMessiness: v })} />
                  <NumField label="가비지 캡 (한 번에, 줄)" value={cfg.garbageCap} min={1} max={40} step={1} disabled={!canEdit} onChange={(v) => applyEdit({ garbageCap: Math.round(v) })} />
                  <NumField label="가비지 속도 (프레임)" value={cfg.garbageSpeed} min={0} max={120} step={1} disabled={!canEdit} onChange={(v) => applyEdit({ garbageSpeed: Math.round(v) })} />
                  <SelectField
                    label="방해줄 모양"
                    value={cfg.garbageHoleMode}
                    disabled={!canEdit}
                    options={[
                      { value: "clean", label: "깔끔 (한 공격=한 줄)" },
                      { value: "cheese", label: "치즈 (줄마다 랜덤)" },
                    ]}
                    onChange={(v) => applyEdit({ garbageHoleMode: v as GarbageHoleMode })}
                  />
                  <NumField label="퍼펙트 클리어 데미지" value={cfg.perfectClearDamage} min={0} max={20} step={1} disabled={!canEdit} onChange={(v) => applyEdit({ perfectClearDamage: Math.round(v) })} />
                </div>
              </Tabs.Panel>

              <Tabs.Panel value="rule">
                <div className="fx-settings-group">
                  <SelectField
                    label="킥 테이블"
                    value={cfg.kickset}
                    disabled={!canEdit}
                    options={[
                      { value: "SRS+", label: "SRS+" },
                      { value: "SRS-X", label: "SRS-X" },
                      { value: "SRS", label: "SRS" },
                      { value: "none", label: "없음" },
                    ]}
                    onChange={(v) => applyEdit({ kickset: v as KicksetName })}
                  />
                  <SelectField
                    label="스핀 보너스"
                    value={cfg.spinBonus}
                    disabled={!canEdit}
                    options={[
                      { value: "all-mini+", label: "올스핀 (all-mini+)" },
                      { value: "all-mini", label: "올스핀 (all-mini)" },
                      { value: "all", label: "올스핀 (all)" },
                      { value: "t-spins", label: "T-스핀만" },
                      { value: "none", label: "없음" },
                    ]}
                    onChange={(v) => applyEdit({ spinBonus: v as SpinBonusName })}
                  />
                  <SelectField
                    label="B2B 모드"
                    value={cfg.b2bMode}
                    disabled={!canEdit}
                    options={[
                      { value: "surge", label: "Surge (시즌2)" },
                      { value: "chaining", label: "Chaining (시즌1)" },
                      { value: "none", label: "없음" },
                    ]}
                    onChange={(v) => applyEdit({ b2bMode: v as "surge" | "chaining" | "none" })}
                  />
                  <SelectField
                    label="조각 가방"
                    value={cfg.randomizer}
                    disabled={!canEdit}
                    options={[
                      { value: "7-bag", label: "7-bag (표준)" },
                      { value: "14-bag", label: "14-bag" },
                      { value: "classic", label: "Classic (NES)" },
                      { value: "pairs", label: "Pairs" },
                      { value: "random", label: "Total Mayhem" },
                    ]}
                    onChange={(v) => applyEdit({ randomizer: v as RandomizerName })}
                  />
                  <NumField label="NEXT 개수" value={cfg.nextCount} min={1} max={7} step={1} disabled={!canEdit} onChange={(v) => applyEdit({ nextCount: Math.round(v) })} />
                  <ToggleField label="180° 회전 허용" value={cfg.allow180} disabled={!canEdit} onChange={(v) => applyEdit({ allow180: v })} />
                </div>
              </Tabs.Panel>

              <Tabs.Panel value="timing">
                <div className="fx-settings-group">
                  <NumField label="중력 (G)" value={cfg.gravity} min={0} max={20} step={0.01} disabled={!canEdit} onChange={(v) => applyEdit({ gravity: v })} />
                  <NumField label="락 딜레이 (프레임)" value={cfg.lockDelay} min={0} max={120} step={1} disabled={!canEdit} onChange={(v) => applyEdit({ lockDelay: Math.round(v) })} />
                  <NumField label="ARE / 스폰 딜레이 (프레임)" value={cfg.are} min={0} max={60} step={1} disabled={!canEdit} onChange={(v) => applyEdit({ are: Math.round(v) })} />
                </div>
              </Tabs.Panel>
            </Tabs>
          </div>
        </section>

        {/* 오른쪽 — 채팅 */}
        <section className="fx-room-col fx-room-col--chat">
          <div className="fx-room-col__head">Chat</div>
          <ChatBox chat={room.chat} value={chatInput} onChange={setChatInput} onSend={sendChat} myNick={myNick} />
        </section>
      </div>
    </div>
  );
}

// ---- 결과 ------------------------------------------------------------------

/**
 * 리플레이를 JSON 파일로 내려받는다.
 * 시드·룰·핸들링·simRate가 모두 들어 있어 나중에 그대로 재생할 수 있다.
 */
function downloadReplay(file: ReplayFile): void {
  const stamp = file.recordedAt.slice(0, 19).replace(/[:T]/g, "-");
  const safeNick = file.player.nick.replace(/[^\w가-힣-]/g, "_").slice(0, 20);
  // 순위를 넣어 같은 닉이 둘일 때도 파일이 서로 덮이지 않게 한다
  const rank = file.player.placement ? `-${file.player.placement}위` : "";
  const name = `fetris-${file.match.code ?? "local"}-${safeNick}${rank}-${stamp}.json`;

  const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 브라우저가 저장을 시작할 틈을 준 뒤 해제한다
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 이 방에 공유된 리플레이 목록. 참가자들이 판이 끝날 때 나눠준 것을 모은 것이라,
 * 자기 로그가 없는 관전자도 여기서 내려받는다.
 *
 * 결과 화면과 대기실 양쪽에 붙는다 — 결과는 몇 초 만에 자동으로 걷히므로,
 * 그 안에 못 누르면 영영 못 받는 상황을 만들지 않기 위해서다.
 */
function ReplayList({ files, align }: { files: ReplayFile[]; align: "center" | "flex-start" }) {
  if (files.length === 0) return null;
  return (
    <div style={{ width: "100%", marginBottom: 4 }}>
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
        리플레이
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: align }}>
        {files.map((r) => (
          <button
            key={`${r.player.id ?? r.player.nick}-${r.match.matchId}`}
            onClick={() => downloadReplay(r)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 10px",
              border: "2px solid var(--funky-line)",
              background: "var(--funky-surface)",
              boxShadow: "2px 2px 0 var(--funky-line)",
              fontWeight: 800,
              fontSize: "0.76rem",
              cursor: "pointer",
              font: "inherit",
            }}
          >
            <span style={{ opacity: 0.55 }}>↓</span>
            <span>{r.player.nick}</span>
            {r.player.placement ? <span style={{ opacity: 0.5 }}>#{r.player.placement}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function ResultsView({ room }: { room: RoomSession }) {
  const end = room.matchEnd!;
  const players = room.state?.players ?? [];
  const nickOf = (id: string) => players.find((p) => p.id === id)?.nick ?? "―";
  const iWon = end.winnerId === room.myId;
  const isHost = !!players.find((p) => p.id === room.myId)?.isHost;
  const firstTo = room.state?.config?.firstTo ?? 0;
  // 시리즈(FT)까지 끝난 판이면 한 판 승리보다 크게 알린다
  const series = end.seriesWinnerId;
  const iTookSeries = series === room.myId;

  // 대전 화면 위에 겹쳐 뜬다(.fx-overlay가 absolute inset:0). 배경을 옅게 깔아
  // 마지막 보드가 뒤로 비쳐 보이게 둔다 — 판이 어떻게 끝났는지가 결과표만큼 중요하다.
  return (
    <div className="fx-overlay" style={{ background: "rgba(12, 8, 24, 0.55)" }}>
      <div className="fx-panel" style={{ minWidth: 340 }}>
        {series ? (
          <>
            <div style={{ fontSize: "0.72rem", fontWeight: 900, letterSpacing: "0.12em", color: FUNKY.yellow }}>
              FT{firstTo} 시리즈 종료
            </div>
            <h2 style={{ color: iTookSeries ? FUNKY.yellow : FUNKY.sky, marginBottom: 4 }}>
              🏆 {iTookSeries ? "시리즈 우승!" : `${nickOf(series)} 시리즈 우승`}
            </h2>
          </>
        ) : (
          <h2 style={{ color: iWon ? FUNKY.green : FUNKY.sky, marginBottom: 4 }}>
            {iWon ? "WINNER!" : end.winnerId ? `${nickOf(end.winnerId)} 승리` : "무승부"}
          </h2>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "12px 0", minWidth: 260 }}>
          {end.standings.map((s) => (
            <div
              key={s.playerId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 10px",
                border: `2px solid ${s.placement === 1 ? FUNKY.yellow : "var(--funky-line)"}`,
                fontWeight: 800,
                background: s.playerId === room.myId ? "rgba(0,0,0,0.06)" : "transparent",
              }}
            >
              <span style={{ fontWeight: 900, color: s.placement === 1 ? FUNKY.yellow : "inherit", minWidth: 28 }}>
                #{s.placement}
              </span>
              <span style={{ flex: 1 }}>{nickOf(s.playerId)}</span>
              {/* 시리즈 중이면 몇 승째인지가 순위보다 중요하다 */}
              {firstTo > 0 && (
                <Badge color="yellow">
                  {players.find((p) => p.id === s.playerId)?.wins ?? 0}/{firstTo}승
                </Badge>
              )}
              {s.playerId === room.myId && <Badge color="sky">나</Badge>}
            </div>
          ))}
        </div>
        <ReplayList files={room.sharedReplays} align="center" />

        {end.nextRound ? (
          <>
            <Button variant="primary" size="lg" onClick={() => room.skipResults()}>
              바로 다음 판
            </Button>
            {isHost && (
              <Button variant="neutral" size="md" onClick={() => room.abortSeries()}>
                시리즈 그만두기
              </Button>
            )}
            <Text variant="chrome" muted style={{ fontSize: "0.78rem" }}>
              FT{firstTo} 진행 중 — 누르지 않아도 잠시 후 다음 판이 시작됩니다
            </Text>
          </>
        ) : (
          <>
            <Button variant="primary" size="lg" onClick={() => room.skipResults()}>
              대기실로 돌아가기
            </Button>
            <Text variant="chrome" muted style={{ fontSize: "0.78rem" }}>
              누르지 않아도 잠시 후 자동으로 돌아갑니다
            </Text>
          </>
        )}
      </div>
    </div>
  );
}

// ---- 조각 컴포넌트 ---------------------------------------------------------

function PlayerRow({
  player,
  color,
  me,
  firstTo,
  canKick,
  onKick,
}: {
  player: PlayerInfo;
  color: string;
  me: boolean;
  /** 시리즈 목표 승수(0이면 목표 없음) */
  firstTo: number;
  canKick: boolean;
  onKick: () => void;
}) {
  return (
    <div className="fx-player-box" style={{ opacity: player.role === "spectator" ? 0.6 : 1 }}>
      <span className="fx-player-box__swatch" style={{ background: color }} />
      <span className="fx-player-box__name">{player.nick}</span>
      {player.wins > 0 && <Badge color="yellow">{firstTo > 0 ? `${player.wins}/${firstTo}승` : `${player.wins}승`}</Badge>}
      {player.isBot && <Badge color="purple">{player.botOwner ? `BOT · ${player.botOwner}` : "BOT"}</Badge>}
      {player.isHost && <Badge color="yellow">호스트</Badge>}
      {me && <Badge color="sky">나</Badge>}
      {player.role === "spectator" && <Badge color="neutral">관전</Badge>}
      {canKick && (
        <button
          onClick={onKick}
          style={{ marginLeft: "auto", border: "2px solid var(--funky-line)", background: "transparent", fontWeight: 900, fontSize: "0.7rem", cursor: "pointer", padding: "2px 6px" }}
        >
          내보내기
        </button>
      )}
    </div>
  );
}

/**
 * 빈 슬롯 — 호스트는 여기서 어느 봇을 부를지 고른다.
 * 러너가 하나뿐이면 바로 부르고, 여럿이면 소유자별로 골라 넣는다.
 */
function EmptySlot({
  canFill,
  unlimited,
  runners,
  onRefresh,
  onFill,
}: {
  canFill: boolean;
  /** 정원 제한이 없으면 "빈 자리"가 의미 없으므로 봇 부르기 칸으로 쓴다 */
  unlimited: boolean;
  runners: BotRunnerInfo[];
  onRefresh: () => void;
  onFill: (runnerId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const available = runners.filter((r) => r.active < r.capacity);

  const toggle = () => {
    if (!open) onRefresh(); // 열 때마다 최신 목록을 받아온다
    setOpen((v) => !v);
  };

  return (
    <div style={{ position: "relative" }}>
      <div className="fx-player-box" style={{ opacity: 0.5, borderStyle: "dashed" }}>
        <span className="fx-player-box__swatch" style={{ background: "transparent", border: "2px dashed var(--funky-line)" }} />
        <span className="fx-player-box__name" style={{ opacity: 0.6 }}>{unlimited ? "봇 부르기" : "빈 자리"}</span>
        {canFill && (
          <button
            onClick={toggle}
            style={{ marginLeft: "auto", border: "2px solid var(--funky-line)", background: open ? FUNKY.sky : "transparent", fontWeight: 900, fontSize: "0.7rem", cursor: "pointer", padding: "2px 6px" }}
          >
            + 봇
          </button>
        )}
      </div>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: 20,
            minWidth: 200,
            marginTop: 4,
            border: "2px solid var(--funky-line)",
            background: "var(--funky-surface)",
            boxShadow: "4px 4px 0 rgba(0,0,0,0.25)",
            fontSize: "0.75rem",
            fontWeight: 800,
          }}
        >
          {available.length === 0 ? (
            <div style={{ padding: "10px 12px", opacity: 0.7, lineHeight: 1.5 }}>
              대기 중인 봇이 없어요.
              <br />
              <span style={{ opacity: 0.7, fontWeight: 700 }}>봇 러너를 먼저 띄워야 합니다.</span>
            </div>
          ) : (
            <>
              {available.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    onFill(r.id);
                    setOpen(false);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 12px",
                    border: "none",
                    borderBottom: "1px solid rgba(0,0,0,0.12)",
                    background: "transparent",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  <div>{r.name}</div>
                  <div style={{ opacity: 0.6, fontSize: "0.68rem", fontWeight: 700 }}>
                    {r.owner}
                    {r.label ? ` · ${r.label}` : ""} · 여유 {r.capacity - r.active}
                  </div>
                </button>
              ))}
              <button
                onClick={() => {
                  onFill();
                  setOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  font: "inherit",
                  opacity: 0.7,
                }}
              >
                아무나 (자동 선택)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChatBox({
  chat,
  value,
  onChange,
  onSend,
  myNick,
}: {
  chat: { nick: string; text: string }[];
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  myNick: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [chat]);
  return (
    <div className="fx-chat">
      <div className="fx-chat__list" ref={listRef}>
        {chat.length === 0 && <span className="fx-chat__empty">아직 메시지가 없어요</span>}
        {chat.map((m, i) =>
          m.nick === "" ? (
            <div key={i} className="fx-chat__sys">{m.text}</div>
          ) : (
            <div key={i} className="fx-chat__msg">
              <span className="fx-chat__nick" style={{ color: m.nick === myNick ? FUNKY.sky : FUNKY.pink }}>{m.nick}</span>
              <span style={{ opacity: 0.5 }}>: </span>
              <span>{m.text}</span>
            </div>
          ),
        )}
      </div>
      <div className="fx-chat__compose">
        <input
          value={value}
          maxLength={120}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="메시지 입력 후 Enter"
          style={{ ...inputStyle, flex: 1, minWidth: 0, fontSize: "0.85rem", padding: "0.45rem 0.6rem" }}
        />
        <Button variant="secondary" size="md" onClick={onSend}>전송</Button>
      </div>
    </div>
  );
}

const fieldRow: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", alignItems: "center", gap: "1rem", fontWeight: 800, fontSize: "0.9rem" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "0.55rem 0.75rem", border: "2px solid var(--funky-line)", borderRadius: 0, background: "var(--funky-surface)", fontWeight: 800, fontSize: "1rem" };

function NumField({
  label, value, onChange, disabled, min = 0, max, step = 0.1,
}: {
  label: string; value: number; onChange: (n: number) => void; disabled?: boolean; min?: number; max?: number; step?: number;
}) {
  return (
    <label style={fieldRow}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          const clamped = max !== undefined ? Math.min(max, Math.max(min, v)) : Math.max(min, v);
          onChange(isNaN(clamped) ? min : clamped);
        }}
        style={{ ...inputStyle, textAlign: "right", opacity: disabled ? 0.6 : 1 }}
      />
    </label>
  );
}

function ToggleField({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (b: boolean) => void; disabled?: boolean }) {
  return (
    <label style={{ ...fieldRow, cursor: disabled ? "default" : "pointer" }}>
      <span>{label}</span>
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ width: 22, height: 22 }} />
    </label>
  );
}

function SelectField({
  label, value, options, onChange, disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label style={fieldRow}>
      <span>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1, appearance: "auto" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
