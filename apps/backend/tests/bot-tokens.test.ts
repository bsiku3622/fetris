import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayServer } from "../src/server.js";
import { Client, startTestServer, createRoom, joinRoom } from "./helpers.js";

// ============================================================================
// 러너별 토큰 — 누가 올린 봇인지 구분하고, 호스트가 러너를 지목할 수 있어야 한다.
// ============================================================================

let dir: string;
let tokenFile: string;
let server: RelayServer;
let url: string;

const ALICE = "alice-token-aaaaaaaaaaaa";
const BOB = "bob-token-bbbbbbbbbbbbbb";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "fetris-tokens-"));
  tokenFile = join(dir, "bot-tokens.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      tokens: [
        { token: ALICE, owner: "앨리스", label: "메인 봇" },
        { token: BOB, owner: "밥" },
      ],
    }),
  );
  const started = await startTestServer({ botTokensPath: tokenFile });
  server = started.server;
  url = started.url;
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 토큰으로 러너를 등록하고 등록 응답을 돌려준다 */
async function makeRunner(token: string, name: string, capacity = 2) {
  const runner = await Client.connect(url, `/bot?token=${token}`);
  runner.send({ t: "bot-hello", name, capacity });
  const ready = await runner.waitFor("bot-ready");
  return { runner, info: ready.runner };
}

describe("러너별 토큰", () => {
  it("토큰이 없으면 봇 경로에 붙을 수 없다", async () => {
    const bot = await Client.connect(url, "/bot");
    const m = await bot.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("bot-auth-failed");
    expect(await bot.closed()).toBe(4401);
  });

  it("모르는 토큰도 거부된다", async () => {
    const bot = await Client.connect(url, "/bot?token=아무거나");
    const m = await bot.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("bot-auth-failed");
  });

  it("토큰에 묶인 소유자가 러너에 붙는다", async () => {
    const { runner, info } = await makeRunner(ALICE, "앨리스봇");
    expect(info.owner).toBe("앨리스");
    expect(info.label).toBe("메인 봇");
    expect(info.name).toBe("앨리스봇");
    runner.close();
  });

  it("러너는 소유자를 사칭할 수 없다", async () => {
    // bot-hello에 남의 이름을 실어 보내도 토큰의 소유자가 이긴다
    const runner = await Client.connect(url, `/bot?token=${BOB}`);
    runner.send({ t: "bot-hello", name: "밥봇", owner: "앨리스" });
    const ready = await runner.waitFor("bot-ready");
    expect(ready.runner.owner).toBe("밥");
    runner.close();
  });

  it("방에서 러너 목록을 조회할 수 있다", async () => {
    const a = await makeRunner(ALICE, "앨리스봇");
    const b = await makeRunner(BOB, "밥봇");
    const { host } = await createRoom(url);

    host.send({ t: "list-runners" });
    const list = await host.waitFor("runners");
    const owners = list.runners.map((r) => r.owner).sort();
    expect(owners).toContain("앨리스");
    expect(owners).toContain("밥");

    host.close();
    a.runner.close();
    b.runner.close();
  });

  it("호스트가 지목한 러너에게만 초대가 간다", async () => {
    const a = await makeRunner(ALICE, "앨리스봇");
    const b = await makeRunner(BOB, "밥봇");
    const { host } = await createRoom(url);

    // 밥을 콕 집어 부른다
    host.send({ t: "add-bot", runnerId: b.info.id });
    const pending = await host.waitFor("bot-pending");
    expect(pending.runnerId).toBe(b.info.id);

    const invite = await b.runner.waitFor("bot-invite");
    expect(invite.ticket).toBeTruthy();
    // 앨리스에게는 오지 않아야 한다
    await expect(a.runner.waitFor("bot-invite", 200)).rejects.toThrow();

    host.close();
    a.runner.close();
    b.runner.close();
  });

  it("착석한 봇의 소유자가 로스터에 드러난다", async () => {
    const a = await makeRunner(ALICE, "앨리스봇");
    const { host } = await createRoom(url);
    host.send({ t: "add-bot", runnerId: a.info.id });
    await host.waitFor("bot-pending");
    const invite = await a.runner.waitFor("bot-invite");

    const bot = await Client.connect(url, `/bot?token=${ALICE}`);
    bot.send({ t: "join", code: invite.code, ticket: invite.ticket });
    await bot.waitFor("joined");

    const state = await host.waitState((s) => s.players.some((p) => p.isBot));
    const botInfo = state.players.find((p) => p.isBot);
    expect(botInfo?.botOwner).toBe("앨리스");

    host.close();
    bot.close();
    a.runner.close();
  });

  it("없는 러너를 지목하면 runner-not-found", async () => {
    const { host } = await createRoom(url);
    host.send({ t: "add-bot", runnerId: "r없음" });
    const m = await host.waitFor("error");
    expect(m.reason).toBe("runner-not-found");
    host.close();
  });

  it("정원을 채운 러너를 지목하면 runner-busy", async () => {
    const a = await makeRunner(ALICE, "앨리스봇", 1);
    const { host } = await createRoom(url);
    host.send({ t: "add-bot", runnerId: a.info.id });
    await host.waitFor("bot-pending");
    await a.runner.waitFor("bot-invite"); // 1/1 점유

    host.send({ t: "add-bot", runnerId: a.info.id });
    const m = await host.waitFor("error");
    expect(m.reason).toBe("runner-busy");

    host.close();
    a.runner.close();
  });

  it("방 밖에서는 러너 목록을 볼 수 없다", async () => {
    const outsider = await Client.connect(url);
    outsider.send({ t: "list-runners" });
    await expect(outsider.waitFor("runners", 200)).rejects.toThrow();
    outsider.close();
  });

  it("호스트가 아니면 봇을 부를 수 없다", async () => {
    const a = await makeRunner(ALICE, "앨리스봇");
    const { host, code } = await createRoom(url);
    const guest = await joinRoom(url, code, "게스트");

    guest.send({ t: "add-bot", runnerId: a.info.id });
    const m = await guest.waitFor("error");
    expect(m.reason).toBe("not-host");

    host.close();
    guest.close();
    a.runner.close();
  });
});
