import { useEffect, useRef, useState } from "react";
import { Button, Text, Badge, Tabs } from "@studio-baeks/funky-ui";
import type { Settings } from "../app/store";
import type { RuleSet, KicksetName, SpinBonusName, GarbageHoleMode, RandomizerName } from "@fetris/engine/types";
import { isTauri, lanStart, lanStop, lanDiscover } from "../net/lan";
import type { LanInfo } from "../net/lan";
import type { BotRunnerInfo, MatchConfig, PlayerInfo } from "../net/protocol";
import type { MatchEndInfo, RoomSession } from "../app/roomSession";
import type { MatchReplayFile } from "@fetris/engine/replay";
import { MatchStage } from "./MatchStage";
import { RoundTransition, OPEN_MS } from "./RoundTransition";
import { Row, Slider, Toggle } from "./controls";
import type { Handling } from "@fetris/engine/types";
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

const fmtFrameMs = (f: number) => `${f}f / ${Math.round((f * 1000) / 60)}ms`;

const OPP_PALETTE = [FUNKY.pink, FUNKY.orange, FUNKY.green, FUNKY.purple, FUNKY.yellow, FUNKY.danger, FUNKY.sky];

type Cfg = {
  /** 먼저 N승하면 이 방의 승부가 끝난다. 항상 1 이상(FT1 = 단판) */
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
  firstTo: 3,
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
  updateSettings,
  room,
  onExit,
  onPlayZen,
}: {
  settings: Settings;
  updateSettings: (fn: (s: Settings) => Settings) => void;
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

  /**
   * 감도는 방 설정이 아니라 개인 설정이다 — 마우스 감도를 남이 정해주지 않는 것과
   * 같다. 그래서 호스트 여부와 무관하게 언제든 바꿀 수 있고, 방 전체가 아니라
   * 내 저장된 설정에 남는다. 다만 판이 도는 중에 바꾸면 그 판의 재현이 어긋나므로
   * 다음 판부터 적용한다.
   */
  const h = settings.handling;
  const setHandling = (patch: Partial<Handling>) =>
    updateSettings((s) => ({ ...s, handling: { ...s.handling, ...patch } }));

  /*
    내 감도를 방에 알려 둔다. 남들이 내 보드를 입력만으로 따라 돌리려면 이 값이
    있어야 하는데(같은 키라도 감도가 다르면 다르게 움직인다), 방 설정이 아니라
    개인 설정이라 서버가 따로 모아 매치 시작 때 실어 보낸다.
  */
  useEffect(() => {
    if (state) room.setHandling(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h, !!state]);

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
      firstTo: Math.max(1, remoteConfig.firstTo ?? 1),
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

  /*
    라운드 전환 연출은 matchEnd보다 오래 산다. 슬라이드는 **다음 판이 실제로
    열린 뒤에** 걷혀야 하고(그래야 두 보드가 준비된 채 드러난다), 걷히는 동안도
    화면에 남아 있어야 하기 때문이다.
  */
  const [roundBreak, setRoundBreak] = useState<MatchEndInfo | null>(null);
  const breakEnd = room.matchEnd;
  useEffect(() => {
    if (breakEnd?.nextRound) setRoundBreak(breakEnd);
  }, [breakEnd]);
  const nextMatchId = room.matchStart?.matchId ?? -1;
  const breakOpened = !!roundBreak && nextMatchId > roundBreak.matchId;
  useEffect(() => {
    if (!breakOpened) return;
    const t = setTimeout(() => setRoundBreak(null), OPEN_MS + 120);
    return () => clearTimeout(t);
  }, [breakOpened]);

  const host = async (urlOverride?: string) => {
    await room.connect(urlOverride ?? serverUrl, "host", { maxPlayers, nick: myNick, handling: h });
  };
  const join = async (urlOverride?: string) => {
    if (!joinCode.trim()) return;
    await room.connect(urlOverride ?? serverUrl, "join", { code: joinCode, nick: myNick, handling: h });
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
        {/*
          다음 판이 이어지는 중이면 결과표 대신 라운드 전환 연출을 태운다.
          승부가 끝났을 때(누군가 FT를 채웠다)는 리플레이 내려받기와 대기실
          이동이 필요하므로 기존 결과 화면을 그대로 쓴다.
        */}
        {roundBreak && <RoundTransition room={room} end={roundBreak} opened={breakOpened} />}
        {state.phase === "results" && room.matchEnd && !room.matchEnd.nextRound && (
          <ResultsView room={room} />
        )}
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
            <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px dashed rgba(255,255,255,0.16)", paddingTop: 12 }}>
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
              <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 8, border: `1px solid ${FUNKY.green}`, background: "rgba(0,194,42,0.1)", fontWeight: 800, fontSize: "0.8rem" }}>
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
                  firstTo={state.config?.firstTo ?? 1}
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
              <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px dashed rgba(255,255,255,0.14)" }}>
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
                        padding: "3px 9px",
                        borderRadius: 999,
                        border: "1px solid var(--funky-line)",
                        opacity: p.id === room.myId ? 1 : 0.6,
                        background: p.id === room.myId ? "rgba(255,255,255,0.08)" : "transparent",
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
            {room.canDownloadMatch && (
              <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px dashed rgba(255,255,255,0.14)" }}>
                <MatchReplayButton room={room} align="flex-start" />
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
                <Tabs.Trigger value="feel">감도</Tabs.Trigger>
              </Tabs.List>

              <Tabs.Panel value="match">
                <div className="fx-settings-group">
                  <SelectField
                    label="승부 방식"
                    value={String(cfg.firstTo)}
                    disabled={!canEdit}
                    options={[
                      { value: "1", label: "단판 (FT1)" },
                      { value: "2", label: "2선승 (FT2)" },
                      { value: "3", label: "3선승 (FT3)" },
                      { value: "5", label: "5선승 (FT5)" },
                      { value: "7", label: "7선승 (FT7)" },
                      { value: "10", label: "10선승 (FT10)" },
                    ]}
                    onChange={(v) => applyEdit({ firstTo: Math.max(1, Number(v)) })}
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

              {/* 감도 — 방 설정이 아니라 내 개인 설정이다 */}
              <Tabs.Panel value="feel">
                <div className="fx-settings-group">
                  <Text variant="chrome" muted>
                    내 조작 감도예요. 방 전체가 아니라 나에게만 적용되고, 진행 중인 판이 아니라
                    다음 판부터 반영됩니다.
                  </Text>
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
                    <Slider
                      value={h.sdf == null || h.sdf > 41 ? 41 : h.sdf}
                      min={5}
                      max={41}
                      step={1}
                      onChange={(v) => setHandling({ sdf: v })}
                      format={(v) => (v >= 41 ? "∞" : `${v}×`)}
                    />
                  </Row>
                  <Row label="하드드롭 실수 방지" desc="하드드롭 후 키를 떼야 다시 발동">
                    <Toggle value={h.safelock} onChange={(v) => setHandling({ safelock: v })} />
                  </Row>
                  <Row label="방향 전환 시 DAS 리셋" desc="반대로 꺾을 때 DAS를 다시 채운다">
                    <Toggle value={h.cancelDas} onChange={(v) => setHandling({ cancelDas: v })} />
                  </Row>
                  <Row label="소프트드롭 우선" desc="같은 프레임에 소프트드롭을 좌우 이동보다 먼저">
                    <Toggle value={h.preferSoftDrop} onChange={(v) => setHandling({ preferSoftDrop: v })} />
                  </Row>
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
 * 매치 리플레이를 JSON 파일로 내려받는다 — 판 하나가 통째로 들어 있다.
 * 참가자별 입력 로그를 다 담고 있어, 뷰어에서 모든 보드를 나란히 다시 볼 수 있다.
 */
function downloadMatchReplay(file: MatchReplayFile): void {
  const stamp = file.recordedAt.slice(0, 19).replace(/[:T]/g, "-");
  const name = `fetris-${file.match.code ?? "local"}-match${file.match.matchId}-${stamp}.json`;

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
 * 방금 끝난 판을 내려받는 버튼.
 *
 * 결과 화면과 대기실 양쪽에 붙는다 — 결과는 몇 초 만에 자동으로 걷히므로,
 * 그 안에 못 누르면 영영 못 받는 상황을 만들지 않기 위해서다.
 */
function MatchReplayButton({ room, align }: { room: RoomSession; align: "center" | "flex-start" }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!room.canDownloadMatch) return null;

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      downloadMatchReplay(await room.buildMatchReplay());
    } catch (e) {
      setErr(e instanceof Error && e.message === "no-recording" ? "남은 녹화가 없어요" : "받지 못했어요");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ width: "100%", marginBottom: 4, display: "flex", justifyContent: align, gap: 8, alignItems: "center" }}>
      <button
        onClick={save}
        disabled={busy}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          border: "1px solid var(--funky-line)",
          borderRadius: 8,
          background: "var(--funky-surface)",
          color: "var(--funky-ink)",
          fontWeight: 800,
          fontSize: "0.78rem",
          cursor: busy ? "progress" : "pointer",
          opacity: busy ? 0.6 : 1,
          font: "inherit",
        }}
      >
        <span style={{ opacity: 0.55 }}>↓</span>
        <span>{busy ? "받는 중…" : "매치 리플레이"}</span>
      </button>
      {err && <span style={{ fontSize: "0.72rem", fontWeight: 800, color: FUNKY.danger }}>{err}</span>}
    </div>
  );
}

/**
 * 승부가 끝났을 때의 결과 화면.
 *
 * 판 사이의 라운드 전환(RoundTransition)과 달리 여기서 멈춰 서서 결과를 곱씹는
 * 자리이므로, 승패를 크게 알리고 순위·리플레이·대기실 이동을 함께 둔다.
 * 승리 문구는 글자 하나씩 떨어져 박히고, 뒤에서 빛살이 돌고, 조각들이 흩날린다.
 */
function ResultsView({ room }: { room: RoomSession }) {
  const end = room.matchEnd!;
  const players = room.state?.players ?? [];
  const nickOf = (id: string) => players.find((p) => p.id === id)?.nick ?? "―";
  /*
    승수는 판이 끝났다는 메시지에 실려 온 값을 쓴다. 방 상태는 이 메시지 뒤에
    따라오므로 그걸 읽으면 이번 판 승리가 아직 반영되기 전이고, 대기실로 돌아갈
    때는 아예 0으로 지워진다 — 어느 쪽이든 결과 화면에 맞는 숫자가 아니다.
  */
  const winsOf = (id: string) =>
    end.standings.find((s) => s.playerId === id)?.wins ?? players.find((p) => p.id === id)?.wins ?? 0;
  const iWon = end.winnerId === room.myId;
  const firstTo = Math.max(1, room.state?.config?.firstTo ?? 1);
  /** FT를 채워 승부가 끝났다 — 인원이 모자라 중단된 경우와 구분한다 */
  const series = end.seriesWinnerId;
  const iTookSeries = series === room.myId;

  const champion = series ?? end.winnerId;
  const mine = champion === room.myId;
  /** 이긴 사람의 화면은 금빛, 진 사람은 차갑게 */
  const tone = champion ? (mine ? FUNKY.yellow : "#8d86a8") : "#8d86a8";
  const word = champion ? (mine ? "WINNER" : "DEFEAT") : "DRAW";
  const kicker = series
    ? firstTo > 1
      ? `FT${firstTo} 승부 종료`
      : "단판 종료"
    : champion
      ? "판 종료"
      : "무승부";

  /*
    잔치는 이긴 사람 몫이다. 빛살·띠·조각은 승리 화면에만 붙이고, 패배와
    무승부는 같은 뼈대에 담담하게 둔다 — 진 화면이 화려하면 놀리는 것처럼 보인다.
  */
  return (
    <div className={`fx-win${mine ? " is-win" : ""}`} style={{ color: tone }}>
      {mine && <div className="fx-win-rays" />}
      {mine && <div className="fx-win-beam" />}
      {mine && (
        <div className="fx-win-fall" aria-hidden>
          {CONFETTI.map((c, i) => (
            <span
              key={i}
              style={{
                left: `${c.x}%`,
                background: c.color,
                animationDelay: `${c.delay}ms`,
                animationDuration: `${c.dur}ms`,
                width: c.size,
                height: c.size,
              }}
            />
          ))}
        </div>
      )}

      <div className="fx-win-body">
        <div className="fx-win-kicker">{kicker}</div>

        {/* 글자 하나씩 박힌다 */}
        <div className="fx-win-word">
          {word.split("").map((ch, i) => (
            <span key={i} style={{ animationDelay: `${90 + i * 65}ms` }}>
              {ch}
            </span>
          ))}
        </div>

        {champion && (
          <div className="fx-win-who">
            {nickOf(champion)}
            <b>
              {winsOf(champion)}
              <i>/{firstTo}</i>
            </b>
          </div>
        )}

        <div className="fx-win-rows">
          {end.standings.slice(0, 8).map((st, i) => (
            <div
              key={st.playerId}
              className={
                "fx-win-row" +
                (st.placement === 1 ? " is-top" : "") +
                (st.playerId === room.myId ? " is-me" : "")
              }
              style={{ animationDelay: `${520 + i * 80}ms` }}
            >
              <span className="fx-win-rank">{st.placement}</span>
              <span className="fx-win-name">{nickOf(st.playerId)}</span>
              <span className="fx-win-wins">{winsOf(st.playerId)}</span>
            </div>
          ))}
        </div>

        <div className="fx-win-tools">
          <MatchReplayButton room={room} align="center" />
          <Button variant="primary" size="lg" onClick={() => room.skipResults()}>
            대기실로 돌아가기
          </Button>
          <Text variant="chrome" muted style={{ fontSize: "0.78rem" }}>
            누르지 않아도 잠시 후 자동으로 돌아갑니다
          </Text>
        </div>
      </div>
      {/* 아무도 안 쓰지만 값은 읽어 둔다 — 표기 분기에 쓰인다 */}
      <span hidden>{String(iWon || iTookSeries)}</span>
    </div>
  );
}

/** 흩날리는 조각 — 위치·속도를 미리 굳혀 두고 CSS가 떨어뜨린다 */
const CONFETTI = Array.from({ length: 34 }, (_, i) => {
  const palette = [FUNKY.pink, FUNKY.yellow, FUNKY.cyan, FUNKY.green, FUNKY.orange, FUNKY.purple];
  return {
    x: (i * 37) % 100,
    color: palette[i % palette.length],
    delay: (i * 173) % 2200,
    dur: 2600 + ((i * 311) % 2200),
    size: 6 + ((i * 7) % 9),
  };
});

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
  /** 목표 승수 — 먼저 이만큼 이기면 승부가 끝난다 */
  firstTo: number;
  canKick: boolean;
  onKick: () => void;
}) {
  return (
    <div className="fx-player-box" style={{ opacity: player.role === "spectator" ? 0.6 : 1 }}>
      {/* color까지 함께 줘야 점이 자기 색으로 번진다(글로우가 currentColor를 쓴다) */}
      <span className="fx-player-box__swatch" style={{ background: color, color }} />
      <span className="fx-player-box__name">{player.nick}</span>
      {/* 배지는 줄어들지 않는다 — 줄어들면 글자가 이름 위로 겹쳐 올라온다 */}
      <span style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto", whiteSpace: "nowrap" }}>
        {player.wins > 0 && <Badge color="yellow">{`${player.wins}/${firstTo}승`}</Badge>}
        {player.isBot && <Badge color="purple">{player.botOwner ? `BOT · ${player.botOwner}` : "BOT"}</Badge>}
        {player.isHost && <Badge color="yellow">호스트</Badge>}
        {me && <Badge color="sky">나</Badge>}
        {player.role === "spectator" && <Badge color="neutral">관전</Badge>}
        {/* 순단으로 끊긴 사람 — 자리는 잡아둔 상태다 */}
        {!player.connected && <Badge color="pink">연결 끊김</Badge>}
      </span>
      {canKick && (
        <button
          onClick={onKick}
          style={{
            marginLeft: "auto",
            flex: "0 0 auto",
            whiteSpace: "nowrap",
            border: "1px solid var(--funky-line)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--funky-ink-muted)",
            fontFamily: "inherit",
            fontWeight: 900,
            fontSize: "0.7rem",
            cursor: "pointer",
            padding: "2px 7px",
          }}
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
        <span className="fx-player-box__swatch" style={{ background: "rgba(255,255,255,0.22)", boxShadow: "none" }} />
        <span className="fx-player-box__name" style={{ opacity: 0.6 }}>{unlimited ? "봇 부르기" : "빈 자리"}</span>
        {canFill && (
          <button
            onClick={toggle}
            style={{ marginLeft: "auto", border: `1px solid ${open ? "transparent" : "var(--funky-line)"}`, borderRadius: 6, background: open ? FUNKY.sky : "transparent", color: open ? "#14101f" : "var(--funky-ink-muted)", fontFamily: "inherit", fontWeight: 900, fontSize: "0.7rem", cursor: "pointer", padding: "2px 7px" }}
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
            border: "1px solid var(--funky-line)",
            borderRadius: 10,
            overflow: "hidden",
            background: "rgba(26,20,44,0.97)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            fontSize: "0.75rem",
            fontWeight: 800,
          }}
        >
          {available.length === 0 ? (
            <div style={{ padding: "10px 12px", opacity: 0.7, lineHeight: 1.5 }}>
              대기 중인 봇이 없어요.
              <br />
              <span style={{ opacity: 0.7, fontWeight: 700 }}>봇 러너를 먼저 띄워야 합니다.</span>
              <br />
              {/* 직접 만들어 붙이려는 사람에게 갈 곳을 알려준다 */}
              <a
                href="/docs/bot"
                target="_blank"
                rel="noreferrer"
                style={{ color: FUNKY.purple, fontWeight: 800 }}
              >
                봇 API 문서 →
              </a>
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
                    borderBottom: "1px solid rgba(255,255,255,0.08)",
                    color: "var(--funky-ink)",
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
/** 공용 입력과 같은 재질 — 어두운 홈에 옅은 선 */
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.7rem",
  border: "1px solid var(--funky-line)",
  borderRadius: 8,
  background: "var(--funky-sunken)",
  color: "var(--funky-ink)",
  fontFamily: "inherit",
  fontWeight: 800,
  fontSize: "0.95rem",
};

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
