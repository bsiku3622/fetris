import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NetClient } from "../net/client";
import type {
  BotRunnerInfo,
  GameMessage,
  MatchConfig,
  MatchSimParams,
  PlayerRole,
  RoomState,
} from "../net/protocol";
import { MATCH_REPLAY_FORMAT } from "@fetris/engine/replay";
import type { MatchReplayFile, MatchReplayPlayerEntry } from "@fetris/engine/replay";
import type { Handling } from "@fetris/engine/types";

// ============================================================================
// useRoomSession — 방 연결을 화면보다 위층에서 유지하는 훅.
//
// 화면을 옮겨도(메뉴·Zen 등) 방에 계속 붙어 있어야 하므로, NetClient를 특정
// 화면이 아니라 App이 소유한다. 매치가 시작되면 어디에 있든 대전 화면으로
// 소환된다(App이 onMatchStart를 보고 화면을 바꾼다).
//
// 주의: 게임 플레이 중 리렌더를 늘리지 않도록, 여기서 노출하는 state는 방
// 상태(로스터·페이즈)와 매치 경계 이벤트뿐이다. 프레임 단위 정보는 절대
// React state로 올리지 않는다.
// ============================================================================

export interface MatchStartInfo {
  matchId: number;
  seed: number;
  config: MatchConfig;
  /** 참가자 id (나 포함) */
  players: string[];
  /** 참가자별 시드·감도 — 서로의 보드를 입력만으로 따라 돌리는 데 쓴다 */
  sim: MatchSimParams[];
}

export interface MatchEndInfo {
  matchId: number;
  winnerId: string | null;
  standings: { playerId: string; placement: number }[];
  /** 있으면 시리즈(FT)까지 끝났다는 뜻 */
  seriesWinnerId?: string;
  /** 결과 화면이 걷히면 서버가 다음 판을 이어 연다 */
  nextRound?: boolean;
  /** 다음 판이 열리기까지 남은 시간(ms) — 전환 연출을 여기 맞춘다 */
  nextIn?: number;
}

export interface ChatLine {
  /** 빈 문자열이면 시스템 메시지 */
  nick: string;
  text: string;
}

export interface RoomSession {
  /** 연결돼 있으면 NetClient, 아니면 null */
  net: NetClient | null;
  state: RoomState | null;
  myId: string | null;
  code: string;
  error: string;
  chat: ChatLine[];
  /** 서버가 보낸 마지막 매치 시작 정보(대전 화면이 소비) */
  matchStart: MatchStartInfo | null;
  matchEnd: MatchEndInfo | null;
  /** 이번 매치에서 내가 탈락했는지 */
  koed: boolean;
  /** 부를 수 있는 봇 러너 — list-runners 응답으로 채워진다 */
  runners: BotRunnerInfo[];
/** 방금 끝난 판을 내려받을 수 있는지 */
  canDownloadMatch: boolean;

  connect(
    url: string,
    mode: "host" | "join",
    opts: { code?: string; maxPlayers?: number; nick: string; handling?: Handling },
  ): Promise<void>;
  leave(): void;
  setRole(role: PlayerRole): void;
  setConfig(config: MatchConfig): void;
  /**
   * 내 감도를 서버에 알린다. 감도는 개인 설정이라 방 설정과 별개인데, 남들이
   * 내 보드를 입력만으로 따라 돌리려면 이 값이 필요하다.
   */
  setHandling(handling: Handling): void;
  startMatch(): void;
  /** 결과 대기시간을 건너뛰고 대기실로 */
  skipResults(): void;
  /** 호스트 전용: 진행 중인 FT 시리즈를 접고 대기실로 */
  abortSeries(): void;
  /** runnerId를 주면 그 러너를 지목해 부른다 */
  addBot(runnerId?: string): void;
  kickBot(playerId: string): void;
  /** 러너 목록 새로고침 요청 */
  refreshRunners(): void;
  /** 매치가 끝날 때 대전 화면이 내 기록을 넘겨준다 */
  storeReplay(entry: MatchReplayPlayerEntry): void;
  /**
   * 방금 끝난 판을 통째로 만들어 돌려준다. 서버가 중계하며 받아 적은 녹화를
   * 받아오고, 입력 로그를 낸 참가자는 그걸로 승급시킨다.
   */
  buildMatchReplay(): Promise<MatchReplayFile>;
  sendChat(nick: string, text: string): void;
  /** 대전 화면이 매치를 인수했을 때 — 같은 매치로 다시 소환되지 않게 비운다 */
  consumeMatchStart(): void;
  clearMatchEnd(): void;
  clearError(): void;
  pushSystemChat(text: string): void;
}

export function humanError(reason: string): string {
  switch (reason) {
    case "room-not-found": return "방을 찾을 수 없어요. 코드를 확인해주세요.";
    case "room-full": return "이미 꽉 찬 방이에요.";
    case "not-host": return "호스트만 할 수 있는 동작이에요.";
    case "not-in-lobby": return "매치가 진행 중이라 지금은 할 수 없어요.";
    case "not-enough-players": return "최소 2명이 참가해야 시작할 수 있어요.";
    case "no-config": return "매치 설정을 먼저 저장해주세요.";
    case "no-bot-available": return "대기 중인 봇 러너가 없어요.";
    case "bot-join-timeout": return "봇이 제때 들어오지 못했어요.";
    case "not-a-bot": return "봇만 내보낼 수 있어요.";
    default: return "오류가 발생했어요: " + reason;
  }
}

export function useRoomSession(): RoomSession {
  const netRef = useRef<NetClient | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [matchStart, setMatchStart] = useState<MatchStartInfo | null>(null);
  const [matchEnd, setMatchEnd] = useState<MatchEndInfo | null>(null);
  const [koed, setKoed] = useState(false);
  const [runners, setRunners] = useState<BotRunnerInfo[]>([]);
  /** 참가자별 원시 기록 — 여기서 매치 리플레이 한 벌을 조립한다 */
  const [records, setRecords] = useState<MatchReplayPlayerEntry[]>([]);
  /** 로스터 대비 입퇴장 안내를 만들기 위한 직전 스냅샷 */
  const prevPlayers = useRef<Map<string, string>>(new Map());
  /** 콜백 안에서 최신 매치 정보를 보기 위한 사본(state는 클로저에 갇힌다) */
  const matchStartRef = useRef<MatchStartInfo | null>(null);
  /** 재연결에 필요한 마지막 접속 정보 */
  const lastConnect = useRef<{ url: string; code: string; nick: string; handling?: Handling } | null>(null);
  /** 끊겼을 때 원래 자리로 돌아가기 위한 토큰 */
  const sessionToken = useRef<string | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTries = useRef(0);
  /** 사용자가 직접 나간 경우엔 재연결하지 않는다 */
  const leftOnPurpose = useRef(false);

  const pushChat = useCallback((line: ChatLine) => {
    setChat((prev) => [...prev.slice(-59), line]);
  }, []);

  const pushSystemChat = useCallback((text: string) => {
    pushChat({ nick: "", text });
  }, [pushChat]);

  useEffect(() => {
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      netRef.current?.disconnect();
      netRef.current = null;
    };
  }, []);

  const wire = useCallback(
    (net: NetClient) => {
      net.onError = (reason) => setError(humanError(reason));
      net.onDisconnect = () => {
        setState(null);
        // 스스로 나간 게 아니라면 같은 방으로 되돌아가려 시도한다.
        // 잠깐의 네트워크 순단으로 방에서 튕겨나가는 걸 막는다.
        if (leftOnPurpose.current || !lastConnect.current) {
          setError("서버 연결이 끊겼습니다.");
          return;
        }
        scheduleReconnect();
      };
      net.onRoomState = (s) => {
        sessionToken.current = net.session;
        // 입퇴장을 채팅에 흘린다
        const now = new Map(s.players.map((p) => [p.id, p.nick] as const));
        for (const [id, nick] of now) {
          if (!prevPlayers.current.has(id) && id !== net.myId) {
            pushChat({ nick: "", text: `${nick}님이 입장했습니다` });
          }
        }
        for (const [id, nick] of prevPlayers.current) {
          if (!now.has(id)) pushChat({ nick: "", text: `${nick}님이 나갔습니다` });
        }
        prevPlayers.current = now;
        setState(s);
        if (s.phase === "lobby") setKoed(false);
      };
      net.onMatchStart = (matchId, seed, config, players, sim) => {
        matchStartRef.current = { matchId, seed, config, players, sim };
        setKoed(false);
        setMatchEnd(null);
        setRecords([]);
        setMatchStart({ matchId, seed, config, players, sim });
      };
      net.onKO = (playerId) => {
        if (playerId === net.myId) setKoed(true);
        const nick = net.room?.players.find((p) => p.id === playerId)?.nick ?? "누군가";
        pushChat({ nick: "", text: `${nick}님이 KO됐습니다` });
      };
      net.onMatchEnd = (matchId, winnerId, standings, seriesWinnerId, nextRound, nextIn) => {
        setMatchEnd({ matchId, winnerId, standings, seriesWinnerId, nextRound, nextIn });
        const champ = net.room?.players.find((p) => p.id === winnerId)?.nick;
        pushChat({ nick: "", text: champ ? `${champ}님이 승리했습니다` : "무승부로 끝났습니다" });
        if (seriesWinnerId) {
          const series = net.room?.players.find((p) => p.id === seriesWinnerId)?.nick;
          if (series) pushChat({ nick: "", text: `🏆 ${series}님이 시리즈를 가져갔습니다` });
        }
      };
      /*
        참가자들이 검증용으로 낸 로그를 모은다. 이건 아직 재료다 —
        내려받는 산출물은 이걸 한데 묶은 "판 하나"이고, 조립은 아래 useMemo에서 한다.
      */
      net.onReplayRecord = (r) => {
        const who = net.room?.players.find((p) => p.id === r.playerId);
        setRecords((prev) => {
          const entry: MatchReplayPlayerEntry = {
            id: r.playerId,
            nick: who?.nick ?? "player",
            placement: who?.placement ?? undefined,
            seed: r.seed,
            handling: r.handling,
            frames: r.frames,
            keys: r.keys,
            garbage: r.garbage,
            fingerprint: r.fingerprint,
            stats: r.stats,
          };
          return prev.some((x) => x.id === entry.id)
            ? prev.map((x) => (x.id === entry.id ? entry : x))
            : [...prev, entry];
        });
      };
      net.onBotPending = (nick) => pushSystemChat(`${nick} 합류 중…`);
      net.onRunners = (list) => setRunners(list);
      net.onGameMessage = (m: GameMessage) => {
        if (m.t === "chat") pushChat({ nick: m.nick, text: m.text });
        else if (m.t === "replay-share") {
          // 옛 방식으로 파일째 나눠주는 러너 호환 — 참가자 항목으로 풀어 담는다
          const f = m.file;
          const entry: MatchReplayPlayerEntry = {
            id: f.player.id ?? f.player.nick,
            nick: f.player.nick,
            placement: f.player.placement,
            seed: f.seed,
            frames: f.frames,
            keys: f.keys,
            garbage: f.garbage,
            fingerprint: f.fingerprint,
            stats: f.stats,
          };
          setRecords((prev) => (prev.some((x) => x.id === entry.id) ? prev : [...prev, entry]));
        }
      };
    },
    [pushChat, pushSystemChat],
  );

  /**
   * 끊긴 방으로 되돌아간다. 매치가 진행 중이면 서버가 관전자로 앉히므로
   * 판을 망치지 않고, 대기실이었다면 참가자로 복귀한다.
   */
  const scheduleReconnect = useCallback(() => {
    const info = lastConnect.current;
    if (!info) return;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (reconnectTries.current >= 5) {
      setError("서버 연결이 끊겼습니다. 다시 입장해주세요.");
      return;
    }
    const attempt = ++reconnectTries.current;
    const delay = Math.min(8000, 1000 * attempt);
    setError(`연결이 끊겨 다시 접속하는 중… (${attempt}/5)`);
    const token = sessionToken.current;
    reconnectTimer.current = setTimeout(async () => {
      const net = new NetClient(info.url);
      net.session = token;
      netRef.current = net;
      wire(net);
      const settle = (c: string) => {
        setCode(c);
        setMyId(net.myId);
        setError("");
        reconnectTries.current = 0;
      };
      net.onJoined = settle;
      net.onResumed = settle;
      /*
        먼저 원래 자리로 복귀를 시도한다. 매치 중이었다면 서버가 잠깐 자리를
        잡아두고 있으므로 판에서 밀려나지 않는다. 자리가 이미 정리됐으면
        resume-failed가 오고, 그때 새로 입장한다.
      */
      net.onError = (reason) => {
        if (reason === "resume-failed") {
          net.session = null;
          net.joinRoom(info.code, info.nick, info.handling);
          return;
        }
        setError(humanError(reason));
      };
      try {
        await net.connect();
        if (token) net.resume();
        else net.joinRoom(info.code, info.nick, info.handling);
      } catch {
        scheduleReconnect();
      }
    }, delay);
  }, [wire]);

  const connect = useCallback(
    async (
      url: string,
      mode: "host" | "join",
      opts: { code?: string; maxPlayers?: number; nick: string; handling?: Handling },
    ) => {
      setError("");
      setChat([]);
      prevPlayers.current = new Map();
      leftOnPurpose.current = false;
      reconnectTries.current = 0;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      netRef.current?.disconnect();
      const net = new NetClient(url);
      netRef.current = net;
      wire(net);
      net.onCreated = (c) => {
        setCode(c);
        setMyId(net.myId);
        // 재연결 때는 방을 새로 만들 수 없으니 코드로 되돌아간다
        lastConnect.current = { url, code: c, nick: opts.nick, handling: opts.handling };
      };
      net.onJoined = (c) => {
        setCode(c);
        setMyId(net.myId);
        lastConnect.current = { url, code: c, nick: opts.nick, handling: opts.handling };
      };
      try {
        await net.connect();
      } catch {
        setError("서버에 연결할 수 없습니다. 주소를 확인해주세요.");
        return;
      }
      if (mode === "host") net.createRoom(opts.maxPlayers ?? 0, opts.nick, opts.handling);
      else net.joinRoom(opts.code ?? "", opts.nick, opts.handling);
    },
    [wire],
  );

  const leave = useCallback(() => {
    leftOnPurpose.current = true;
    lastConnect.current = null;
    reconnectTries.current = 0;
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    netRef.current?.disconnect();
    netRef.current = null;
    setState(null);
    setMyId(null);
    setCode("");
    setChat([]);
    setMatchStart(null);
    setMatchEnd(null);
    setKoed(false);
    setRecords([]);
    prevPlayers.current = new Map();
  }, []);

  /**
   * 모인 참가자 기록을 판 하나로 묶는다. 산출물은 사람이 다시 보고 싶어 하는
   * 단위 — "그 판" — 이지 개별 입력 로그가 아니다.
   *
   * 아직 안 낸 사람이 있어도 있는 만큼으로 만든다. 제출은 각자 따로 도착하고,
   * 아예 안 내는 참가자(리플레이를 지원하지 않는 봇)도 있기 때문이다.
   */
  /**
   * 판 하나를 통째로 만든다.
   *
   * 바닥은 서버 녹화다 — 중계하는 김에 받아 적은 것이라 참가자의 협조와
   * 무관하게 존재한다. 입력 스트림까지 받아 적으므로, 본인이 아무것도
   * 제출하지 않아도(리플레이를 지원하지 않는 봇이라도) 그 판은 60Hz로
   * 정확히 되살아난다.
   *
   * 검증용으로 따로 제출한 사람은 그 기록을 그대로 쓴다 — 지문이 함께 있어
   * 파일을 열 때 온전한지까지 확인할 수 있기 때문이다.
   */
  const buildMatchReplay = useCallback(async (): Promise<MatchReplayFile> => {
    const net = netRef.current;
    if (!net) throw new Error("방에 연결돼 있지 않아요");
    const config = matchStartRef.current?.config ?? net.room?.config;
    if (!config) throw new Error("매치 설정을 알 수 없어요");

    const rec = await net.fetchRecording();
    const logged = new Map(records.map((r) => [r.id, r]));
    const players: MatchReplayPlayerEntry[] = rec.players
      .map((p) => {
        const base = { id: p.id, nick: p.nick, placement: p.placement ?? undefined };
        const log = logged.get(p.id);
        if (log) return { ...log, ...base };
        // 제출은 없지만 서버가 받아 적은 입력이 있으면 그걸로 재현한다
        if (p.keys && p.frames) {
          return {
            ...base,
            seed: p.seed,
            handling: p.handling,
            frames: p.frames,
            keys: p.keys,
            garbage: p.garbage,
          };
        }
        return base;
      })
      .sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99));

    return {
      format: MATCH_REPLAY_FORMAT,
      game: "fetris",
      recordedAt: new Date(rec.startedAt).toISOString(),
      match: {
        code: rec.code,
        matchId: rec.matchId,
        winnerId: rec.winnerId ?? undefined,
      },
      rule: config.rule,
      handling: config.handling,
      simRate: config.simRate,
      players,
      timeline: rec.frames,
      truncated: rec.truncated || undefined,
    };
  }, [records]);

  return useMemo<RoomSession>(
    () => ({
      net: netRef.current,
      state,
      myId,
      code,
      error,
      chat,
      matchStart,
      matchEnd,
      koed,
      runners,
      canDownloadMatch: !!matchEnd,
      buildMatchReplay,
      connect,
      leave,
      setRole: (r) => netRef.current?.setRole(r),
      setConfig: (c) => netRef.current?.setConfig(c),
      setHandling: (h) => netRef.current?.setHandling(h),
      startMatch: () => netRef.current?.startMatch(),
      skipResults: () => netRef.current?.skipResults(),
      abortSeries: () => netRef.current?.abortSeries(),
      addBot: (runnerId) => netRef.current?.addBot(undefined, runnerId),
      kickBot: (id) => netRef.current?.kickBot(id),
      refreshRunners: () => netRef.current?.listRunners(),
      storeReplay: (entry) => {
        // 내 몫도 남들 것과 같은 자료로 모은다(서버가 나에게는 되돌려주지 않는다)
        setRecords((prev) =>
          prev.some((x) => x.id === entry.id)
            ? prev.map((x) => (x.id === entry.id ? entry : x))
            : [...prev, entry],
        );
      },
      sendChat: (nick, text) => {
        netRef.current?.sendGame({ t: "chat", nick, text });
        pushChat({ nick, text });
      },
      consumeMatchStart: () => setMatchStart(null),
      clearMatchEnd: () => setMatchEnd(null),
      clearError: () => setError(""),
      pushSystemChat,
    }),
    [state, myId, code, error, chat, matchStart, matchEnd, koed, runners, buildMatchReplay, connect, leave, pushChat, pushSystemChat],
  );
}
