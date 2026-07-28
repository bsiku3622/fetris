#!/usr/bin/env node
// ============================================================================
// 참조 봇 러너 — 봇 엔드포인트(`/bot`) 사용법을 보여주는 최소 구현.
//
// 흐름:
//   1. `/bot`에 붙어 `bot-hello`로 등록하고 대기(control-plane 연결).
//   2. 호스트가 add-bot을 누르면 서버가 `bot-invite`(code + ticket)를 보낸다.
//   3. 초대마다 `/bot` 연결을 새로 열어 ticket으로 join(data-plane 연결).
//   4. 방 안에서는 일반 참가자와 똑같이 relay 게임 메시지를 주고받는다.
//
// 이 예제에는 실제 플레이 로직이 없다. 서버는 게임을 시뮬레이션하지 않으므로,
// 진짜 봇을 만들려면 frontend/src/engine을 재사용해 보드를 굴리면서
// attack/board/dead 게임 메시지를 내보내면 된다(자리 표시는 playMatch 안 TODO).
//
// 실행:
//   node examples/bot-runner.mjs
//   FETRIS_WS_URL=ws://localhost:8787 FETRIS_BOT_CAPACITY=4 node examples/bot-runner.mjs
// ============================================================================

import { WebSocket } from "ws";

const SERVER = process.env.FETRIS_WS_URL ?? "ws://localhost:8787";
const TOKEN = process.env.FETRIS_BOT_TOKEN ?? "";
const NAME = process.env.FETRIS_BOT_NAME ?? "Example Bot";
const CAPACITY = Math.max(1, Number(process.env.FETRIS_BOT_CAPACITY ?? 2) || 1);
const RECONNECT_MS = 3000;
/** 데모용: 판이 시작되면 이만큼 버티다가 항복한다(실제 봇에서는 삭제) */
const DEMO_SURVIVE_MS = 8000;

const botUrl = () => `${SERVER}/bot${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
const log = (...args) => console.log("[bot-runner]", ...args);

// ---------------------------------------------------------------------------
// control-plane — 초대를 기다리는 러너 연결
// ---------------------------------------------------------------------------

function connectRunner() {
  const ws = new WebSocket(botUrl());

  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "bot-hello", name: NAME, capacity: CAPACITY }));
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.t) {
      case "bot-ready":
        log(`등록 완료 — id=${msg.runner.id} capacity=${msg.runner.capacity}`);
        break;
      case "bot-invite":
        log(`초대 수신 — 방 ${msg.code}에 "${msg.nick}" 투입`);
        joinAsBot(msg);
        break;
      case "error":
        log(`서버 에러: ${msg.reason}`);
        break;
    }
  });

  ws.on("close", (code) => {
    log(`러너 연결 종료(${code}) — ${RECONNECT_MS}ms 후 재연결`);
    setTimeout(connectRunner, RECONNECT_MS);
  });

  ws.on("error", (err) => log("러너 연결 오류:", err.message));
}

// ---------------------------------------------------------------------------
// data-plane — 초대 하나당 연결 하나로 방에 착석
// ---------------------------------------------------------------------------

function joinAsBot({ code, ticket, nick }) {
  const ws = new WebSocket(botUrl());
  /** 상대 playerId → 마지막으로 본 정보 */
  const peers = new Map();
  let myId = null;
  let matchTimer = null;

  const sendGame = (msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "relay", msg }));
  };

  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "join", code, ticket, nick }));
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.t) {
      case "joined":
        myId = msg.myId;
        for (const p of msg.players) peers.set(p.id, p);
        log(`방 ${msg.code} 착석 — 나=${myId}, 상대 ${peers.size}명`);
        break;
      case "peer-joined":
        peers.set(msg.player.id, msg.player);
        break;
      case "peer-left":
        peers.delete(msg.playerId);
        break;
      case "relay":
        onGameMessage(msg.from, msg.msg);
        break;
      case "error":
        log(`착석 실패: ${msg.reason}`);
        ws.close();
        break;
    }
  });

  ws.on("close", () => {
    clearTimeout(matchTimer);
    log(`방 ${code} 퇴장`);
  });

  ws.on("error", (err) => log("봇 연결 오류:", err.message));

  function onGameMessage(from, msg) {
    switch (msg.t) {
      case "settings":
        // 룰셋/공격 배수 — 실제 봇은 여기서 엔진 설정을 맞춘다
        break;
      case "start":
        log(`판 시작(seed=${msg.seed}) — 데모 봇이라 ${DEMO_SURVIVE_MS}ms 후 항복합니다`);
        playMatch(msg.seed);
        break;
      case "attack":
        // 나에게 온 가비지 — 실제 봇은 자기 보드에 적재한다
        break;
      case "board":
        peers.set(from, { ...(peers.get(from) ?? { id: from }), lastSnapshot: msg.snap });
        break;
    }
  }

  function playMatch(_seed) {
    clearTimeout(matchTimer);
    // TODO: 실제 봇 — 시드로 7-bag을 굴리며 엔진을 시뮬레이션하고,
    //       라인을 지울 때마다 { t: "attack", holes, targetId }를,
    //       주기적으로 { t: "board", snap }을 보낸다.
    matchTimer = setTimeout(() => sendGame({ t: "dead" }), DEMO_SURVIVE_MS);
  }
}

log(`서버 ${SERVER} 에 러너 "${NAME}"(capacity=${CAPACITY}) 연결 중…`);
connectRunner();

process.on("SIGINT", () => {
  log("종료합니다");
  process.exit(0);
});
