import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runReplay, fingerprint } from "@fetris/engine/replay";
import type { RelayServer } from "../src/server.js";
import { Client, startTestServer, createRoom, joinRoom, playerIn, TEST_CONFIG } from "./helpers.js";
import { shapeOf } from "@fetris/engine/pieces";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "@fetris/engine/config";

// 결과 표시를 짧게 줄여 실제 전이를 기다릴 수 있게 한다
const RESULTS = 120;
// 끊긴 자리를 잡아두는 유예도 짧게
const GRACE = 250;

let server: RelayServer;
let url: string;

beforeAll(async () => {
  const started = await startTestServer({ resultsMs: RESULTS, graceMs: GRACE });
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

  it("매치 중 끊기면 잠깐 자리를 잡아뒀다가, 안 돌아오면 탈락시킨다", async () => {
    const { host, guests } = await readyRoom(2); // 3명
    await startMatch(host, guests);

    guests[0].close();
    // 곧바로 탈락시키지 않는다 — 순단 한 번에 판에서 밀려나면 안 되기 때문
    const held = await host.waitState((s) => s.players.some((p) => !p.connected));
    expect(held.players.filter((p) => p.role === "player")).toHaveLength(3);

    // 유예가 지나면 그때 탈락
    const ko = await host.waitFor("ko", 2000);
    expect(ko.remaining).toBe(2);

    // 남은 한 명이 죽으면 호스트 우승
    guests[1].send({ t: "ko" });
    const end = await host.waitFor("match-end");
    expect(end.winnerId).not.toBeNull();

    host.close();
    guests[1].close();
  });

  it("유예 안에 돌아오면 같은 자리로 복귀한다", async () => {
    const { host, code } = await createRoom(url);
    host.send({ t: "config", config: TEST_CONFIG });
    const guest = await joinRoom(url, code, "G1");
    await host.waitState((s) => s.players.length === 2);
    const token = guest.session as string;
    expect(token).toBeTruthy();
    host.drain();

    host.send({ t: "start-match" });
    const start = await host.waitFor("match-start");
    await guest.waitFor("match-start");
    const guestId = start.players.find((id) => id !== start.players[0]) as string;

    // 순단 — 소켓만 끊는다
    const lastSeen = guest.lastSeenId;
    guest.close();
    await host.waitState((s) => s.players.some((p) => !p.connected));

    // 같은 자리로 복귀
    const back = await Client.connect(url);
    back.send({ t: "resume", token, lastSeenId: lastSeen });
    const resumed = await back.waitFor("resumed");
    expect(resumed.myId).toBe(guestId);
    expect(resumed.code).toBe(code);

    // 자리가 유지됐고 다시 연결됨으로 표시된다
    const st = await host.waitState((s) => s.players.every((p) => p.connected));
    expect(st.players.filter((p) => p.role === "player")).toHaveLength(2);

    // 탈락시키는 ko는 오지 않는다
    await expect(host.waitFor("ko", 600)).rejects.toThrow();

    host.close();
    back.close();
  });

  it("자리가 이미 정리됐으면 복귀에 실패한다", async () => {
    const { host, code } = await createRoom(url);
    const guest = await joinRoom(url, code, "G1");
    await host.waitState((s) => s.players.length === 2);
    const token = guest.session as string;

    // 대기실에서 끊기면 자리를 잡아두지 않는다
    guest.close();
    await host.waitState((s) => s.players.length === 1);

    const back = await Client.connect(url);
    back.send({ t: "resume", token, lastSeenId: 0 });
    const err = await back.waitFor("error");
    expect(err.reason).toBe("resume-failed");

    host.close();
    back.close();
  });

  it("복귀하면 끊긴 사이에 놓친 메시지를 다시 받는다", async () => {
    const { host, code } = await createRoom(url);
    host.send({ t: "config", config: TEST_CONFIG });
    const guest = await joinRoom(url, code, "G1");
    const extra = await joinRoom(url, code, "G2");
    await host.waitState((s) => s.players.length === 3);
    const token = guest.session as string;
    host.drain();

    host.send({ t: "start-match" });
    await host.waitFor("match-start");
    const lastSeen = guest.lastSeenId;
    guest.close();
    await host.waitState((s) => s.players.some((p) => !p.connected));

    // 끊긴 사이에 사건이 하나 벌어진다
    extra.send({ t: "ko" });
    await host.waitFor("ko");

    // 복귀하면 그 사이 것도 번호순으로 되받는다
    const back = await Client.connect(url);
    back.send({ t: "resume", token, lastSeenId: lastSeen });
    await back.waitFor("resumed");
    const missedKo = await back.waitFor("ko", 1000);
    expect(missedKo.playerId).toBeTruthy();

    host.close();
    extra.close();
    back.close();
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
    // 관전자가 실제로 자리를 옮긴 뒤에 진행한다. 참가자 수만 보면 게스트가
    // 막 들어온 시점(관전자 입장 전)에도 2명이라 그냥 통과해버린다.
    await host.waitState(
      (st) => st.players.length === 3 && st.players.filter((p) => p.role === "player").length === 2,
    );
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
      // 제출자가 시드를 고쳐 불러도 서버가 배정한 값이 쓰인다
      seed: 4242,
      frames: 90,
      keys,
      garbage,
      fingerprint: "abcd1234",
    });

    const assignedSeed = start.sim.find((s) => s.id === guestId)?.seed;

    // 관전자와 다른 참가자 모두 그 기록을 받는다
    for (const c of [watcher, host]) {
      const rec = await c.waitFor("replay-record");
      expect(rec.matchId).toBe(start.matchId);
      expect(rec.playerId).toBe(guestId);
      expect(rec.seed).toBe(assignedSeed);
      expect(rec.frames).toBe(90);
      expect(rec.keys).toEqual(keys);
      expect(rec.garbage).toEqual(garbage);
      expect(rec.fingerprint).toBe("abcd1234");
    }

    host.close();
    guest.close();
    watcher.close();
  });

  it("중계하는 김에 입력을 받아 적어, 제출이 없어도 판을 되살릴 수 있다", async () => {
    // 리플레이를 지원하지 않는 봇이 정확히 이 경우다. 예전에는 그런 참가자의
    // 판이 성긴 스냅샷으로만 남아 조각이 뚝뚝 끊겼다.
    const { host, code, state } = await createRoom(url);
    const hostId = state.players[0].id;
    host.send({ t: "config", config: TEST_CONFIG });
    const guest = await joinRoom(url, code, "G1");
    await host.waitState((st) => st.players.length === 2);
    host.drain();
    guest.drain();

    host.send({ t: "start-match" });
    const start = await host.waitFor("match-start");
    await guest.waitFor("match-start");
    const guestId = start.players.find((id) => id !== hostId) as string;

    // 클라이언트가 하는 것과 같은 모양으로 입력을 흘려보낸다
    host.send({ t: "relay", msg: { t: "sync", upto: 4, keys: [1, 7, 1] } });
    host.send({ t: "relay", msg: { t: "sync", upto: 8, keys: [5, 0, 1, 7, 0, 0] } });
    host.send({ t: "relay", msg: { t: "sync", upto: 12, ige: [9, 2, 3, 3] } });
    // 왕복을 돌려 서버가 위 메시지를 다 처리했음을 보장한다
    host.send({ t: "list-runners" });
    await host.waitFor("runners");

    guest.send({ t: "ko" });
    await host.waitFor("match-end");

    host.send({ t: "get-recording" });
    const rec = await host.waitFor("recording");
    const mine = rec.players.find((p) => p.id === hostId);
    expect(mine?.frames).toBe(12);
    expect(mine?.keys).toEqual([1, 7, 1, 5, 0, 1, 7, 0, 0]);
    expect(mine?.garbage).toEqual([9, 2, 3, 3]);
    // 되살리려면 시드와 감도도 함께 있어야 한다
    expect(mine?.seed).toBe(start.sim.find((s) => s.id === hostId)?.seed);
    expect(mine?.handling).toEqual(TEST_CONFIG.handling);

    // 아무것도 흘리지 않은 참가자는 로그 없이 이름만 남는다
    const theirs = rec.players.find((p) => p.id === guestId);
    expect(theirs?.keys).toBeUndefined();

    host.close();
    guest.close();
  });

  it("지난 판의 게임 메시지는 중계하지 않는다", async () => {
    // 판이 바뀌는 찰나에 아직 match-start를 못 본 참가자가 지난 판 입력을
    // 흘린다. 그게 상대의 새 미러에 들어가면 몇 천 프레임을 앞질러 돌며
    // 보드가 통째로 어긋난다.
    const { host, guests } = await readyRoom(1);
    const start = await startMatch(host, guests);
    host.drain();

    // 지난 판 번호를 달고 오면 버린다
    guests[0].send({ t: "relay", mid: start.matchId - 1, msg: { t: "sync", upto: 9999, keys: [1] } });
    // 이번 판 번호는 통과한다
    guests[0].send({ t: "relay", mid: start.matchId, msg: { t: "sync", upto: 8, keys: [2] } });

    const relayed = await host.waitFor("relay");
    expect(relayed.msg).toEqual({ t: "sync", upto: 8, keys: [2] });
    // 버려진 게 뒤늦게 따라오지 않는다
    await expect(host.waitFor("relay", 400)).rejects.toThrow();

    // 번호를 안 붙인 메시지(채팅·옛 봇)는 그대로 통과한다
    guests[0].send({ t: "relay", msg: { t: "chat", nick: "G1", text: "hi" } });
    const chat = await host.waitFor("relay");
    expect(chat.msg.t).toBe("chat");

    host.close();
    guests[0].close();
  });

  it("지난 판의 공격은 상대에게 닿지 않는다", async () => {
    const { host, guests } = await readyRoom(1);
    const start = await startMatch(host, guests);
    const hostId = start.players.find((id) => id !== undefined) as string;
    host.drain();

    guests[0].send({
      t: "relay-to",
      targetId: hostId,
      mid: start.matchId - 1,
      msg: { t: "attack", holes: [1, 2, 3] },
    });
    await expect(host.waitFor("relay", 400)).rejects.toThrow();

    host.close();
    guests[0].close();
  });

  it("중간에 나간 참가자도 녹화에 남는다", async () => {
    // 명단을 끝나고 다시 훑으면 나간 사람이 통째로 빠진다 — 그 사람 판도
    // 분명히 있었는데 기록에는 없는 셈이 된다.
    const { host, guests } = await readyRoom(2); // 3명
    const start = await startMatch(host, guests);
    const leaverId = start.players[2];

    guests[1].send({ t: "relay", msg: { t: "sync", upto: 6, keys: [2, 7, 1] } });
    guests[1].send({ t: "list-runners" });
    await guests[1].waitFor("runners");
    guests[1].send({ t: "leave" });
    await host.waitState((s) => s.players.length === 2);

    guests[0].send({ t: "ko" });
    await host.waitFor("match-end");

    host.send({ t: "get-recording" });
    const rec = await host.waitFor("recording");
    expect(rec.players.map((p) => p.id).sort()).toEqual(start.players.slice().sort());
    const gone = rec.players.find((p) => p.id === leaverId);
    expect(gone?.keys).toEqual([2, 7, 1]);
    expect(gone?.frames).toBe(6);

    host.close();
    guests[0].close();
  });

  it("참가자별 시드와 감도를 매치 시작에 함께 실어 보낸다", async () => {
    // 서로의 보드를 입력만으로 따라 돌리려면 둘 다 있어야 한다 —
    // 시드가 조각 순서를, 감도가 키의 해석을 정한다.
    const { host, code, state } = await createRoom(url);
    const hostId = state.players[0].id;
    host.send({ t: "config", config: TEST_CONFIG });
    // 게스트만 감도를 다르게 쓴다. 앉을 때 함께 보내므로 호스트가 곧바로
    // 시작을 눌러도 그 사이에 끼어 방 기본값으로 열리지 않는다.
    const guest = await joinRoom(url, code, "G1", { ...DEFAULT_HANDLING, das: 3, arr: 0 });
    await host.waitState((st) => st.players.length === 2);
    host.drain();

    host.send({ t: "start-match" });
    const start = await host.waitFor("match-start");
    const guestId = start.players.find((id) => id !== hostId) as string;

    expect(start.sim.map((s) => s.id).sort()).toEqual([hostId, guestId].sort());
    const mine = start.sim.find((s) => s.id === hostId);
    const theirs = start.sim.find((s) => s.id === guestId);
    // 조각 순서를 공유하는 방이므로 시드는 같다
    expect(mine?.seed).toBe(start.seed);
    expect(theirs?.seed).toBe(start.seed);
    // 감도는 각자의 것이다 — 알리지 않은 사람은 방 설정을 쓴다
    expect((theirs?.handling as { das: number }).das).toBe(3);
    expect((mine?.handling as { das: number }).das).toBe(DEFAULT_HANDLING.das);

    host.close();
    guest.close();
  });

  it("조각 순서를 공유하지 않으면 시드를 사람마다 다르게 나눠준다", async () => {
    // 예전에는 각자가 자기 시드를 뽑았다. 그러면 서버에 재현할 근거가 없어
    // 검증이 통째로 꺼졌고, 남들도 그 사람 보드를 따라 돌릴 수 없었다.
    const { host, code, state } = await createRoom(url);
    const hostId = state.players[0].id;
    host.send({ t: "config", config: { ...TEST_CONFIG, sharePieces: false } });
    const guest = await joinRoom(url, code, "G1");
    await host.waitState((st) => st.players.length === 2);
    host.drain();

    host.send({ t: "start-match" });
    const start = await host.waitFor("match-start");
    const guestId = start.players.find((id) => id !== hostId) as string;
    const mine = start.sim.find((s) => s.id === hostId)?.seed;
    const theirs = start.sim.find((s) => s.id === guestId)?.seed;
    expect(mine).not.toBe(theirs);

    host.close();
    guest.close();
  });

  it("서버가 판을 직접 녹화해 누구에게나 내준다", async () => {
    // 참가자가 아무것도 제출하지 않아도 판이 남아야 한다 — 리플레이를 지원하지
    // 않는 봇만 뛰는 방이 정확히 이 경우다.
    const { host, code, state } = await createRoom(url);
    const hostId = state.players[0].id;
    host.send({ t: "config", config: TEST_CONFIG });
    const guest = await joinRoom(url, code, "G1");
    const watcher = await joinRoom(url, code, "관전자");
    watcher.send({ t: "set-role", role: "spectator" });
    // 관전자가 실제로 자리를 옮긴 뒤에 진행한다. 참가자 수만 보면 게스트가
    // 막 들어온 시점(관전자 입장 전)에도 2명이라 그냥 통과해버린다.
    await host.waitState(
      (st) => st.players.length === 3 && st.players.filter((p) => p.role === "player").length === 2,
    );
    host.drain();
    guest.drain();
    watcher.drain();

    host.send({ t: "start-match" });
    const start = await host.waitFor("match-start");
    await guest.waitFor("match-start");
    const guestId = start.players.find((id) => id !== hostId) as string;

    // 대전 중 보드가 오가는 상황을 흉내낸다(서버는 내용을 해석하지 않는다)
    for (let i = 0; i < 5; i++) {
      host.send({ t: "relay", msg: { t: "board", snap: { grid: [0, 0, 1], tick: i } } });
      guest.send({ t: "relay", msg: { t: "board", snap: { grid: [2, 0, 0], tick: i } } });
    }
    // 소켓마다 왕복을 한 번 돌려 서버가 위 보드들을 다 처리했음을 보장한다.
    // 그냥 기다리면 KO가 먼저 처리돼 뒤쪽 보드가 녹화에서 빠질 수 있다.
    host.send({ t: "list-runners" });
    await host.waitFor("runners");
    guest.send({ t: "list-runners" });
    await guest.waitFor("runners");

    guest.send({ t: "ko" });
    await host.waitFor("match-end");

    // 뛰지 않은 관전자도 판 전체를 받아 갈 수 있다
    watcher.send({ t: "get-recording" });
    const rec = await watcher.waitFor("recording");
    expect(rec.matchId).toBe(start.matchId);
    expect(rec.code).toBe(code);
    expect(rec.truncated).toBe(false);
    expect(rec.players.map((p) => p.id).sort()).toEqual([hostId, guestId].sort());
    expect(rec.frames.length).toBe(10);
    // 누구 보드인지 붙어 있고, 시간축은 단조 증가한다
    expect(new Set(rec.frames.map((f) => f.id))).toEqual(new Set([hostId, guestId]));
    for (let i = 1; i < rec.frames.length; i++) {
      expect(rec.frames[i].ms).toBeGreaterThanOrEqual(rec.frames[i - 1].ms);
    }

    host.close();
    guest.close();
    watcher.close();
  });

  it("녹화가 없으면 그렇다고 알려준다", async () => {
    const { host, guests } = await readyRoom(1);
    host.send({ t: "get-recording" });
    const err = await host.waitFor("error");
    expect(err.reason).toBe("no-recording");
    host.close();
    guests[0].close();
  });

  it("계획 고스트는 서버가 들고 있다가 방에 뿌린다", async () => {
    const { host, code, state } = await createRoom(url);
    const hostId = state.players[0].id;
    host.send({ t: "config", config: TEST_CONFIG });
    const guest = await joinRoom(url, code, "G1");
    await host.waitState((st) => st.players.length === 2);
    host.drain();
    guest.drain();

    const g = (id: string, x: number) => ({ id, piece: 6, rot: 0, x, y: 20 });

    // set — 통째로 올린다
    host.send({ t: "plan", set: [g("a", 1), g("b", 4)] });
    let st = await guest.waitFor("plan-state");
    expect(st.playerId).toBe(hostId);
    expect(st.ghosts.map((x) => x.id)).toEqual(["a", "b"]);

    // add — 같은 id는 덮어쓰고, 새 id는 붙는다
    host.send({ t: "plan", add: [g("b", 9), g("c", 2)] });
    st = await guest.waitFor("plan-state");
    expect(st.ghosts.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(st.ghosts.find((x) => x.id === "b")?.x).toBe(9);

    // remove — 고른 것만 지운다
    host.send({ t: "plan", remove: ["b"] });
    st = await guest.waitFor("plan-state");
    expect(st.ghosts.map((x) => x.id)).toEqual(["a", "c"]);

    // set: [] — 전부 지운다
    host.send({ t: "plan", set: [] });
    st = await guest.waitFor("plan-state");
    expect(st.ghosts).toEqual([]);

    host.close();
    guest.close();
  });

  it("계획한 자리에 조각이 놓이면 서버가 알아서 걷어낸다", async () => {
    const { host, code } = await createRoom(url);
    host.send({ t: "config", config: TEST_CONFIG });
    const guest = await joinRoom(url, code, "G1");
    await host.waitState((st) => st.players.length === 2);
    host.drain();
    guest.drain();
    host.send({ t: "start-match" });
    await host.waitFor("match-start");
    await guest.waitFor("match-start");

    // O 조각을 (0,0)과 (4,0)에 놓을 계획
    host.send({
      t: "plan",
      set: [
        { id: "placed", piece: 4, rot: 0, x: 0, y: 0 },
        { id: "still", piece: 4, rot: 0, x: 4, y: 0 },
      ],
    });
    let st = await guest.waitFor("plan-state");
    expect(st.ghosts.map((x) => x.id)).toEqual(["placed", "still"]);

    // 첫 계획 자리만 메워진 보드를 보낸다
    const cols = STANDARD_RULESET.cols;
    const totalRows = STANDARD_RULESET.rows + STANDARD_RULESET.bufferRows;
    const grid = new Array(cols * totalRows).fill(0);
    const shape = shapeOf(4, 0); // O
    for (let i = 0; i < 8; i += 2) grid[(0 + shape[i + 1]) * cols + (0 + shape[i])] = 4;
    host.send({ t: "relay", msg: { t: "board", snap: { grid } } });

    // 놓인 쪽만 사라지고 나머지는 남는다
    st = await guest.waitFor("plan-state");
    expect(st.ghosts.map((x) => x.id)).toEqual(["still"]);

    host.close();
    guest.close();
  });

  it("판이 끝나면 서버가 계획을 걷는다", async () => {
    const { host, guests } = await readyRoom(1);
    await startMatch(host, guests);
    host.send({ t: "plan", set: [{ id: "x", piece: 6, rot: 0, x: 3, y: 20 }] });
    const up = await guests[0].waitFor("plan-state");
    expect(up.ghosts).toHaveLength(1);

    guests[0].send({ t: "ko" });
    // 판 종료와 함께 비워진 상태가 온다
    for (;;) {
      const st = await guests[0].waitFor("plan-state", 3000);
      if (st.ghosts.length === 0) break;
    }

    host.close();
    guests[0].close();
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
