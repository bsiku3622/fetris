import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runReplay, fingerprint } from "@fetris/engine/replay";
import type { RelayServer } from "../src/server.js";
import { Client, startTestServer, createRoom, joinRoom, playerIn, TEST_CONFIG } from "./helpers.js";

// 결과 표시를 짧게 줄여 실제 전이를 기다릴 수 있게 한다
const RESULTS = 120;

let server: RelayServer;
let url: string;

beforeAll(async () => {
  const started = await startTestServer({ resultsMs: RESULTS });
  server = started.server;
  url = started.url;
});

afterAll(async () => {
  await server.close();
});

/** 호스트 + 게스트들로 방을 꾸려 바로 시작할 수 있는 상태로 만든다 */
async function readyRoom(guestCount: number, maxPlayers = 8) {
  const { host, code } = await createRoom(url, maxPlayers);
  host.send({ t: "config", config: TEST_CONFIG });
  const guests: Client[] = [];
  for (let i = 0; i < guestCount; i++) {
    guests.push(await joinRoom(url, code, `G${i + 1}`));
  }
  await host.waitState((s) => s.players.filter((p) => p.role === "player").length === guestCount + 1);
  host.drain();
  for (const g of guests) g.drain();
  return { host, guests, code };
}

/** 매치를 시작하고 각자의 match-start를 받아낸다 */
async function startMatch(host: Client, guests: Client[]) {
  host.send({ t: "start-match" });
  const started = await host.waitFor("match-start");
  for (const g of guests) await g.waitFor("match-start");
  return started;
}

describe("매치 진행", () => {
  it("설정 없이는 시작할 수 없다", async () => {
    const { host, code } = await createRoom(url);
    const guest = await joinRoom(url, code, "G");
    await host.waitState((s) => s.players.length === 2);

    host.send({ t: "start-match" });
    const err = await host.waitFor("error");
    expect(err.reason).toBe("no-config");
    host.close();
    guest.close();
  });

  it("혼자서는 시작할 수 없다", async () => {
    const { host } = await createRoom(url);
    host.send({ t: "config", config: TEST_CONFIG });
    await host.waitFor("state");
    host.send({ t: "start-match" });
    const err = await host.waitFor("error");
    expect(err.reason).toBe("not-enough-players");
    host.close();
  });

  it("호스트가 아니면 시작할 수 없다", async () => {
    const { host, guests } = await readyRoom(1);
    guests[0].send({ t: "start-match" });
    const err = await guests[0].waitFor("error");
    expect(err.reason).toBe("not-host");
    host.close();
    guests[0].close();
  });

  it("호스트가 시작하면 곧바로 매치가 열린다", async () => {
    const { host, guests } = await readyRoom(1);
    host.send({ t: "start-match" });

    // 서버는 카운트다운을 세지 않는다 — 엔진이 판을 열며 Ready를 돌린다
    const start = await host.waitFor("match-start");
    expect(start.players).toHaveLength(2);
    expect(start.config).toEqual(TEST_CONFIG);
    expect(typeof start.seed).toBe("number");

    // 게스트도 같은 시드를 받는다
    const guestStart = await guests[0].waitFor("match-start");
    expect(guestStart.seed).toBe(start.seed);
    expect(guestStart.matchId).toBe(start.matchId);

    host.close();
    guests[0].close();
  });

  it("라스트맨 스탠딩 — 탈락 역순으로 순위가 매겨진다", async () => {
    const { host, guests } = await readyRoom(2); // 총 3명
    await startMatch(host, guests);

    // 첫 탈락 → 3등
    guests[0].send({ t: "ko" });
    const ko1 = await host.waitFor("ko");
    expect(ko1.placement).toBe(3);
    expect(ko1.remaining).toBe(2);

    // 두 번째 탈락 → 2등, 남은 호스트가 우승
    guests[1].send({ t: "ko" });
    const ko2 = await host.waitFor("ko");
    expect(ko2.placement).toBe(2);
    expect(ko2.remaining).toBe(1);

    const end = await host.waitFor("match-end");
    expect(end.standings.map((s) => s.placement)).toEqual([1, 2, 3]);
    expect(end.winnerId).toBe(end.standings[0].playerId);

    host.close();
    guests[0].close();
    guests[1].close();
  });

  it("우승하면 승수가 쌓이고, 결과 후 대기실로 돌아간다", async () => {
    const { host, guests } = await readyRoom(1);
    const start = await startMatch(host, guests);
    const winnerId = start.players.find((id) => id !== undefined);
    expect(winnerId).toBeDefined();

    guests[0].send({ t: "ko" });
    const end = await host.waitFor("match-end");
    expect(end.winnerId).not.toBeNull();

    // results → lobby 자동 복귀
    for (;;) {
      const s = await host.waitFor("state", 3000);
      if (s.state.phase === "lobby") {
        const champ = playerIn(s.state, end.winnerId as string);
        expect(champ?.wins).toBe(1);
        break;
      }
    }

    host.close();
    guests[0].close();
  });

  it("매치 중 입장하면 관전자가 된다", async () => {
    const { host, guests, code } = await readyRoom(1);
    await startMatch(host, guests);

    const late = await joinRoom(url, code, "지각생");
    const joined = await host.waitState((s) => s.players.some((p) => p.nick === "지각생"));
    const lateInfo = joined.players.find((p) => p.nick === "지각생");
    expect(lateInfo?.role).toBe("spectator");

    host.close();
    guests[0].close();
    late.close();
  });

  it("매치 중 이탈은 탈락으로 처리된다", async () => {
    const { host, guests } = await readyRoom(2); // 3명
    await startMatch(host, guests);

    guests[0].close();
    const ko = await host.waitFor("ko");
    expect(ko.remaining).toBe(2);

    // 남은 한 명이 죽으면 호스트 우승
    guests[1].send({ t: "ko" });
    const end = await host.waitFor("match-end");
    expect(end.winnerId).not.toBeNull();

    host.close();
    guests[1].close();
  });

  it("호스트가 설정을 바꾸면 방 전체에 반영된다", async () => {
    const { host, guests } = await readyRoom(1);
    host.send({ t: "config", config: { ...TEST_CONFIG, attackMul: 2 } });
    const s = await guests[0].waitState((st) => (st.config as typeof TEST_CONFIG | null)?.attackMul === 2);
    expect((s.config as typeof TEST_CONFIG).attackMul).toBe(2);
    host.close();
    guests[0].close();
  });

  it("결과 대기시간을 건너뛰고 곧바로 대기실로 갈 수 있다", async () => {
    const { host, guests } = await readyRoom(1);
    await startMatch(host, guests);

    guests[0].send({ t: "ko" });
    await host.waitFor("match-end");

    // 타이머(120ms)를 기다리지 않고 즉시 넘긴다
    const before = Date.now();
    host.send({ t: "skip-results" });
    const s = await host.waitState((st) => st.phase === "lobby");
    expect(s.phase).toBe("lobby");
    expect(Date.now() - before).toBeLessThan(RESULTS);

    host.close();
    guests[0].close();
  });

  it("시리즈 도중에는 다음 판이 자동으로 이어진다", async () => {
    const { host, code } = await createRoom(url);
    // 2선승
    host.send({ t: "config", config: { ...TEST_CONFIG, firstTo: 2 } });
    const guest = await joinRoom(url, code, "G1");
    await host.waitState((s) => s.players.length === 2);
    host.drain();
    guest.drain();

    // 1승째 — 아직 시리즈는 안 끝난다
    host.send({ t: "start-match" });
    await host.waitFor("match-start");
    await guest.waitFor("match-start");
    guest.send({ t: "ko" });
    const first = await host.waitFor("match-end");
    expect(first.seriesWinnerId).toBeUndefined();
    // 목표에 못 미쳤으니 서버가 다음 판을 이어 연다고 알린다
    expect(first.nextRound).toBe(true);

    const champ = first.winnerId as string;

    // 아무도 다시 시작을 누르지 않아도 2판째가 열린다
    const second = await host.waitFor("match-start", 3000);
    await guest.waitFor("match-start");
    expect(second.matchId).toBe(first.matchId + 1);
    const playing = await host.waitState((s) => s.phase === "playing");
    expect(playerIn(playing, champ)?.wins).toBe(1);

    // 2승째 — 시리즈 종료
    guest.send({ t: "ko" });
    const end = await host.waitFor("match-end");
    expect(end.seriesWinnerId).toBe(champ);
    expect(end.nextRound).toBe(false);

    // 결과 화면에는 아직 최종 전적이 남아 있어야 한다(2/2로 이겼다는 표시)
    const onResults = await host.waitState((s) => s.phase === "results");
    expect(playerIn(onResults, champ)?.wins).toBe(2);

    // 시리즈가 끝나면 대기실로 돌아가고, 다음 시리즈를 위해 승수가 0이 된다
    const afterSeries = await host.waitState((s) => s.phase === "lobby");
    expect(afterSeries.players.every((p) => p.wins === 0)).toBe(true);

    host.close();
    guest.close();
  });

  it("호스트는 시리즈를 중간에 접을 수 있다", async () => {
    const { host, code } = await createRoom(url);
    host.send({ t: "config", config: { ...TEST_CONFIG, firstTo: 3 } });
    const guest = await joinRoom(url, code, "G1");
    await host.waitState((s) => s.players.length === 2);
    host.drain();
    guest.drain();

    host.send({ t: "start-match" });
    await host.waitFor("match-start");
    await guest.waitFor("match-start");
    guest.send({ t: "ko" });
    const first = await host.waitFor("match-end");
    expect(first.nextRound).toBe(true);

    // 다음 판이 열리기 전에 접는다 — 승수까지 지우고 대기실로
    host.send({ t: "abort-series" });
    const s = await host.waitState((st) => st.phase === "lobby");
    expect(s.players.every((p) => p.wins === 0)).toBe(true);
    // 접었으니 자동으로 다음 판이 열리지 않는다
    await expect(host.waitFor("match-start", 400)).rejects.toThrow();

    host.close();
    guest.close();
  });

  it("게스트는 시리즈를 접을 수 없다", async () => {
    const { host, guests } = await readyRoom(1);
    guests[0].send({ t: "abort-series" });
    const err = await guests[0].waitFor("error");
    expect(err.reason).toBe("not-host");
    host.close();
    guests[0].close();
  });

  it("FT가 0이면 시리즈 종료 없이 계속 쌓인다", async () => {
    const { host, guests } = await readyRoom(1); // TEST_CONFIG.firstTo = 0
    await startMatch(host, guests);
    guests[0].send({ t: "ko" });
    const end = await host.waitFor("match-end");
    expect(end.seriesWinnerId).toBeUndefined();

    const s = await host.waitState((st) => st.phase === "lobby");
    expect(playerIn(s, end.winnerId as string)?.wins).toBe(1);

    host.close();
    guests[0].close();
  });

  it("결과 화면이 아니면 스킵은 무시된다", async () => {
    const { host, guests } = await readyRoom(1);
    host.send({ t: "skip-results" }); // lobby에서 보냄
    await expect(host.waitFor("error", 200)).rejects.toThrow();
    host.close();
    guests[0].close();
  });

  it("관전자로 전환하면 매치 참가자에서 빠진다", async () => {
    const { host, guests } = await readyRoom(2); // 3명
    guests[0].send({ t: "set-role", role: "spectator" });
    await host.waitFor("state");

    // 남은 참가자 2명(호스트 + guests[1])만 매치에 들어간다
    host.send({ t: "start-match" });
    const start = await host.waitFor("match-start");
    expect(start.players).toHaveLength(2);

    host.close();
    guests[0].close();
    guests[1].close();
  });

  it("조작된 리플레이는 서버가 잡아낸다", async () => {
    const { host, guests } = await readyRoom(1);
    const start = await startMatch(host, guests);

    // 입력이 하나도 없는데 "이런 결과가 나왔다"고 주장한다
    host.send({
      t: "replay",
      matchId: start.matchId,
      frames: 120,
      keys: [],
      fingerprint: "deadbeef",
    });
    const err = await host.waitFor("error");
    expect(err.reason).toBe("replay-mismatch");

    host.close();
    guests[0].close();
  });

  it("정직한 리플레이는 조용히 통과한다", async () => {
    const { host, guests } = await readyRoom(1);
    const start = await startMatch(host, guests);

    // 서버가 재현할 것과 똑같이 우리도 재현해 지문을 만든다
    const frames = 120;
    const game = runReplay({
      rule: TEST_CONFIG.rule as never,
      handling: TEST_CONFIG.handling as never,
      seed: start.seed,
      keys: [],
      frames,
      simRate: TEST_CONFIG.simRate,
    });
    host.send({
      t: "replay",
      matchId: start.matchId,
      frames,
      keys: [],
      fingerprint: fingerprint(game),
    });

    // 검증을 통과하면 아무 응답도 오지 않는다
    await expect(host.waitFor("error", 400)).rejects.toThrow();

    host.close();
    guests[0].close();
  });

  it("제출한 리플레이가 방 전체에 배포된다", async () => {
    // 관전자는 자기 로그가 없다. 참가자가 검증용으로 낸 제출을 서버가 그대로
    // 흘려줘야만 그 경기를 내려받을 수 있다 — 특히 따로 공유하지 않는 봇의 판.
    const { host, code, state } = await createRoom(url);
    const hostId = state.players[0].id;
    host.send({ t: "config", config: TEST_CONFIG });
    const guest = await joinRoom(url, code, "G1");
    const watcher = await joinRoom(url, code, "관전자");
    watcher.send({ t: "set-role", role: "spectator" });
    await host.waitState((st) => st.players.filter((p) => p.role === "player").length === 2);
    host.drain();
    guest.drain();
    watcher.drain();

    host.send({ t: "start-match" });
    const start = await host.waitFor("match-start");
    await guest.waitFor("match-start");
    // 참가자 두 명 중 호스트가 아닌 쪽이 게스트다
    const guestId = start.players.find((id) => id !== hostId) as string;

    const keys = [0, 7, 1, 30, 7, 1];
    const garbage = [10, 2, 3, 3];
    guest.send({
      t: "replay",
      matchId: start.matchId,
      seed: 4242,
      frames: 90,
      keys,
      garbage,
      fingerprint: "abcd1234",
    });

    // 관전자와 다른 참가자 모두 그 기록을 받는다
    for (const c of [watcher, host]) {
      const rec = await c.waitFor("replay-record");
      expect(rec.matchId).toBe(start.matchId);
      expect(rec.playerId).toBe(guestId);
      expect(rec.seed).toBe(4242);
      expect(rec.frames).toBe(90);
      expect(rec.keys).toEqual(keys);
      expect(rec.garbage).toEqual(garbage);
      expect(rec.fingerprint).toBe("abcd1234");
    }

    host.close();
    guest.close();
    watcher.close();
  });

  it("lobby가 아니면 봇을 추가할 수 없다", async () => {
    const { host, guests } = await readyRoom(1);
    await startMatch(host, guests);
    host.send({ t: "add-bot" });
    const err = await host.waitFor("error");
    expect(err.reason).toBe("not-in-lobby");
    host.close();
    guests[0].close();
  });
});
