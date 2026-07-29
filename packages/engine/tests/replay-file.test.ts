import { describe, it, expect } from "vitest";
import { Game } from "../src/game.js";
import type { InputCommands } from "../src/game.js";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "../src/config.js";
import {
  ReplayRecorder,
  ReplayAction,
  REPLAY_FORMAT,
  fingerprint,
  verifyReplayFile,
} from "../src/replay.js";
import type { ReplayFile } from "../src/replay.js";

// ============================================================================
// 내려받은 리플레이 파일이 그대로 재생되는지 — 저장 → JSON 왕복 → 재생 검증.
// ============================================================================

const RULE = { ...STANDARD_RULESET };
const HANDLING = { ...DEFAULT_HANDLING };
const SEED = 20260729;
const FRAMES = 240;

/** 한 판을 두면서 입력을 기록한다 */
function record(): { game: Game; recorder: ReplayRecorder } {
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

    if (f % 9 === 0) {
      recorder.push(ReplayAction.MoveLeft, true);
      game.pressDir(-1);
    }
    if (f % 9 === 4) {
      recorder.push(ReplayAction.MoveLeft, false);
      game.releaseDir(-1);
    }
    if (f % 7 === 2) {
      recorder.push(ReplayAction.RotateCW, true);
      cmd.rotateCW = true;
    }
    if (f % 15 === 8) {
      recorder.push(ReplayAction.HardDrop, true);
      cmd.hardDrop = true;
    }

    recorder.commitFrame();
    game.update(1, cmd, 0);
    game.events.length = 0;
  }
  return { game, recorder };
}

/** 클라이언트가 만드는 것과 같은 파일 */
function buildFile(): ReplayFile {
  const { game, recorder } = record();
  return {
    format: REPLAY_FORMAT,
    game: "fetris",
    recordedAt: new Date().toISOString(),
    match: { code: "AB12", matchId: 3 },
    player: { nick: "재원", placement: 1 },
    rule: RULE,
    handling: HANDLING,
    simRate: 60,
    seed: SEED,
    frames: recorder.frame,
    keys: recorder.keys.slice(),
    fingerprint: fingerprint(game),
    stats: {
      piecesPlaced: game.stats.piecesPlaced,
      lines: game.stats.lines,
      attack: game.stats.attack,
    },
  };
}

describe("리플레이 파일", () => {
  it("JSON으로 저장했다 열어도 그대로 재생된다", () => {
    const file = buildFile();
    // 실제 다운로드 경로와 같이 문자열로 굳혔다가 되읽는다
    const roundTripped = JSON.parse(JSON.stringify(file)) as ReplayFile;

    const { ok, actual } = verifyReplayFile(roundTripped);
    expect(ok).toBe(true);
    expect(actual).toBe(file.fingerprint);
  });

  it("재생에 필요한 조건이 빠짐없이 담긴다", () => {
    const file = buildFile();
    expect(file.format).toBe(REPLAY_FORMAT);
    expect(file.seed).toBe(SEED);
    expect(file.simRate).toBe(60);
    expect(file.rule).toBeTruthy();
    expect(file.handling).toBeTruthy();
    expect(file.frames).toBe(FRAMES);
    expect(file.keys.length).toBeGreaterThan(0);
    expect(file.keys.length % 3).toBe(0); // [frame, action, down] 삼중
  });

  it("파일이 손상되면 재생 결과가 어긋난다", () => {
    const file = buildFile();
    // 중간 입력 하나를 들어낸다
    const mid = Math.floor(file.keys.length / 6) * 3;
    const tampered: ReplayFile = {
      ...file,
      keys: [...file.keys.slice(0, mid), ...file.keys.slice(mid + 3)],
    };
    expect(verifyReplayFile(tampered).ok).toBe(false);
  });

  it("simRate가 바뀌면 재생이 어긋난다", () => {
    const file = buildFile();
    expect(verifyReplayFile({ ...file, simRate: 120 }).ok).toBe(false);
  });

  it("성적이 함께 기록된다", () => {
    const file = buildFile();
    expect(file.stats?.piecesPlaced).toBeGreaterThan(0);
  });
});
