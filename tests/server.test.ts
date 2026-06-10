import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { startServer, type RelayServer } from "../src/server.js";
import type { ServerControl } from "../src/protocol.js";

let server: RelayServer;
let url: string;

beforeAll(async () => {
  server = startServer(0);
  if (!server.http.listening) {
    await new Promise<void>((res) => server.http.once("listening", () => res()));
  }
  const addr = server.http.address() as AddressInfo;
  url = `ws://127.0.0.1:${addr.port}`;
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

  static async connect(): Promise<Client> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.once("open", () => res());
      ws.once("error", rej);
    });
    return new Client(ws);
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

  close(): void {
    this.ws.close();
  }
}

describe("릴레이 서버", () => {
  it("create는 4자리 방 코드를 발급한다", async () => {
    const host = await Client.connect();
    host.send({ t: "create" });
    const m = await host.next();
    expect(m.t).toBe("created");
    if (m.t === "created") expect(m.code).toMatch(/^[A-Z0-9]{4}$/);
    host.close();
  });

  it("게스트가 입장하면 호스트에게 peer-joined가 간다", async () => {
    const host = await Client.connect();
    host.send({ t: "create" });
    const created = await host.next();
    const code = created.t === "created" ? created.code : "";

    const guest = await Client.connect();
    guest.send({ t: "join", code });
    const joined = await guest.next();
    expect(joined.t).toBe("joined");

    const peerJoined = await host.next();
    expect(peerJoined.t).toBe("peer-joined");
    host.close();
    guest.close();
  });

  it("없는 방 코드로 입장하면 에러", async () => {
    const guest = await Client.connect();
    guest.send({ t: "join", code: "ZZZZ" });
    const m = await guest.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("room-not-found");
    guest.close();
  });

  it("꽉 찬 방에는 입장 불가 (maxPlayers=2)", async () => {
    const host = await Client.connect();
    host.send({ t: "create", maxPlayers: 2 });
    const code = (await host.next() as { code: string }).code;
    const g1 = await Client.connect();
    g1.send({ t: "join", code });
    await g1.next();
    await host.next(); // peer-joined
    const g2 = await Client.connect();
    g2.send({ t: "join", code });
    const m = await g2.next();
    expect(m.t).toBe("error");
    if (m.t === "error") expect(m.reason).toBe("room-full");
    host.close();
    g1.close();
    g2.close();
  });

  it("N인 방: 정원에 따라 여러 명이 입장한다", async () => {
    const host = await Client.connect();
    host.send({ t: "create", maxPlayers: 4 });
    const code = (await host.next() as { code: string }).code;
    const g1 = await Client.connect();
    g1.send({ t: "join", code });
    expect((await g1.next()).t).toBe("joined");
    await host.next(); // peer-joined
    const g2 = await Client.connect();
    g2.send({ t: "join", code });
    expect((await g2.next()).t).toBe("joined"); // 3번째 입장도 OK
    host.close();
    g1.close();
    g2.close();
  });

  it("relay는 발신자를 제외한 방 전체에 브로드캐스트된다", async () => {
    const host = await Client.connect();
    host.send({ t: "create", maxPlayers: 4 });
    const code = (await host.next() as { code: string }).code;
    const g1 = await Client.connect();
    g1.send({ t: "join", code });
    await g1.next();
    await host.next(); // peer-joined
    const g2 = await Client.connect();
    g2.send({ t: "join", code });
    await g2.next();
    await host.next(); // peer-joined (g2)
    await g1.next(); // peer-joined (g2) — g1도 받음

    // 호스트가 relay → g1, g2 모두 수신
    host.send({ t: "relay", msg: { t: "attack", holes: [5] } });
    const r1 = await g1.next();
    const r2 = await g2.next();
    expect(r1.t).toBe("relay");
    expect(r2.t).toBe("relay");
    if (r1.t === "relay") expect(r1.msg).toEqual({ t: "attack", holes: [5] });
    host.close();
    g1.close();
    g2.close();
  });

  it("게임 메시지를 상대에게 그대로 중계한다", async () => {
    const host = await Client.connect();
    host.send({ t: "create" });
    const code = (await host.next() as { code: string }).code;
    const guest = await Client.connect();
    guest.send({ t: "join", code });
    await guest.next();
    await host.next(); // peer-joined

    // 호스트 → 게스트
    host.send({ t: "relay", msg: { t: "attack", holes: [1, 2, 3] } });
    const relayed = await guest.next();
    expect(relayed.t).toBe("relay");
    if (relayed.t === "relay") expect(relayed.msg).toEqual({ t: "attack", holes: [1, 2, 3] });

    // 게스트 → 호스트
    guest.send({ t: "relay", msg: { t: "dead" } });
    const back = await host.next();
    expect(back.t).toBe("relay");
    if (back.t === "relay") expect(back.msg).toEqual({ t: "dead" });

    host.close();
    guest.close();
  });

  it("한 명이 나가도 남은 사람이 있으면 방은 유지된다", async () => {
    const host = await Client.connect();
    host.send({ t: "create", maxPlayers: 2 });
    const code = (await host.next() as { code: string }).code;
    const guest = await Client.connect();
    guest.send({ t: "join", code });
    await guest.next();
    await host.next(); // peer-joined

    guest.close();
    const m = await host.next();
    expect(m.t).toBe("peer-left");
    // 새 N인 모델: 호스트가 남아 있으므로 방은 유지 → 재입장 가능
    await new Promise((r) => setTimeout(r, 50));
    const late = await Client.connect();
    late.send({ t: "join", code });
    const reJoin = await late.next();
    expect(reJoin.t).toBe("joined");

    // 모두 나가면 방 삭제
    host.close();
    late.close();
    await new Promise((r) => setTimeout(r, 50));
    const orphan = await Client.connect();
    orphan.send({ t: "join", code });
    const m2 = await orphan.next();
    expect(m2.t).toBe("error");
    if (m2.t === "error") expect(m2.reason).toBe("room-not-found");
    orphan.close();
  });
});
