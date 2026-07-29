#!/usr/bin/env node
// ============================================================================
// 참조 봇 러너 — 등록부터 실제 플레이까지 도는 최소 구현.
//
// 흐름:
//   1. `/bot`에 붙어 `bot-hello`로 등록하고 대기(control-plane 연결).
//   2. 호스트가 봇을 부르면 `bot-invite`(code + ticket)가 온다.
//   3. 초대마다 `/bot` 연결을 새로 열어 ticket으로 join(data-plane 연결).
//   4. `match-start`를 받으면 같은 시드로 판을 열고 직접 둔다.
//
// 두뇌는 "모든 회전 × 모든 열을 놓아보고 점수가 가장 낮은 자리를 고르는" 방식이다.
// 구멍·굴곡·높이에 가중치를 주는 단순한 평가지만 꽤 오래 버틴다. 여기를 고치는 게
// 봇을 강하게 만드는 일의 전부다.
//
// 채팅 커맨드로 조절할 수 있다(방 채팅에 입력):
//   !bot pps 2.5     두는 속도(초당 조각)
//   !bot status      현재 설정
//   !bot help        도움말
//
// 판이 끝나면 자기 리플레이를 서버에 제출하고(검증) 방에도 나눠준다. 이게 없으면
// 봇만 있는 방을 구경한 사람은 내려받을 기록이 하나도 남지 않는다.
//
// 실행:
//   FETRIS_WS_URL=wss://fetris-be.bsiku.dev FETRIS_BOT_TOKEN=... node examples/bot-runner.mjs
// ============================================================================

import { WebSocket } from "ws";
import { Game, EventType } from "@fetris/engine/game";
import { ReplayRecorder, ReplayAction, fingerprint, REPLAY_FORMAT } from "@fetris/engine/replay";
import { shapeOf } from "@fetris/engine/pieces";
import { Piece } from "@fetris/engine/types";

const SERVER = process.env.FETRIS_WS_URL ?? "ws://localhost:8787";
const TOKEN = process.env.FETRIS_BOT_TOKEN ?? "";
const NAME = process.env.FETRIS_BOT_NAME ?? "Example Bot";
const CAPACITY = Math.max(1, Number(process.env.FETRIS_BOT_CAPACITY ?? 2) || 1);
const RECONNECT_MS = 3000;

/** 채팅으로 조절되는 봇 설정 */
const defaults = {
  pps: Number(process.env.FETRIS_BOT_PPS ?? 2), // 초당 놓는 조각 수
  target: "random", // random | even | elims | payback
};

const botUrl = () => `${SERVER}/bot${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
const log = (...args) => console.log("[bot-runner]", ...args);

// ---------------------------------------------------------------------------
// 두뇌 — 보드 평가와 배치 선택
// ---------------------------------------------------------------------------

/** 조각을 px열에 떨어뜨렸을 때 착지 y */
function landingY(board, shape, px) {
  let y = 0;
  while (!board.collides(shape, px, y + 1)) y++;
  return y;
}

/** 보드가 얼마나 나쁜지 — 낮을수록 좋다 */
function boardScore(board) {
  const heights = [];
  let holes = 0;
  for (let x = 0; x < board.cols; x++) {
    let top = board.totalRows;
    for (let y = 0; y < board.totalRows; y++) {
      if (board.isSolid(x, y)) {
        top = y;
        break;
      }
    }
    heights.push(board.totalRows - top);
    for (let y = top + 1; y < board.totalRows; y++) {
      if (!board.isSolid(x, y)) holes++;
    }
  }
  const maxH = Math.max(...heights);
  const bumpy = heights.slice(1).reduce((s, h, i) => s + Math.abs(h - heights[i]), 0);
  const sumH = heights.reduce((a, b) => a + b, 0);
  // 이 가중치가 봇 실력을 좌우한다
  return holes * 12 + bumpy * 2 + maxH * 3 + sumH * 0.5;
}

/** 지금 조각을 놓을 최선의 자리 */
function bestPlacement(game) {
  let best = null;
  for (let rot = 0; rot < 4; rot++) {
    const shape = shapeOf(game.cur, rot);
    for (let px = -2; px < game.board.cols + 2; px++) {
      if (game.board.collides(shape, px, 0)) continue;
      const y = landingY(game.board, shape, px);
      const trial = new Game(game.rule, game.handling.h, game.seed);
      trial.deserialize(game.serialize());
      trial.board.place(shape, px, y, game.cur);
      trial.board.clearLines();
      const s = boardScore(trial.board);
      if (!best || s < best.score) best = { rot, px, score: s };
    }
  }
  return best;
}

const EMPTY_CMD = {
  rotateCW: false, rotateCCW: false, rotate180: false,
  hardDrop: false, hold: false, softDropHeld: false,
};

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
        log(`등록 완료 — id=${msg.runner.id} 소유자=${msg.runner.owner} capacity=${msg.runner.capacity}`);
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
// data-plane — 초대 하나당 연결 하나로 방에 착석해 실제로 플레이
// ---------------------------------------------------------------------------

function joinAsBot({ code, ticket, nick }) {
  const ws = new WebSocket(botUrl());
  const settings = { ...defaults };
  /** playerId → 상대 미러(보드 스냅샷을 적용해 둔다) */
  const mirrors = new Map();
  /** 상대별 내가 보낸 공격량 / 나를 때린 시각 */
  const sentTo = new Map();
  const hitBy = new Map();

  let myId = null;
  let game = null;
  let loop = null;
  let snapTimer = null;
  let plan = null;
  let alive = [];
  let config = null;
  let sinceDrop = 0;
  let frame = 0;
  /** 리플레이 기록 — 키 입력과 받은 가비지를 프레임 단위로 남긴다 */
  let recorder = null;
  let matchId = 0;
  let matchSeed = 0;
  /** 판이 끝나기 전에 떠 놓은 리플레이(톱아웃하면 게임 객체가 먼저 사라진다) */
  let pendingReplay = null;

  const send = (m) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  const sendGame = (msg) => send({ t: "relay", msg });
  const say = (text) => sendGame({ t: "chat", nick, text });

  ws.on("open", () => send({ t: "join", code, ticket, nick }));

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
        log(`방 ${msg.code} 착석 — 나=${myId}`);
        break;
      case "state":
        // 생존자 목록 갱신(나 제외)
        alive = msg.state.players.filter((p) => p.id !== myId && p.alive).map((p) => p.id);
        break;
      case "match-start":
        startMatch(msg);
        break;
      case "ko":
        alive = alive.filter((id) => id !== msg.playerId);
        break;
      case "match-end":
        stopMatch();
        submitReplay(msg);
        break;
      case "relay":
        onGameMessage(msg.from, msg.msg);
        break;
      case "error":
        log(`서버 에러: ${msg.reason}`);
        if (!myId) ws.close();
        break;
    }
  });

  ws.on("close", () => {
    stopMatch();
    log(`방 ${code} 퇴장`);
  });
  ws.on("error", (err) => log("봇 연결 오류:", err.message));

  function onGameMessage(from, msg) {
    switch (msg.t) {
      case "attack":
        if (game) {
          game.receiveGarbage({ holes: msg.holes });
          // 키 입력만으로는 이 판을 되살릴 수 없다 — 받은 가비지도 남겨야 한다
          recorder?.pushGarbage(msg.holes);
        }
        hitBy.set(from, frame);
        break;
      case "board": {
        // 상대 보드를 미러에 적용 — elims 전략에 쓴다
        if (!config) break;
        let m = mirrors.get(from);
        if (!m) {
          m = new Game(config.rule, config.handling, 0);
          mirrors.set(from, m);
        }
        m.deserialize(msg.snap);
        break;
      }
      case "chat":
        handleChat(msg.nick, msg.text);
        break;
    }
  }

  // ---- 채팅 커맨드 --------------------------------------------------------

  function handleChat(who, text) {
    const t = (text ?? "").trim();
    if (!t.startsWith("!")) return;
    const [head, ...rest] = t.slice(1).split(/\s+/);
    // "!bot ..." 또는 "!<내 닉> ..." 에만 반응한다
    const forMe = head.toLowerCase() === "bot" || head === nick.replace(/\s+/g, "");
    if (!forMe) return;

    const [cmd, ...args] = rest;
    switch ((cmd ?? "").toLowerCase()) {
      case "pps": {
        const v = Number(args[0]);
        if (!Number.isFinite(v) || v <= 0 || v > 20) {
          say(`${who}님, pps는 0보다 크고 20 이하로 주세요 (지금 ${settings.pps})`);
          return;
        }
        settings.pps = v;
        say(`pps를 ${v}로 맞췄어요`);
        break;
      }
      case "target": {
        const v = (args[0] ?? "").toLowerCase();
        if (!["random", "even", "elims", "payback"].includes(v)) {
          say(`타깃은 random / even / elims / payback 중 하나예요 (지금 ${settings.target})`);
          return;
        }
        settings.target = v;
        say(`타깃 전략을 ${v}로 바꿨어요`);
        break;
      }
      case "status":
        say(`pps=${settings.pps} · target=${settings.target}`);
        break;
      case "help":
        say("!bot pps <숫자> · !bot target <random|even|elims|payback> · !bot status");
        break;
      default:
        say(`모르는 명령이에요. !bot help 를 보세요`);
    }
  }

  // ---- 매치 --------------------------------------------------------------

  function startMatch(msg) {
    stopMatch();
    config = msg.config;
    // 참가자가 아니면(관전 상태) 판을 열지 않는다
    if (!msg.players.includes(myId)) return;

    const seed = config.sharePieces ? msg.seed : (Math.random() * 0xffffffff) >>> 0;
    game = new Game(config.rule, config.handling, seed);
    game.attackMultiplier = config.attackMul;
    plan = null;
    sinceDrop = 0;
    frame = 0;
    matchId = msg.matchId;
    matchSeed = seed;
    recorder = new ReplayRecorder();
    pendingReplay = null;

    const dt = 60 / config.simRate;
    loop = setInterval(() => step(dt), 1000 / config.simRate);
    // 내 보드를 방에 알린다(사람들 화면에 보이도록) — 5Hz면 충분하다
    snapTimer = setInterval(() => {
      if (game) sendGame({ t: "board", snap: game.serialize() });
    }, 200);
    log(`판 시작 — seed=${seed} simRate=${config.simRate} pps=${settings.pps}`);
  }

  function stopMatch() {
    if (loop) clearInterval(loop);
    if (snapTimer) clearInterval(snapTimer);
    loop = null;
    snapTimer = null;
    // 톱아웃하면 여기서 판이 먼저 정리된다 — 기록은 그 전에 떠 둬야 한다
    if (game && recorder && !pendingReplay) pendingReplay = captureReplay(game, recorder);
    game = null;
    recorder = null;
    mirrors.clear();
  }

  /** 지금 상태로 리플레이 한 벌을 만든다(재생·검증에 필요한 조건 전부) */
  function captureReplay(g, rec) {
    return {
      format: REPLAY_FORMAT,
      game: "fetris",
      match: { code, matchId },
      rule: g.rule,
      handling: g.handling.h,
      simRate: config.simRate,
      seed: matchSeed,
      frames: rec.frame,
      keys: rec.keys.slice(),
      garbage: rec.garbage.slice(),
      fingerprint: fingerprint(g),
      stats: {
        piecesPlaced: g.stats.piecesPlaced,
        lines: g.stats.lines,
        attack: g.stats.attack,
      },
    };
  }

  /**
   * 판이 끝나면 기록을 서버에 제출하고(재현해 대조) 방에도 나눠준다.
   * 관전자는 자기 로그가 없어 이 공유로만 봇의 판을 내려받을 수 있다.
   */
  function submitReplay(end) {
    const r = pendingReplay;
    pendingReplay = null;
    if (!r) return;
    const placement = end.standings?.find((s) => s.playerId === myId)?.placement;
    send({
      t: "replay",
      matchId: r.match.matchId,
      frames: r.frames,
      keys: r.keys,
      garbage: r.garbage,
      fingerprint: r.fingerprint,
    });
    sendGame({
      t: "replay-share",
      file: { ...r, recordedAt: new Date().toISOString(), player: { id: myId, nick, placement } },
    });
  }

  function step(dt) {
    if (!game) return;
    frame += dt;
    sinceDrop += dt;

    // think()이 이번 프레임의 조작을 만들고(그 안에서 pressDir 등이 기록된다),
    // commitFrame이 그것을 이번 프레임으로 확정한 뒤 시뮬이 한 스텝 나간다.
    // 이 순서가 어긋나면 재현이 한 프레임씩 밀려 검증에 걸린다.
    const cmd = think();
    recorder?.commitFrame();
    game.update(dt, cmd, 0);

    for (const e of game.events) {
      if (e.type === EventType.Attack && e.cells?.length) {
        const target = pickTarget();
        if (target) {
          send({ t: "relay-to", targetId: target, msg: { t: "attack", holes: [...e.cells] } });
          sentTo.set(target, (sentTo.get(target) ?? 0) + e.cells.length);
        }
      }
    }
    game.events.length = 0;

    if (game.isGameOver()) {
      log("톱아웃 — ko 신고");
      send({ t: "ko" });
      stopMatch();
    }
  }

  /** 한 프레임의 조작을 만든다 */
  function think() {
    // 카운트다운 중이거나 조각이 아직 없으면 아무것도 하지 않는다
    if (game.cur === Piece.None) {
      plan = null;
      return EMPTY_CMD;
    }
    if (!plan) plan = bestPlacement(game);
    if (!plan) return EMPTY_CMD;

    if (game.rot !== plan.rot) {
      recorder?.push(ReplayAction.RotateCW, true);
      return { ...EMPTY_CMD, rotateCW: true };
    }
    if (game.px < plan.px) {
      press(1);
      return EMPTY_CMD;
    }
    if (game.px > plan.px) {
      press(-1);
      return EMPTY_CMD;
    }
    release(1);
    release(-1);

    // pps만큼만 놓는다 — 사람과 비슷한 속도로 맞추는 손잡이
    const framesPerPiece = 60 / settings.pps;
    if (sinceDrop < framesPerPiece) return EMPTY_CMD;

    sinceDrop = 0;
    plan = null;
    recorder?.push(ReplayAction.HardDrop, true);
    return { ...EMPTY_CMD, hardDrop: true };
  }

  /**
   * 방향키 누름/뗌 — 호출을 그대로 1:1로 남긴다.
   *
   * "눌린 상태면 건너뛰기" 같은 압축을 하면 안 된다. pressDir는 이미 눌려 있어도
   * 매번 초기 이동을 다시 걸어 주고(그래서 이 봇이 한 프레임에 한 칸씩 움직인다)
   * finesse 카운터도 올라간다. 호출 횟수 자체가 결과에 남으므로 그대로 기록해야
   * 서버 재현이 맞는다.
   */
  function press(dir) {
    game.pressDir(dir);
    recorder?.push(dir > 0 ? ReplayAction.MoveRight : ReplayAction.MoveLeft, true);
  }
  function release(dir) {
    game.releaseDir(dir);
    recorder?.push(dir > 0 ? ReplayAction.MoveRight : ReplayAction.MoveLeft, false);
  }

  function pickTarget() {
    const live = alive.filter((id) => id !== myId);
    if (live.length === 0) return null;
    if (live.length === 1) return live[0];

    switch (settings.target) {
      case "even": {
        let best = live[0];
        for (const id of live) {
          if ((sentTo.get(id) ?? 0) < (sentTo.get(best) ?? 0)) best = id;
        }
        return best;
      }
      case "elims": {
        let best = live[0];
        let top = Infinity;
        for (const id of live) {
          const m = mirrors.get(id);
          if (!m) continue;
          const h = m.board.highestRow();
          if (h < top) {
            top = h;
            best = id;
          }
        }
        return best;
      }
      case "payback": {
        let best = null;
        let latest = -1;
        for (const id of live) {
          const f = hitBy.get(id);
          if (f !== undefined && f > latest) {
            latest = f;
            best = id;
          }
        }
        return best ?? live[Math.floor(Math.random() * live.length)];
      }
      default:
        return live[Math.floor(Math.random() * live.length)];
    }
  }
}

log(`서버 ${SERVER} 에 러너 "${NAME}"(capacity=${CAPACITY}, pps=${defaults.pps}) 연결 중…`);
connectRunner();

process.on("SIGINT", () => {
  log("종료합니다");
  process.exit(0);
});
