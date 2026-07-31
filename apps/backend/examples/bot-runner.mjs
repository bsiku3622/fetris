#!/usr/bin/env node
// ============================================================================
// 참조 봇 러너 — 등록부터 실제 플레이까지 도는 최소 구현.
//
// 흐름:
//   1. `/bot`에 붙어 `bot-hello`로 등록하고 대기(control-plane 연결).
//   2. 호스트가 봇을 부르면 `bot-invite`(code + ticket)가 온다.
//   3. 초대마다 `/bot` 연결을 새로 열어 ticket으로 join(data-plane 연결).
//   4. `match-start`를 받으면 서버가 나눠준 시드로 판을 열고 직접 둔다.
//
// 방에 보내는 것은 **보드가 아니라 누른 키**다. 프레임이 찍힌 입력을 `sync`로
// 흘려보내면 사람들 화면에서 이 봇의 판이 그대로 다시 돌아간다 — 스냅샷을
// 뿌리던 때보다 훨씬 가볍고, 조각이 끊기지 않고 실제로 떨어져 보인다.
// 반대로 상대 판도 같은 방식으로 받아 미러로 돌린다.
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
import { BoardMirror } from "@fetris/engine/mirror";
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
  planDepth: Number(process.env.FETRIS_BOT_PLAN ?? 3), // 화면에 띄울 계획 길이(0 = 끄기)
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
      if (!best || s < best.score) best = { rot, px, y, score: s };
    }
  }
  return best;
}

/**
 * 앞으로 놓을 자리들을 미리 잡아 본다 — 화면에 띄울 "계획"이다.
 *
 * 실제로 두는 것과는 무관하다. 매 조각마다 다시 계산하므로 여기서 나온 자리가
 * 그대로 실행된다는 보장은 없고, 어디까지나 지금 생각을 보여주는 용도다.
 */
function planAhead(game, depth) {
  const plan = [];
  const trial = new Game(game.rule, game.handling.h, game.seed);
  trial.deserialize(game.serialize());
  const upcoming = [trial.cur, ...trial.nextPieces(depth)];

  for (let i = 0; i < upcoming.length && plan.length < depth; i++) {
    const piece = upcoming[i];
    if (piece === Piece.None) break;
    trial.cur = piece;
    const spot = bestPlacement(trial);
    if (!spot) break;
    const shape = shapeOf(piece, spot.rot);
    // 뒤쪽 계획일수록 흐리게 — 확정도가 낮다는 걸 눈으로 알 수 있게
    // id를 달아두면 나중에 하나만 골라 지울 수 있다
    plan.push({ id: `p${i}`, piece, rot: spot.rot, x: spot.px, y: spot.y, alpha: 0.55 - i * 0.1 });
    trial.board.place(shape, spot.px, spot.y, piece);
    trial.board.clearLines();
  }
  return plan;
}

const EMPTY_CMD = {
  rotateCW: false, rotateCCW: false, rotate180: false,
  hardDrop: false, hold: false, softDropHeld: false,
};

/** 입력을 흘려보내는 주기(프레임). 사람 클라이언트와 같은 값이다. */
const STREAM_FRAMES = 4;
/**
 * 상태 키프레임 주기(프레임). 순단으로 입력이 통째로 빈 구간이 생기면 남의
 * 미러가 그 자리에 멈추는데, 이걸 받아야 다시 이어 붙는다.
 * 스트림 주기의 배수여야 같은 틱에서 스트림이 먼저 나간다.
 */
const KEYFRAME_FRAMES = 120;

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
  /** playerId → 상대 미러(받은 입력으로 그 사람 판을 그대로 다시 돌린다) */
  const mirrors = new Map();
  /** 상대별 내가 보낸 공격량 / 나를 때린 시각 */
  const sentTo = new Map();
  const hitBy = new Map();

  let myId = null;
  let game = null;
  let loop = null;
  let plan = null;
  let alive = [];
  let config = null;
  let sinceDrop = 0;
  let frame = 0;
  /**
   * 리플레이 기록 — 키 입력과 받은 가비지를 프레임 단위로 남긴다.
   * 이게 그대로 방에 흘려보내는 스트림이기도 하다.
   */
  let recorder = null;
  /** 어디까지 흘려보냈는지 */
  let sentKeys = 0;
  let sentIge = 0;
  let streamAccum = 0;
  let keyframeAccum = 0;
  let matchId = 0;
  let matchSeed = 0;
  /** 판이 끝나기 전에 떠 놓은 리플레이(톱아웃하면 게임 객체가 먼저 사라진다) */
  let pendingReplay = null;
  /** 마지막으로 방에 띄운 계획(같은 내용을 반복해 보내지 않기 위해) */
  let shownPlan = "";

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
        submitReplay();
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
          // 키 입력만으로는 이 판을 되살릴 수 없다 — 받은 가비지도 남겨야 한다.
          // 남긴 것이 그대로 스트림에 실려 나가 남의 미러도 같은 판이 된다.
          recorder?.pushGarbage(msg.holes);
        }
        hitBy.set(from, frame);
        break;
      // 상대가 흘려보낸 입력 — 미러가 그걸로 그 사람 판을 다시 돌린다
      case "sync":
        mirrorOf(from)?.feed(msg.upto, msg.keys, msg.ige);
        break;
      case "full":
        mirrorOf(from)?.keyframe(msg.frame, msg.snap);
        break;
      // 입력을 흘리지 않는 옛 클라이언트 호환 — 상태만 얹는다
      case "board":
        mirrorOf(from)?.snapshot(msg.snap);
        break;
      case "chat":
        handleChat(msg.nick, msg.text);
        break;
    }
  }

  /** 상대 미러를 꺼낸다(판이 열리기 전엔 없다) */
  function mirrorOf(id) {
    return mirrors.get(id) ?? null;
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
      case "plan": {
        const v = Number(args[0]);
        if (!Number.isFinite(v) || v < 0 || v > 6) {
          say(`plan은 0~6으로 주세요 (지금 ${settings.planDepth}, 0이면 끔)`);
          return;
        }
        settings.planDepth = Math.floor(v);
        if (settings.planDepth === 0) publishPlan([]);
        say(settings.planDepth === 0 ? "계획 표시를 껐어요" : `계획을 ${settings.planDepth}수까지 보여줄게요`);
        break;
      }
      case "status":
        say(`pps=${settings.pps} · target=${settings.target} · plan=${settings.planDepth}`);
        break;
      case "help":
        say("!bot pps <숫자> · !bot target <random|even|elims|payback> · !bot plan <0~6> · !bot status");
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

    // 시드는 서버가 나눠준다 — 조각 순서를 공유하지 않는 방이라도 서버가 내
    // 시드를 알고 있어야 제출한 기록을 재현해 볼 수 있다
    const sim = msg.sim ?? [];
    const seed = sim.find((s) => s.id === myId)?.seed ?? msg.seed;
    game = new Game(config.rule, config.handling, seed);
    game.attackMultiplier = config.attackMul;
    plan = null;
    sinceDrop = 0;
    frame = 0;
    matchId = msg.matchId;
    matchSeed = seed;
    recorder = new ReplayRecorder();
    pendingReplay = null;
    sentKeys = 0;
    sentIge = 0;
    streamAccum = 0;
    keyframeAccum = 0;

    /*
      상대마다 미러를 세운다. 흘려오는 입력을 같은 시드·감도로 다시 돌리면
      그 사람 판이 그대로 재현된다 — elims 전략이 보는 스택 높이가 스냅샷
      주기만큼 낡은 값이 아니라 지금 값이 된다.
    */
    mirrors.clear();
    for (const s of sim) {
      if (s.id === myId) continue;
      mirrors.set(
        s.id,
        new BoardMirror({
          rule: config.rule,
          handling: s.handling ?? config.handling,
          seed: s.seed,
          simRate: config.simRate,
          attackMul: config.attackMul,
        }),
      );
    }

    const dt = 60 / config.simRate;
    loop = setInterval(() => step(dt), 1000 / config.simRate);
    log(`판 시작 — seed=${seed} simRate=${config.simRate} pps=${settings.pps}`);
  }

  function stopMatch() {
    // 판이 끝나면 서버가 계획을 걷어주므로 여기서 보낼 필요는 없다
    if (loop) clearInterval(loop);
    loop = null;
    // 톱아웃하면 여기서 판이 먼저 정리된다 — 기록은 그 전에 떠 둬야 한다
    if (game && recorder && !pendingReplay) pendingReplay = captureReplay(game, recorder);
    game = null;
    recorder = null;
    shownPlan = "";
    mirrors.clear();
  }

  /**
   * 기록기에 새로 쌓인 만큼을 방에 흘려보낸다.
   *
   * `upto`는 "이 프레임까지는 빠짐없이 보냈다"는 경계다. 받는 쪽 미러는 딱
   * 거기까지만 진행하므로, 이 값을 실제보다 앞서 부르면 남의 화면에서 이 봇의
   * 판이 어긋난다.
   */
  function flushStream() {
    if (!recorder) return;
    const msg = { t: "sync", upto: recorder.frame };
    if (recorder.keys.length > sentKeys) {
      msg.keys = recorder.keys.slice(sentKeys);
      sentKeys = recorder.keys.length;
    }
    if (recorder.garbage.length > sentIge) {
      msg.ige = recorder.garbage.slice(sentIge);
      sentIge = recorder.garbage.length;
    }
    sendGame(msg);
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
   * 판이 끝나면 기록을 서버에 제출한다. 서버가 재현해 대조하는 동시에 방에도
   * 흘려주므로, 관전자는 이걸로 봇의 판을 내려받는다. 제출하지 않으면 구경한
   * 사람에게는 그 경기가 아무것도 남지 않는다.
   */
  function submitReplay() {
    const r = pendingReplay;
    pendingReplay = null;
    if (!r) return;
    // 제출 하나면 된다 — 서버가 이 기록을 방에 흘려주므로 관전자도 받아 간다
    send({
      t: "replay",
      matchId: r.match.matchId,
      seed: r.seed,
      handling: r.handling,
      frames: r.frames,
      keys: r.keys,
      garbage: r.garbage,
      fingerprint: r.fingerprint,
      stats: r.stats,
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

    // 상대 미러도 받은 데까지 함께 굴린다
    for (const m of mirrors.values()) {
      if (m.advance() > 0) m.game.events.length = 0;
    }

    if (game.isGameOver()) {
      log("톱아웃 — ko 신고");
      flushStream(); // 마지막 조각까지 남들 화면에 닿도록
      send({ t: "ko" });
      stopMatch();
      return;
    }

    streamAccum++;
    if (streamAccum >= STREAM_FRAMES) {
      streamAccum = 0;
      flushStream();
    }
    // 스트림이 먼저 나간 뒤에 보낸다 — 순서가 뒤집히면 받는 쪽 미러가
    // 키프레임으로 앞질러 간 다음 지나간 입력을 다시 먹는다
    keyframeAccum++;
    if (keyframeAccum >= KEYFRAME_FRAMES) {
      keyframeAccum = 0;
      sendGame({ t: "full", frame: recorder.frame, snap: game.serialize() });
    }
  }

  /**
   * 계획 고스트를 띄운다. 판정·리플레이 검증에는 전혀 끼지 않는 표시 전용이다.
   * 놓인 자리는 서버가 알아서 지우고, 판이 끝날 때도 서버가 정리한다.
   */
  function publishPlan(ghosts) {
    const key = JSON.stringify(ghosts);
    if (key === shownPlan) return; // 같은 그림을 반복해 보낼 이유가 없다
    shownPlan = key;
    // 제어 메시지다(relay가 아니다) — 서버가 상태를 들고 있으면서 방에 뿌리고,
    // 그 자리에 조각이 놓이면 알아서 걷어낸다.
    send({ t: "plan", set: ghosts });
  }

  /** 한 프레임의 조작을 만든다 */
  function think() {
    // 카운트다운 중이거나 조각이 아직 없으면 아무것도 하지 않는다
    if (game.cur === Piece.None) {
      plan = null;
      return EMPTY_CMD;
    }
    if (!plan) {
      plan = bestPlacement(game);
      // 새 조각을 잡을 때마다 앞으로의 계획을 방에 띄운다(표시 전용)
      publishPlan(settings.planDepth > 0 ? planAhead(game, settings.planDepth) : []);
    }
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
          const h = m.game.board.highestRow();
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
