import { startServer } from "./server.js";

// ============================================================================
// 엔트리포인트 — PORT 환경변수(기본 8787)로 릴레이 서버 기동.
// 우분투 배포: systemd 또는 Docker로 이 프로세스를 띄우고, 앞단 Nginx/Caddy가
// TLS 종단 + wss:// 프록시를 담당한다(README 참고).
// FETRIS_BOT_TOKEN을 설정하면 봇 엔드포인트(/bot)에 토큰 인증이 걸린다.
// ============================================================================

const port = Number(process.env.PORT) || 8787;
const botToken = process.env.FETRIS_BOT_TOKEN;
const botTokensPath = process.env.FETRIS_BOT_TOKENS;
const server = startServer(port, { botToken, botTokensPath });

const auth = botTokensPath
  ? `토큰 파일 ${botTokensPath}`
  : botToken
    ? "단일 토큰"
    : "인증 없음(공개)";
console.log(`[fetris-be] relay listening on :${port} (health: /health, bots: /bot — ${auth})`);

const shutdown = (signal: string) => {
  console.log(`[fetris-be] ${signal} 수신 — 종료합니다`);
  server.close().then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
