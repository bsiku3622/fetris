#!/usr/bin/env node
// ============================================================================
// 봇 토큰 발급 도구 — 토큰 파일에 항목을 추가/삭제/조회한다.
//
//   node scripts/bot-token.mjs add <소유자> [메모]
//   node scripts/bot-token.mjs list
//   node scripts/bot-token.mjs revoke <토큰앞자리|소유자>
//
// 파일 경로는 FETRIS_BOT_TOKENS 환경변수, 없으면 ./bot-tokens.json.
// 서버는 파일 변경을 스스로 감지하므로 재시작할 필요가 없다.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const FILE = resolve(process.env.FETRIS_BOT_TOKENS ?? "bot-tokens.json");

function load() {
  if (!existsSync(FILE)) return { tokens: [] };
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    return { tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
  } catch (err) {
    console.error(`토큰 파일을 읽을 수 없습니다 (${FILE}):`, err.message);
    process.exit(1);
  }
}

function save(data) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
  // 토큰은 비밀이다 — 소유자만 읽도록 잠근다
  try {
    chmodSync(FILE, 0o600);
  } catch {
    /* 파일시스템이 지원하지 않으면 넘어간다 */
  }
}

const mask = (t) => `${t.slice(0, 8)}…${t.slice(-4)}`;

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "add": {
    const owner = args[0];
    if (!owner) {
      console.error("사용법: bot-token.mjs add <소유자> [메모]");
      process.exit(1);
    }
    const label = args.slice(1).join(" ") || undefined;
    const token = randomBytes(24).toString("base64url");
    const data = load();
    data.tokens.push({ token, owner, ...(label ? { label } : {}) });
    save(data);
    console.log(`발급 완료 — 소유자: ${owner}${label ? ` (${label})` : ""}`);
    console.log(`파일: ${FILE}`);
    console.log(`\n이 토큰을 봇 주인에게 전달하세요. 다시 볼 수 없으니 지금 복사해 두세요:\n`);
    console.log(`  ${token}\n`);
    console.log(`실행 예:`);
    console.log(`  FETRIS_WS_URL=wss://fetris-be.bsiku.dev FETRIS_BOT_TOKEN=${token} \\`);
    console.log(`    node examples/bot-runner.mjs`);
    break;
  }

  case "list": {
    const data = load();
    if (data.tokens.length === 0) {
      console.log(`등록된 토큰이 없습니다 (${FILE})`);
      break;
    }
    console.log(`토큰 ${data.tokens.length}개 (${FILE})\n`);
    for (const t of data.tokens) {
      console.log(`  ${mask(t.token)}  ${t.owner}${t.label ? `  — ${t.label}` : ""}`);
    }
    break;
  }

  case "revoke": {
    const needle = args[0];
    if (!needle) {
      console.error("사용법: bot-token.mjs revoke <토큰앞자리|소유자>");
      process.exit(1);
    }
    const data = load();
    const before = data.tokens.length;
    data.tokens = data.tokens.filter(
      (t) => !t.token.startsWith(needle) && t.owner !== needle,
    );
    const removed = before - data.tokens.length;
    if (removed === 0) {
      console.error(`일치하는 토큰이 없습니다: ${needle}`);
      process.exit(1);
    }
    save(data);
    console.log(`${removed}개 폐기했습니다. 서버가 곧 반영합니다(재시작 불필요).`);
    break;
  }

  default:
    console.log(`봇 토큰 관리 — 파일: ${FILE}\n`);
    console.log(`  add <소유자> [메모]           새 토큰 발급`);
    console.log(`  list                          등록된 토큰 보기(값은 가려짐)`);
    console.log(`  revoke <토큰앞자리|소유자>     토큰 폐기`);
    process.exit(cmd ? 1 : 0);
}
