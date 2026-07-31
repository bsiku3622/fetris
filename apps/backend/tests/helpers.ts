import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "@fetris/engine/config";
import { startServer, type RelayServer, type RelayServerOptions } from "../src/server.js";
import type { ServerControl, RoomState, MatchConfig } from "../src/protocol.js";

/** 임의 포트로 서버를 띄우고 접속 URL을 함께 돌려준다 */
export async function startTestServer(
  opts: RelayServerOptions = {},
): Promise<{ server: RelayServer; url: string }> {
  const server = startServer(0, opts);
  if (!server.http.listening) {
    await new Promise<void>((res) => server.http.once("listening", () => res()));
  }
  const addr = server.http.address() as AddressInfo;
  return { server, url: `ws://127.0.0.1:${addr.port}` };
}

/** 메시지를 버퍼링하며 다음 메시지를 await 할 수 있는 테스트 클라이언트 */
export class Client {
  ws: WebSocket;
  /** 서버가 내준 세션 토큰(복귀용) */
  session: string | null = null;
  /** 마지막으로 받은 메시지 번호 */
  lastSeenId = 0;
  private queue: ServerControl[] = [];
  private waiter: ((m: ServerControl) => void) | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as ServerControl;
      if (typeof m.id === "number") this.lastSeenId = m.id;
      if (m.t === "created" || m.t === "joined") this.session = m.session;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(m);
      } else {
        this.queue.push(m);
      }
    });
  }

  /** path에 "/bot"을 주면 봇 경로로 접속한다 */
  static async connect(url: string, path = "/"): Promise<Client> {
    const ws = new WebSocket(url + path);
    // 서버가 연결 직후 보내는 메시지(인증 거부 등)를 놓치지 않도록 먼저 리스너를 건다
    const client = new Client(ws);
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    return client;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(timeoutMs = 1000): Promise<ServerControl> {
    const buffered = this.queue.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise<ServerControl>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("메시지 대기 타임아웃")), timeoutMs);
      this.waiter = (m) => {
        clearTimeout(timer);
        res(m);
      };
    });
  }

  /** 원하는 타입이 나올 때까지 읽어 넘긴다(중간의 state 브로드캐스트 등을 건너뛸 때) */
  async waitFor<T extends ServerControl["t"]>(
    type: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerControl, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error(`'${type}' 대기 타임아웃`);
      const m = await this.next(remain);
      if (m.t === type) return m as Extract<ServerControl, { t: T }>;
    }
  }

  /**
   * 조건을 만족하는 state가 올 때까지 기다린다.
   * 입퇴장·준비 변경은 여러 번의 state로 나뉘어 오므로, 첫 state만 보면 안 된다.
   */
  async waitState(pred: (s: RoomState) => boolean, timeoutMs = 2000): Promise<RoomState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error("조건을 만족하는 state 대기 타임아웃");
      const m = await this.next(remain);
      if (m.t === "state" && pred(m.state)) return m.state;
      if (m.t === "created" || m.t === "joined") {
        if (pred(m.state)) return m.state;
      }
    }
  }

  /** 버퍼에 쌓인 메시지를 비운다 */
  drain(): void {
    this.queue.length = 0;
  }

  closed(timeoutMs = 1000): Promise<number> {
    return new Promise<number>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("close 대기 타임아웃")), timeoutMs);
      this.ws.once("close", (code) => {
        clearTimeout(timer);
        res(code);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * 테스트용 매치 설정. 서버는 rule/handling을 해석하지 않지만, 리플레이 검증에서는
 * 실제로 엔진에 넘겨 재현하므로 진짜 룰셋을 쓴다.
 */
export const TEST_CONFIG: MatchConfig = {
  rule: STANDARD_RULESET,
  handling: DEFAULT_HANDLING,
  simRate: 60,
  sharePieces: true,
  undo: false,
  attackMul: 1,
  firstTo: 0,
};

/** 방을 만들고 호스트 클라이언트·코드·초기 상태를 돌려준다 */
export async function createRoom(
  url: string,
  maxPlayers = 0, // 0 = 제한 없음(서버 기본값과 동일)
  nick = "호스트",
): Promise<{ host: Client; code: string; state: RoomState }> {
  const host = await Client.connect(url);
  host.send({ t: "create", maxPlayers, nick });
  const created = await host.next();
  if (created.t !== "created") throw new Error("방 생성 실패");
  return { host, code: created.code, state: created.state };
}

/** 게스트를 입장시키고 입장 응답까지 받는다 */
export async function joinRoom(url: string, code: string, nick: string): Promise<Client> {
  const guest = await Client.connect(url);
  guest.send({ t: "join", code, nick });
  const joined = await guest.next();
  if (joined.t !== "joined") throw new Error(`입장 실패: ${JSON.stringify(joined)}`);
  return guest;
}

/** state 메시지에서 특정 플레이어 정보를 꺼낸다 */
export function playerIn(state: RoomState, id: string) {
  return state.players.find((p) => p.id === id);
}
