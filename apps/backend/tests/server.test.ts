import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

describe("방 수명", () => {
  it("create는 4자리 방 코드와 초기 상태를 준다", async () => {
    const { host, code, state } = await createRoom(url);
    expect(code).toMatch(/^[A-Z0-9]{4}$/);
    expect(state.phase).toBe("lobby");
    expect(state.players).toHaveLength(1);
    expect(state.players[0].isHost).toBe(true);
    expect(state.players[0].role).toBe("player");
    expect(state.matchId).toBe(0);
    host.close();
  });

  it("게스트가 입장하면 방 전체에 상태가 브로드캐스트된다", async () => {
    const { host, code } = await createRoom(url);
    const guest = await joinRoom(url, code, "게스트");

    const s = await host.waitFor("state");
    expect(s.state.players).toHaveLength(2);
    expect(s.state.players.some((p) => p.nick === "게스트" && !p.isHost)).toBe(true);

    host.close();
    guest.close();
  });

  it("없는 방 코드로 입장하면 에러", async () => {
    const guest = await Client.connect(url);
    guest.send({ t: "join", code: "ZZZZ" });
    const m = await guest.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("room-not-found");
    guest.close();
  });

  it("참가 정원이 차면 관전자로 들어온다 (입장 자체는 막지 않는다)", async () => {
    const { host, code } = await createRoom(url, 2);
    const g1 = await joinRoom(url, code, "G1");
    const g2 = await joinRoom(url, code, "구경꾼");

    const s = await host.waitState((st) => st.players.some((p) => p.nick === "구경꾼"));
    const late = s.players.find((p) => p.nick === "구경꾼");
    expect(late?.role).toBe("spectator");
    // 참가자는 정원만큼만 남는다
    expect(s.players.filter((p) => p.role === "player")).toHaveLength(2);

    host.close();
    g1.close();
    g2.close();
  });

  it("관전자는 정원을 차지하지 않는다", async () => {
    const { host, code } = await createRoom(url, 2);
    const guest = await joinRoom(url, code, "G1");
    // 정원 2가 찼지만 관전자는 얼마든지 들어올 수 있다
    const s1 = await joinRoom(url, code, "관전1");
    const s2 = await joinRoom(url, code, "관전2");

    const s = await host.waitState((st) => st.players.length === 4);
    expect(s.players.filter((p) => p.role === "player")).toHaveLength(2);
    expect(s.players.filter((p) => p.role === "spectator")).toHaveLength(2);

    host.close();
    guest.close();
    s1.close();
    s2.close();
  });

  it("정원이 없으면(기본) 인원 제한 없이 참가한다", async () => {
    const { host, code, state } = await createRoom(url); // maxPlayers 미지정 = 무제한
    expect(state.maxPlayers).toBe(0);
    const guests = [];
    for (let i = 0; i < 5; i++) guests.push(await joinRoom(url, code, `G${i}`));

    const s = await host.waitState((st) => st.players.length === 6);
    expect(s.players.every((p) => p.role === "player")).toBe(true);

    host.close();
    for (const g of guests) g.close();
  });

  it("정원 안에서는 여러 명이 입장한다", async () => {
    const { host, code } = await createRoom(url, 4);
    const g1 = await joinRoom(url, code, "G1");
    const g2 = await joinRoom(url, code, "G2");

    for (;;) {
      const s = await host.waitFor("state");
      if (s.state.players.length === 3) break;
    }

    host.close();
    g1.close();
    g2.close();
  });

  it("relay는 발신자를 제외한 방 전체에 브로드캐스트된다", async () => {
    const { host, code } = await createRoom(url, 4);
    const g1 = await joinRoom(url, code, "G1");
    const g2 = await joinRoom(url, code, "G2");
    g1.drain();
    g2.drain();

    host.send({ t: "relay", msg: { t: "attack", holes: [5] } });
    const r1 = await g1.waitFor("relay");
    const r2 = await g2.waitFor("relay");
    expect(r1.msg).toEqual({ t: "attack", holes: [5] });
    expect(r2.msg).toEqual({ t: "attack", holes: [5] });

    host.close();
    g1.close();
    g2.close();
  });

  it("relay-to는 지정한 상대에게만 간다", async () => {
    const { host, code } = await createRoom(url, 4);
    const g1 = await joinRoom(url, code, "G1");
    const g2 = await joinRoom(url, code, "G2");

    // 호스트가 보는 로스터에서 g1의 id를 찾는다
    let g1Id = "";
    for (;;) {
      const s = await host.waitFor("state");
      const found = s.state.players.find((p) => p.nick === "G1");
      if (found) {
        g1Id = found.id;
        break;
      }
    }
    g1.drain();
    g2.drain();

    host.send({ t: "relay-to", targetId: g1Id, msg: { t: "attack", holes: [1, 2] } });
    const got = await g1.waitFor("relay");
    expect(got.msg).toEqual({ t: "attack", holes: [1, 2] });

    // g2에게는 오지 않아야 한다 — 짧게 기다렸다 타임아웃이면 통과
    await expect(g2.waitFor("relay", 200)).rejects.toThrow();

    host.close();
    g1.close();
    g2.close();
  });

  it("한 명이 나가도 남은 사람이 있으면 방은 유지된다", async () => {
    const { host, code } = await createRoom(url, 2);
    const guest = await joinRoom(url, code, "게스트");
    host.drain();

    guest.close();
    const s = await host.waitState((st) => st.players.length === 1);
    expect(s.players).toHaveLength(1);

    // 방이 살아 있으므로 재입장 가능
    const late = await joinRoom(url, code, "재입장");
    expect(late).toBeTruthy();

    // 모두 나가면 방 삭제
    host.close();
    late.close();
    await new Promise((r) => setTimeout(r, 60));
    const orphan = await Client.connect(url);
    orphan.send({ t: "join", code });
    const m = await orphan.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("room-not-found");
    orphan.close();
  });

  it("호스트가 나가면 남은 사람이 승계한다", async () => {
    const { host, code } = await createRoom(url, 4);
    const guest = await joinRoom(url, code, "후계자");
    guest.drain();

    host.close();
    for (;;) {
      const s = await guest.waitFor("state");
      if (s.state.players.length === 1) {
        expect(s.state.players[0].isHost).toBe(true);
        expect(s.state.players[0].nick).toBe("후계자");
        break;
      }
    }
    guest.close();
  });
});
