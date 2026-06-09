import { startServer } from "./server.js";

// ============================================================================
// 엔트리포인트 — PORT 환경변수(기본 8787)로 릴레이 서버 기동.
// 우분투 배포: systemd 또는 Docker로 이 프로세스를 띄우고, 앞단 Nginx/Caddy가
// TLS 종단 + wss:// 프록시를 담당한다(README 참고).
// ============================================================================

const port = Number(process.env.PORT) || 8787;
const server = startServer(port);

console.log(`[fetris-be] relay listening on :${port} (health: /health)`);

const shutdown = (signal: string) => {
  console.log(`[fetris-be] ${signal} 수신 — 종료합니다`);
  server.close().then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
