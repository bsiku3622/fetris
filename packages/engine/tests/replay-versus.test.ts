import { describe, it, expect } from "vitest";
import { Game } from "../src/game.js";
import type { InputCommands } from "../src/game.js";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "../src/config.js";
import {
  runReplay,
  fingerprint,
  ReplayRecorder,
  ReplayAction,
  MatchReplayPlayer,
  verifyMatchReplayFile,
  MATCH_REPLAY_FORMAT,
} from "../src/replay.js";
import type { MatchReplayFile } from "../src/replay.js";

// ============================================================================
// 대전 리플레이 — 키 입력만으로는 판이 결정되지 않는다.
//
// 상대가 보낸 가비지는 바깥에서 들어오는 입력이라, 기록에 함께 담기지 않으면
// 재현이 어긋난다(= 정상 플레이가 전부 replay-mismatch로 잡힌다).
// ============================================================================

const RULE = { ...STANDARD_RULESET, garbageEnabled: true };
const HANDLING = { ...DEFAULT_HANDLING };
const SEED = 777;
const FRAMES = 300;

/** 프레임 f에 도착하는 가비지(없으면 null) — 결정적으로 만든다 */
function garbageAt(f: number): number[] | null {
  if (f === 40) return [3, 3];
  if (f === 95) return [7, 7, 7, 7];
  if (f === 180) return [0];
  if (f === 181) return [5, 5, 5];
  return null;
}

/** 실제 대전 클라이언트가 하는 일을 흉내낸다 — 입력과 수신 가비지를 함께 기록 */
function playVersus(): { game: Game; recorder: ReplayRecorder } {
  const game = new Game(RULE, HANDLING, SEED);
  const recorder = new ReplayRecorder();
  const cmd: InputCommands = {
    rotateCW: false, rotateCCW: false, rotate180: false,
    hardDrop: false, hold: false, softDropHeld: false,
  };

  for (let f = 0; f < FRAMES; f++) {
    cmd.rotateCW = false;
    cmd.hardDrop = false;
    cmd.hold = false;

    // 가비지 수신은 네트워크 콜백에서 일어난다 — update 전에 즉시 반영되고,
    // 기록기에는 대기로 쌓였다가 다음 commitFrame에서 이번 프레임으로 확정된다.
    const holes = garbageAt(f);
    if (holes) {
      game.receiveGarbage({ holes });
      recorder.pushGarbage(holes);
    }

    if (f % 11 === 0) {
      recorder.push(ReplayAction.MoveRight, true);
      game.pressDir(1);
    }
    if (f % 11 === 5) {
      recorder.push(ReplayAction.MoveRight, false);
      game.releaseDir(1);
    }
    if (f % 8 === 3) {
      recorder.push(ReplayAction.RotateCW, true);
      cmd.rotateCW = true;
    }
    if (f % 13 === 6) {
      recorder.push(ReplayAction.HardDrop, true);
      cmd.hardDrop = true;
    }

    recorder.commitFrame();
    game.update(1, cmd, 9999.5); // 실제 판처럼 벽시계를 넘긴다
    game.events.length = 0;
  }
  return { game, recorder };
}

const opts = (rec: ReplayRecorder, garbage?: number[]) => ({
  rule: RULE,
  handling: HANDLING,
  seed: SEED,
  keys: rec.keys,
  garbage: garbage ?? rec.garbage,
  frames: FRAMES,
  simRate: 60,
});

describe("대전 리플레이", () => {
  it("받은 가비지까지 기록하면 그대로 재현된다", () => {
    const { game, recorder } = playVersus();
    expect(recorder.garbage.length).toBeGreaterThan(0);
    expect(game.stats.piecesPlaced).toBeGreaterThan(0);

    expect(fingerprint(runReplay(opts(recorder)))).toBe(fingerprint(game));
  });

  it("가비지 로그가 빠지면 재현이 어긋난다", () => {
    const { game, recorder } = playVersus();
    expect(fingerprint(runReplay(opts(recorder, [])))).not.toBe(fingerprint(game));
  });

  it("가비지를 줄여서 신고하면 잡힌다", () => {
    const { game, recorder } = playVersus();
    // 첫 청크(=[frame, n, ...holes])만 들어낸 로그
    const n = recorder.garbage[1];
    const trimmed = recorder.garbage.slice(2 + n);
    expect(fingerprint(runReplay(opts(recorder, trimmed)))).not.toBe(fingerprint(game));
  });

  it("기록기는 가비지를 프레임 경계에 맞춰 평탄하게 쌓는다", () => {
    const rec = new ReplayRecorder();
    rec.pushGarbage([2, 2]);
    rec.commitFrame(); // frame 0
    rec.commitFrame(); // frame 1 — 수신 없음
    rec.pushGarbage([4]);
    rec.pushGarbage([9, 9, 9]);
    rec.commitFrame(); // frame 2

    expect(rec.frame).toBe(3);
    expect(rec.garbage).toEqual([
      0, 2, 2, 2,
      2, 1, 4,
      2, 3, 9, 9, 9,
    ]);
  });

  it("손상된 가비지 로그를 만나도 재생이 멈추지 않는다", () => {
    const { recorder } = playVersus();
    // 길이 필드가 남은 배열보다 큰 경우 — 무한 루프나 예외 없이 끝나야 한다
    const broken = [10, 999, 1, 2, 3];
    expect(() => runReplay(opts(recorder, broken))).not.toThrow();
  });
});

// ============================================================================
// 매치 리플레이 — 판 하나에 참가자 전원을 담고 함께 되돌린다.
// ============================================================================

describe("매치 리플레이", () => {
  /** 서로 다른 시드로 둔 두 사람의 기록을 한 판으로 묶는다 */
  function buildMatch() {
    const a = playVersus();
    const b = (() => {
      // 두 번째 참가자는 다른 시드 — sharePieces가 꺼진 방을 흉내낸다
      const game = new Game(RULE, HANDLING, SEED + 1);
      const rec = new ReplayRecorder();
      const cmd = {
        rotateCW: false, rotateCCW: false, rotate180: false,
        hardDrop: false, hold: false, softDropHeld: false,
      };
      for (let f = 0; f < FRAMES; f++) {
        cmd.rotateCW = false;
        cmd.hardDrop = false;
        if (f % 9 === 4) { rec.push(ReplayAction.RotateCW, true); cmd.rotateCW = true; }
        if (f % 21 === 5) { rec.push(ReplayAction.HardDrop, true); cmd.hardDrop = true; }
        rec.commitFrame();
        game.update(1, cmd, 55.5);
        game.events.length = 0;
      }
      return { game, recorder: rec };
    })();

    const file: MatchReplayFile = {
      format: MATCH_REPLAY_FORMAT,
      game: "fetris",
      recordedAt: "2026-07-30T00:00:00.000Z",
      match: { code: "TEST", matchId: 7, winnerId: "p1" },
      rule: RULE,
      handling: HANDLING,
      simRate: 60,
      players: [
        {
          id: "p1", nick: "가", placement: 1, seed: SEED,
          frames: a.recorder.frame, keys: a.recorder.keys.slice(),
          garbage: a.recorder.garbage.slice(), fingerprint: fingerprint(a.game),
        },
        {
          id: "p2", nick: "나", placement: 2, seed: SEED + 1,
          frames: b.recorder.frame, keys: b.recorder.keys.slice(),
          fingerprint: fingerprint(b.game),
        },
      ],
    };
    return { file, a, b };
  }

  it("참가자 전원이 각자 조건으로 함께 재현된다", () => {
    const { file, a, b } = buildMatch();
    const player = new MatchReplayPlayer(file);
    expect(player.boards).toHaveLength(2);

    while (player.step()) { /* 끝까지 */ }

    expect(fingerprint(player.boards[0].game)).toBe(fingerprint(a.game));
    expect(fingerprint(player.boards[1].game)).toBe(fingerprint(b.game));
  });

  it("무결성 검사는 어긋난 사람만 짚어낸다", () => {
    const { file } = buildMatch();
    expect(verifyMatchReplayFile(file).every((r) => r.ok)).toBe(true);

    const tampered: MatchReplayFile = {
      ...file,
      players: [file.players[0], { ...file.players[1], fingerprint: "deadbeef" }],
    };
    const result = verifyMatchReplayFile(tampered);
    expect(result[0].ok).toBe(true);
    expect(result[1].ok).toBe(false);
    expect(result[1].nick).toBe("나");
  });

  it("탐색은 모든 보드를 같은 프레임으로 맞춘다", () => {
    const { file } = buildMatch();
    const player = new MatchReplayPlayer(file);
    player.seek(120);
    expect(player.frame).toBe(120);
    for (const b of player.boards) expect(b.frame).toBe(120);

    // 뒤로 감아도 어긋나지 않는다(처음부터 다시 돌린다)
    player.seek(40);
    for (const b of player.boards) expect(b.frame).toBe(40);
  });

  it("참가자마다 다른 핸들링을 쓸 수 있다", () => {
    const { file } = buildMatch();
    // 감도는 개인 설정이다 — 같은 키 로그라도 DAS/ARR가 다르면 다르게 전개된다.
    // 기본값에서는 눌린 시간이 짧아 자동 반복이 안 걸리므로, 확실히 갈리도록
    // DAS를 최소로 낮춘 참가자를 만든다.
    const solo: MatchReplayFile = {
      ...file,
      players: [{ ...file.players[0], handling: { ...HANDLING, das: 1, arr: 0 } }],
    };
    const base = new MatchReplayPlayer({ ...file, players: [file.players[0]] });
    const shifted = new MatchReplayPlayer(solo);
    while (base.step()) { /* 끝까지 */ }
    while (shifted.step()) { /* 끝까지 */ }
    expect(fingerprint(shifted.boards[0].game)).not.toBe(fingerprint(base.boards[0].game));
  });
});
