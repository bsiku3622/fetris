import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { RelayServer } from "../src/server.js";
import { Client, startTestServer, createRoom, joinRoom } from "./helpers.js";

let server: RelayServer;
let url: string;

beforeAll(async () => {
  const started = await startTestServer();
  server = started.server;
  url = started.url;
});

afterAll(async () => {
  await server.close();
});

/** 러너를 등록하고 준비 상태를 확인한다 */
async function makeRunner(capacity = 1, name = "테스트러너"): Promise<Client> {
  const runner = await Client.connect(url, "/bot");
  runner.send({ t: "bot-hello", name, capacity });
  const ready = await runner.next();
  expect(ready.t).toBe("bot-ready");
  return runner;
}

/** 초대를 받아 봇을 실제로 착석시킨다 */
async function seatBot(runner: Client): Promise<{ bot: Client; nick: string }> {
  const invite = await runner.waitFor("bot-invite");
  const bot = await Client.connect(url, "/bot");
  bot.send({ t: "join", code: invite.code, ticket: invite.ticket });
  const joined = await bot.next();
  expect(joined.t).toBe("joined");
  return { bot, nick: invite.nick };
}

describe("봇 엔드포인트", () => {
  it("/bot에 붙은 러너는 bot-hello로 등록된다", async () => {
    const runner = await Client.connect(url, "/bot");
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
    const human = await Client.connect(url);
    human.send({ t: "bot-hello", name: "위장봇" });
    const m = await human.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("bot-path-required");
    human.close();
  });

  it("호스트의 add-bot이 러너를 초대하고, 봇이 티켓으로 착석한다", async () => {
    const runner = await makeRunner();
    const { host, code } = await createRoom(url);

    host.send({ t: "add-bot" });
    const pending = await host.waitFor("bot-pending");
    expect(pending.nick).toBe("Bot 1");

    const invite = await runner.waitFor("bot-invite");
    expect(invite.code).toBe(code);

    const bot = await Client.connect(url, "/bot");
    bot.send({ t: "join", code: invite.code, ticket: invite.ticket });
    const joined = await bot.next();
    expect(joined.t).toBe("joined");

    // 로스터에 봇으로 표시되고, 봇은 언제나 준비 상태
    for (;;) {
      const s = await host.waitFor("state");
      const botInfo = s.state.players.find((p) => p.isBot);
      if (botInfo) {
        expect(botInfo.nick).toBe("Bot 1");
        expect(botInfo.ready).toBe(true);
        expect(botInfo.role).toBe("player");
        break;
      }
    }

    host.close();
    bot.close();
    runner.close();
  });

  it("봇도 일반 참가자로 게임 메시지를 주고받는다", async () => {
    const runner = await makeRunner();
    const { host } = await createRoom(url);
    host.send({ t: "add-bot", nick: "스파링" });
    await host.waitFor("bot-pending");
    const { bot } = await seatBot(runner);
    bot.drain();

    host.send({ t: "relay", msg: { t: "attack", holes: [3] } });
    const got = await bot.waitFor("relay");
    expect(got.msg).toEqual({ t: "attack", holes: [3] });

    bot.send({ t: "relay-to", targetId: got.from, msg: { t: "attack", holes: [7] } });
    const back = await host.waitFor("relay");
    expect(back.msg).toEqual({ t: "attack", holes: [7] });

    host.close();
    bot.close();
    runner.close();
  });

  it("대기 중인 러너가 없으면 no-bot-available", async () => {
    const { host } = await createRoom(url);
    host.send({ t: "add-bot" });
    const m = await host.waitFor("error");
    expect(m.reason).toBe("no-bot-available");
    host.close();
  });

  it("호스트가 아니면 add-bot이 거부된다", async () => {
    const runner = await makeRunner();
    const { host, code } = await createRoom(url);
    const guest = await joinRoom(url, code, "게스트");

    guest.send({ t: "add-bot" });
    const m = await guest.waitFor("error");
    expect(m.reason).toBe("not-host");

    host.close();
    guest.close();
    runner.close();
  });

  it("잘못된 티켓은 입장할 수 없다", async () => {
    const bot = await Client.connect(url, "/bot");
    bot.send({ t: "join", code: "ZZZZ", ticket: "없는-티켓" });
    const m = await bot.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("invalid-ticket");
    bot.close();
  });

  it("사람 경로에서는 티켓을 쓸 수 없다", async () => {
    const human = await Client.connect(url);
    human.send({ t: "join", code: "ZZZZ", ticket: "아무거나" });
    const m = await human.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("bot-path-required");
    human.close();
  });

  it("예약된 봇 슬롯이 정원을 차지한다", async () => {
    const runner = await makeRunner();
    const { host, code } = await createRoom(url, 2);
    host.send({ t: "add-bot" });
    await host.waitFor("bot-pending"); // 아직 착석 전이지만 슬롯은 예약됨
    await runner.waitFor("bot-invite");

    // 호스트 1 + 예약 1 = 정원 2가 찼으므로 이후 입장자는 관전자가 된다
    const late = await joinRoom(url, code, "지각생");
    const s = await host.waitState((st) => st.players.some((p) => p.nick === "지각생"));
    expect(s.players.find((p) => p.nick === "지각생")?.role).toBe("spectator");

    host.close();
    late.close();
    runner.close();
  });

  it("정원이 찬 방에는 봇을 추가할 수 없다", async () => {
    const runner = await makeRunner();
    const { host, code } = await createRoom(url, 2);
    const guest = await joinRoom(url, code, "게스트");

    host.send({ t: "add-bot" });
    const m = await host.waitFor("error");
    expect(m.reason).toBe("room-full");

    host.close();
    guest.close();
    runner.close();
  });

  it("러너 정원(capacity)을 넘으면 더 부를 수 없다", async () => {
    const runner = await makeRunner(1, "정원1러너");
    const { host } = await createRoom(url);
    host.send({ t: "add-bot" });
    await host.waitFor("bot-pending");
    await runner.waitFor("bot-invite"); // 러너 점유 1/1

    host.send({ t: "add-bot" });
    const m = await host.waitFor("error");
    expect(m.reason).toBe("no-bot-available");

    host.close();
    runner.close();
  });

  it("호스트는 kick-bot으로 봇을 내보낼 수 있다", async () => {
    const runner = await makeRunner();
    const { host } = await createRoom(url);
    host.send({ t: "add-bot" });
    await host.waitFor("bot-pending");
    const { bot } = await seatBot(runner);

    let botId = "";
    for (;;) {
      const s = await host.waitFor("state");
      const found = s.state.players.find((p) => p.isBot);
      if (found) {
        botId = found.id;
        break;
      }
    }

    host.send({ t: "kick-bot", playerId: botId });
    expect(await bot.closed()).toBe(1000);
    for (;;) {
      const s = await host.waitFor("state");
      if (!s.state.players.some((p) => p.isBot)) break;
    }

    host.close();
    runner.close();
  });

  it("봇이 아닌 플레이어는 kick-bot 대상이 아니다", async () => {
    const { host, code } = await createRoom(url);
    const guest = await joinRoom(url, code, "사람");
    let guestId = "";
    for (;;) {
      const s = await host.waitFor("state");
      const found = s.state.players.find((p) => p.nick === "사람");
      if (found) {
        guestId = found.id;
        break;
      }
    }

    host.send({ t: "kick-bot", playerId: guestId });
    const m = await host.waitFor("error");
    expect(m.reason).toBe("not-a-bot");

    host.close();
    guest.close();
  });

  it("사람이 모두 나가면 봇만 남은 방은 정리된다", async () => {
    const runner = await makeRunner();
    const { host, code } = await createRoom(url);
    host.send({ t: "add-bot" });
    await host.waitFor("bot-pending");
    const { bot } = await seatBot(runner);

    host.close();
    expect(await bot.closed()).toBe(1000);

    const late = await Client.connect(url);
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
  let securedUrl: string;

  beforeAll(async () => {
    const started = await startTestServer({ botToken: "s3cret" });
    secured = started.server;
    securedUrl = started.url;
  });

  afterAll(async () => {
    await secured.close();
  });

  it("토큰이 틀리면 연결이 끊긴다", async () => {
    const bot = await Client.connect(securedUrl, "/bot?token=nope");
    const m = await bot.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("bot-auth-failed");
    expect(await bot.closed()).toBe(4401);
  });

  it("토큰이 맞으면 러너로 등록된다", async () => {
    const bot = await Client.connect(securedUrl, "/bot?token=s3cret");
    bot.send({ t: "bot-hello", name: "인증봇" });
    const m = await bot.next();
    expect(m.t).toBe("bot-ready");
    bot.close();
  });

  it("사람 경로는 토큰과 무관하게 열려 있다", async () => {
    const human = await Client.connect(securedUrl, "/");
    human.send({ t: "create" });
    const m = await human.next();
    expect(m.t).toBe("created");
    human.close();
  });
});
