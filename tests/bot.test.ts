import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { startServer, type RelayServer } from "../src/server.js";
import type { ServerControl } from "../src/protocol.js";

let server: RelayServer;
let base: string;

beforeAll(async () => {
  server = startServer(0);
  if (!server.http.listening) {
    await new Promise<void>((res) => server.http.once("listening", () => res()));
  }
  const addr = server.http.address() as AddressInfo;
  base = `ws://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await server.close();
});

/** 메시지를 버퍼링하며 다음 메시지를 await 할 수 있는 테스트 클라이언트 */
class Client {
  ws: WebSocket;
  private queue: ServerControl[] = [];
  private waiter: ((m: ServerControl) => void) | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as ServerControl;
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
  static async connect(path = "/", url = base): Promise<Client> {
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

/** 호스트 하나로 방을 만들고 코드를 돌려준다 */
async function makeRoom(maxPlayers = 4): Promise<{ host: Client; code: string }> {
  const host = await Client.connect();
  host.send({ t: "create", maxPlayers, nick: "호스트" });
  const created = await host.next();
  if (created.t !== "created") throw new Error("방 생성 실패");
  return { host, code: created.code };
}

/** 러너를 등록하고 준비 상태를 확인한다 */
async function makeRunner(capacity = 1, name = "테스트러너"): Promise<Client> {
  const runner = await Client.connect("/bot");
  runner.send({ t: "bot-hello", name, capacity });
  const ready = await runner.next();
  expect(ready.t).toBe("bot-ready");
  return runner;
}

describe("봇 엔드포인트", () => {
  it("/bot에 붙은 러너는 bot-hello로 등록된다", async () => {
    const runner = await Client.connect("/bot");
    runner.send({ t: "bot-hello", name: "더미봇", capacity: 3 });
    const m = await runner.next();
    expect(m.t).toBe("bot-ready");
    if (m.t === "bot-ready") {
      expect(m.runner.name).toBe("더미봇");
      expect(m.runner.capacity).toBe(3);
      expect(m.runner.active).toBe(0);
      expect(m.runner.id).toMatch(/^r/);
    }
    runner.close();
  });

  it("사람 경로(/)에서 bot-hello를 보내면 거부된다", async () => {
    const human = await Client.connect();
    human.send({ t: "bot-hello", name: "위장봇" });
    const m = await human.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("bot-path-required");
    human.close();
  });

  it("호스트의 add-bot이 러너를 초대하고, 봇이 티켓으로 착석한다", async () => {
    const runner = await makeRunner();
    const { host, code } = await makeRoom();

    host.send({ t: "add-bot" });
    const pending = await host.next();
    expect(pending.t).toBe("bot-pending");

    const invite = await runner.next();
    expect(invite.t).toBe("bot-invite");
    if (invite.t !== "bot-invite") throw new Error("초대 없음");
    expect(invite.code).toBe(code);
    expect(invite.nick).toBe("Bot 1");

    // 러너가 봇용 연결을 새로 열어 티켓으로 입장
    const bot = await Client.connect("/bot");
    bot.send({ t: "join", code: invite.code, ticket: invite.ticket });
    const joined = await bot.next();
    expect(joined.t).toBe("joined");
    if (joined.t === "joined") expect(joined.players[0].nick).toBe("호스트");

    const peer = await host.next();
    expect(peer.t).toBe("peer-joined");
    if (peer.t === "peer-joined") {
      expect(peer.player.isBot).toBe(true);
      expect(peer.player.nick).toBe("Bot 1");
    }

    host.close();
    bot.close();
    runner.close();
  });

  it("봇도 일반 참가자로 게임 메시지를 주고받는다", async () => {
    const runner = await makeRunner();
    const { host } = await makeRoom();
    host.send({ t: "add-bot", nick: "스파링" });
    await host.next(); // bot-pending
    const invite = await runner.next();
    if (invite.t !== "bot-invite") throw new Error("초대 없음");

    const bot = await Client.connect("/bot");
    bot.send({ t: "join", code: invite.code, ticket: invite.ticket });
    await bot.next(); // joined
    const peer = await host.next();
    if (peer.t !== "peer-joined") throw new Error("착석 실패");
    expect(peer.player.nick).toBe("스파링");

    host.send({ t: "relay", msg: { t: "start", seed: 42 } });
    const got = await bot.next();
    expect(got.t).toBe("relay");
    if (got.t === "relay") expect(got.msg).toEqual({ t: "start", seed: 42 });

    bot.send({ t: "relay-to", targetId: got.t === "relay" ? got.from : "", msg: { t: "dead" } });
    const back = await host.next();
    expect(back.t).toBe("relay");
    if (back.t === "relay") expect(back.msg).toEqual({ t: "dead" });

    host.close();
    bot.close();
    runner.close();
  });

  it("대기 중인 러너가 없으면 no-bot-available", async () => {
    const { host } = await makeRoom();
    host.send({ t: "add-bot" });
    const m = await host.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("no-bot-available");
    host.close();
  });

  it("호스트가 아니면 add-bot이 거부된다", async () => {
    const runner = await makeRunner();
    const { host, code } = await makeRoom();
    const guest = await Client.connect();
    guest.send({ t: "join", code });
    await guest.next(); // joined
    await host.next(); // peer-joined

    guest.send({ t: "add-bot" });
    const m = await guest.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("not-host");

    host.close();
    guest.close();
    runner.close();
  });

  it("잘못된 티켓은 입장할 수 없다", async () => {
    const bot = await Client.connect("/bot");
    bot.send({ t: "join", code: "ZZZZ", ticket: "없는-티켓" });
    const m = await bot.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("invalid-ticket");
    bot.close();
  });

  it("사람 경로에서는 티켓을 쓸 수 없다", async () => {
    const human = await Client.connect();
    human.send({ t: "join", code: "ZZZZ", ticket: "아무거나" });
    const m = await human.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("bot-path-required");
    human.close();
  });

  it("예약된 봇 슬롯이 정원을 차지한다", async () => {
    const runner = await makeRunner();
    const { host, code } = await makeRoom(2);
    host.send({ t: "add-bot" });
    await host.next(); // bot-pending — 아직 착석 전이지만 슬롯은 예약됨
    await runner.next(); // bot-invite

    const late = await Client.connect();
    late.send({ t: "join", code });
    const m = await late.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("room-full");

    host.close();
    late.close();
    runner.close();
  });

  it("정원이 찬 방에는 봇을 추가할 수 없다", async () => {
    const runner = await makeRunner();
    const { host, code } = await makeRoom(2);
    const guest = await Client.connect();
    guest.send({ t: "join", code });
    await guest.next();
    await host.next(); // peer-joined

    host.send({ t: "add-bot" });
    const m = await host.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("room-full");

    host.close();
    guest.close();
    runner.close();
  });

  it("러너 정원(capacity)을 넘으면 더 부를 수 없다", async () => {
    const runner = await makeRunner(1, "정원1러너");
    const { host } = await makeRoom();
    host.send({ t: "add-bot" });
    await host.next(); // bot-pending
    await runner.next(); // bot-invite (러너 점유 1/1)

    host.send({ t: "add-bot" });
    const m = await host.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("no-bot-available");

    host.close();
    runner.close();
  });

  it("호스트는 kick-bot으로 봇을 내보낼 수 있다", async () => {
    const runner = await makeRunner();
    const { host } = await makeRoom();
    host.send({ t: "add-bot" });
    await host.next(); // bot-pending
    const invite = await runner.next();
    if (invite.t !== "bot-invite") throw new Error("초대 없음");

    const bot = await Client.connect("/bot");
    bot.send({ t: "join", code: invite.code, ticket: invite.ticket });
    await bot.next(); // joined
    const peer = await host.next();
    if (peer.t !== "peer-joined") throw new Error("착석 실패");

    host.send({ t: "kick-bot", playerId: peer.player.id });
    const left = await host.next();
    expect(left.t).toBe("peer-left");
    if (left.t === "peer-left") expect(left.playerId).toBe(peer.player.id);
    expect(await bot.closed()).toBe(1000);

    host.close();
    runner.close();
  });

  it("봇이 아닌 플레이어는 kick-bot 대상이 아니다", async () => {
    const { host, code } = await makeRoom();
    const guest = await Client.connect();
    guest.send({ t: "join", code });
    await guest.next();
    const peer = await host.next();
    if (peer.t !== "peer-joined") throw new Error("입장 실패");

    host.send({ t: "kick-bot", playerId: peer.player.id });
    const m = await host.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("not-a-bot");

    host.close();
    guest.close();
  });

  it("사람이 모두 나가면 봇만 남은 방은 정리된다", async () => {
    const runner = await makeRunner();
    const { host, code } = await makeRoom();
    host.send({ t: "add-bot" });
    await host.next(); // bot-pending
    const invite = await runner.next();
    if (invite.t !== "bot-invite") throw new Error("초대 없음");

    const bot = await Client.connect("/bot");
    bot.send({ t: "join", code: invite.code, ticket: invite.ticket });
    await bot.next(); // joined
    await host.next(); // peer-joined

    host.close();
    expect(await bot.closed()).toBe(1000);

    const late = await Client.connect();
    late.send({ t: "join", code });
    const m = await late.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("room-not-found");

    late.close();
    runner.close();
  });

  it("GET /bots로 러너 가용성을 확인할 수 있다", async () => {
    const runner = await makeRunner(2, "가용성러너");
    const addr = server.http.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/bots`);
    const body = (await res.json()) as {
      runners: { name: string; capacity: number; active: number }[];
      idle: number;
      authRequired: boolean;
    };
    expect(res.status).toBe(200);
    expect(body.authRequired).toBe(false);
    expect(body.idle).toBeGreaterThanOrEqual(1);
    expect(body.runners.some((r) => r.name === "가용성러너" && r.capacity === 2)).toBe(true);
    runner.close();
  });
});

describe("봇 토큰 인증", () => {
  let secured: RelayServer;
  let securedBase: string;

  beforeAll(async () => {
    secured = startServer(0, { botToken: "s3cret" });
    if (!secured.http.listening) {
      await new Promise<void>((res) => secured.http.once("listening", () => res()));
    }
    const addr = secured.http.address() as AddressInfo;
    securedBase = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await secured.close();
  });

  it("토큰이 틀리면 연결이 끊긴다", async () => {
    const bot = await Client.connect("/bot?token=nope", securedBase);
    const m = await bot.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("bot-auth-failed");
    expect(await bot.closed()).toBe(4401);
  });

  it("토큰이 맞으면 러너로 등록된다", async () => {
    const bot = await Client.connect("/bot?token=s3cret", securedBase);
    bot.send({ t: "bot-hello", name: "인증봇" });
    const m = await bot.next();
    expect(m.t).toBe("bot-ready");
    bot.close();
  });

  it("사람 경로는 토큰과 무관하게 열려 있다", async () => {
    const human = await Client.connect("/", securedBase);
    human.send({ t: "create" });
    const m = await human.next();
    expect(m.t).toBe("created");
    human.close();
  });
});
