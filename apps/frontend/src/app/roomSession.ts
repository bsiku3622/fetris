import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NetClient } from "../net/client";
import type { BotRunnerInfo, GameMessage, MatchConfig, PlayerRole, RoomState } from "../net/protocol";

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
}

export interface CountdownInfo {
  matchId: number;
  /** 서버 기준 epoch ms */
  startsAt: number;
  seconds: number;
}

export interface MatchEndInfo {
  matchId: number;
  winnerId: string | null;
  standings: { playerId: string; placement: number }[];
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
  countdown: CountdownInfo | null;
  matchEnd: MatchEndInfo | null;
  /** 이번 매치에서 내가 탈락했는지 */
  koed: boolean;
  /** 부를 수 있는 봇 러너 — list-runners 응답으로 채워진다 */
  runners: BotRunnerInfo[];

  connect(url: string, mode: "host" | "join", opts: { code?: string; maxPlayers?: number; nick: string }): Promise<void>;
  leave(): void;
  setReady(ready: boolean): void;
  setRole(role: PlayerRole): void;
  setConfig(config: MatchConfig): void;
  startMatch(): void;
  /** runnerId를 주면 그 러너를 지목해 부른다 */
  addBot(runnerId?: string): void;
  kickBot(playerId: string): void;
  /** 러너 목록 새로고침 요청 */
  refreshRunners(): void;
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
    case "not-everyone-ready": return "아직 준비하지 않은 참가자가 있어요.";
    case "no-config": return "매치 설정을 먼저 저장해주세요.";
    case "no-bot-available": return "대기 중인 봇 러너가 없어요.";
    case "bot-join-timeout": return "봇이 제때 들어오지 못했어요.";
    case "spectator-cannot-ready": return "관전자는 준비할 수 없어요.";
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
  const [countdown, setCountdown] = useState<CountdownInfo | null>(null);
  const [matchEnd, setMatchEnd] = useState<MatchEndInfo | null>(null);
  const [koed, setKoed] = useState(false);
  const [runners, setRunners] = useState<BotRunnerInfo[]>([]);
  /** 로스터 대비 입퇴장 안내를 만들기 위한 직전 스냅샷 */
  const prevPlayers = useRef<Map<string, string>>(new Map());

  const pushChat = useCallback((line: ChatLine) => {
    setChat((prev) => [...prev.slice(-59), line]);
  }, []);

  const pushSystemChat = useCallback((text: string) => {
    pushChat({ nick: "", text });
  }, [pushChat]);

  useEffect(() => {
    return () => {
      netRef.current?.disconnect();
      netRef.current = null;
    };
  }, []);

  const wire = useCallback(
    (net: NetClient) => {
      net.onError = (reason) => setError(humanError(reason));
      net.onDisconnect = () => {
        setState(null);
        setError("서버 연결이 끊겼습니다.");
      };
      net.onRoomState = (s) => {
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
        if (s.phase === "lobby") {
          setKoed(false);
          setCountdown(null);
        }
      };
      net.onCountdown = (matchId, startsAt, seconds) => {
        setCountdown({ matchId, startsAt, seconds });
        setMatchEnd(null);
      };
      net.onMatchStart = (matchId, seed, config, players) => {
        setCountdown(null);
        setKoed(false);
        setMatchStart({ matchId, seed, config, players });
      };
      net.onKO = (playerId) => {
        if (playerId === net.myId) setKoed(true);
        const nick = net.room?.players.find((p) => p.id === playerId)?.nick ?? "누군가";
        pushChat({ nick: "", text: `${nick}님이 KO됐습니다` });
      };
      net.onMatchEnd = (matchId, winnerId, standings) => {
        setMatchEnd({ matchId, winnerId, standings });
        const champ = net.room?.players.find((p) => p.id === winnerId)?.nick;
        pushChat({ nick: "", text: champ ? `${champ}님이 승리했습니다` : "무승부로 끝났습니다" });
      };
      net.onBotPending = (nick) => pushSystemChat(`${nick} 합류 중…`);
      net.onRunners = (list) => setRunners(list);
      net.onGameMessage = (m: GameMessage) => {
        if (m.t === "chat") pushChat({ nick: m.nick, text: m.text });
      };
    },
    [pushChat, pushSystemChat],
  );

  const connect = useCallback(
    async (
      url: string,
      mode: "host" | "join",
      opts: { code?: string; maxPlayers?: number; nick: string },
    ) => {
      setError("");
      setChat([]);
      prevPlayers.current = new Map();
      netRef.current?.disconnect();
      const net = new NetClient(url);
      netRef.current = net;
      wire(net);
      net.onCreated = (c) => {
        setCode(c);
        setMyId(net.myId);
      };
      net.onJoined = (c) => {
        setCode(c);
        setMyId(net.myId);
      };
      try {
        await net.connect();
      } catch {
        setError("서버에 연결할 수 없습니다. 주소를 확인해주세요.");
        return;
      }
      if (mode === "host") net.createRoom(opts.maxPlayers ?? 4, opts.nick);
      else net.joinRoom(opts.code ?? "", opts.nick);
    },
    [wire],
  );

  const leave = useCallback(() => {
    netRef.current?.disconnect();
    netRef.current = null;
    setState(null);
    setMyId(null);
    setCode("");
    setChat([]);
    setMatchStart(null);
    setCountdown(null);
    setMatchEnd(null);
    setKoed(false);
    prevPlayers.current = new Map();
  }, []);

  return useMemo<RoomSession>(
    () => ({
      net: netRef.current,
      state,
      myId,
      code,
      error,
      chat,
      matchStart,
      countdown,
      matchEnd,
      koed,
      runners,
      connect,
      leave,
      setReady: (r) => netRef.current?.setReady(r),
      setRole: (r) => netRef.current?.setRole(r),
      setConfig: (c) => netRef.current?.setConfig(c),
      startMatch: () => netRef.current?.startMatch(),
      addBot: (runnerId) => netRef.current?.addBot(undefined, runnerId),
      kickBot: (id) => netRef.current?.kickBot(id),
      refreshRunners: () => netRef.current?.listRunners(),
      sendChat: (nick, text) => {
        netRef.current?.sendGame({ t: "chat", nick, text });
        pushChat({ nick, text });
      },
      consumeMatchStart: () => setMatchStart(null),
      clearMatchEnd: () => setMatchEnd(null),
      clearError: () => setError(""),
      pushSystemChat,
    }),
    [state, myId, code, error, chat, matchStart, countdown, matchEnd, koed, runners, connect, leave, pushChat, pushSystemChat],
  );
}
