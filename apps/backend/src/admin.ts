import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ADMIN_PAGE } from "./adminPage.js";
import type { BotTokenEntry, BotTokenFile } from "./botTokens.js";

// ============================================================================
// 봇 토큰 관리 웹 — 터미널 없이 발급/폐기하기 위한 작은 관리 서버.
//
// **공개하지 않는다.** 기본으로 VPN 주소(10.8.0.1)에만 바인딩하며, 그래서
// 별도 로그인이 없다. 접근 통제는 전적으로 네트워크 경계(WireGuard)에 맡긴다.
// 0.0.0.0에 띄우면 토큰 발급 권한이 그대로 노출되니 절대 그러지 말 것.
//
// 릴레이 본체와 별도 프로세스로 돈다 — 관리 기능이 죽어도 대전은 계속되고,
// 반대로 관리 서버만 재시작할 수 있다.
// ============================================================================

const HOST = process.env.ADMIN_HOST || "10.8.0.1";
const PORT = Number(process.env.ADMIN_PORT) || 8788;
const TOKENS_PATH = process.env.FETRIS_BOT_TOKENS || "/srv/fetris/bot-tokens.json";
/** 러너 현황을 읽어올 릴레이 주소 */
const RELAY = process.env.RELAY_URL || "http://127.0.0.1:8787";

function loadTokens(): BotTokenEntry[] {
  if (!existsSync(TOKENS_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as BotTokenFile;
    return Array.isArray(parsed.tokens) ? parsed.tokens : [];
  } catch {
    return [];
  }
}

function saveTokens(tokens: BotTokenEntry[]): void {
  // 새로 만들 때만 잠근다 — 기존 권한(서비스 사용자 읽기)을 덮어쓰지 않는다
  const isNew = !existsSync(TOKENS_PATH);
  writeFileSync(TOKENS_PATH, JSON.stringify({ tokens }, null, 2) + "\n", "utf8");
  if (isNew) {
    try {
      chmodSync(TOKENS_PATH, 0o600);
    } catch {
      /* 지원하지 않는 파일시스템이면 넘어간다 */
    }
  }
}

const mask = (t: string): string => `${t.slice(0, 8)}…${t.slice(-4)}`;
/** 토큰 원문을 URL에 노출하지 않으려고 앞자리만 식별자로 쓴다 */
const idOf = (t: string): string => t.slice(0, 12);

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8192) throw new Error("본문이 너무 큽니다");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);
  const path = url.pathname;

  try {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(ADMIN_PAGE);
      return;
    }

    // 브라우저가 자동으로 찾는다 — 404를 콘솔에 남기지 않도록 조용히 넘긴다
    if (path === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/api/tokens") {
      const tokens = loadTokens().map((t) => ({
        id: idOf(t.token),
        owner: t.owner,
        label: t.label,
        masked: mask(t.token),
      }));
      json(res, 200, { tokens });
      return;
    }

    if (req.method === "POST" && path === "/api/tokens") {
      const body = (await readBody(req)) as { owner?: string; label?: string };
      const owner = String(body.owner ?? "").trim().slice(0, 24);
      if (!owner) {
        json(res, 400, { error: "소유자가 비어 있습니다" });
        return;
      }
      const label = String(body.label ?? "").trim().slice(0, 40) || undefined;
      const token = randomBytes(24).toString("base64url");
      const tokens = loadTokens();
      tokens.push({ token, owner, ...(label ? { label } : {}) });
      saveTokens(tokens);
      console.log(`[fetris-admin] 토큰 발급 — ${owner}${label ? ` (${label})` : ""}`);
      json(res, 200, { token, owner, label });
      return;
    }

    if (req.method === "DELETE" && path.startsWith("/api/tokens/")) {
      const id = decodeURIComponent(path.slice("/api/tokens/".length));
      const tokens = loadTokens();
      const next = tokens.filter((t) => idOf(t.token) !== id);
      if (next.length === tokens.length) {
        json(res, 404, { error: "해당 토큰을 찾을 수 없습니다" });
        return;
      }
      saveTokens(next);
      console.log(`[fetris-admin] 토큰 폐기 — ${id}`);
      json(res, 200, { removed: tokens.length - next.length });
      return;
    }

    // 릴레이의 러너 현황을 그대로 전달(브라우저가 릴레이에 직접 붙지 않아도 되게)
    if (req.method === "GET" && path === "/api/runners") {
      try {
        const upstream = await fetch(`${RELAY}/bots`, {
          signal: AbortSignal.timeout(3000),
        });
        const data = (await upstream.json()) as Record<string, unknown>;
        json(res, 200, { ...data, relay: RELAY });
      } catch (err) {
        json(res, 502, { error: `릴레이 응답 없음 (${String(err)})`, relay: RELAY });
      }
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (err) {
    json(res, 400, { error: String(err instanceof Error ? err.message : err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[fetris-admin] http://${HOST}:${PORT} — 토큰 파일 ${TOKENS_PATH}`);
});

const shutdown = (signal: string) => {
  console.log(`[fetris-admin] ${signal} 수신 — 종료합니다`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
