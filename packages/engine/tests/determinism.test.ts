import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Game } from "../src/game.js";
import type { InputCommands } from "../src/game.js";
import { BlitzScore } from "../src/scoring.js";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "../src/config.js";

// ============================================================================
// 결정론 보증 — 서버 사이드 리플레이 검증의 전제.
// 같은 시드 + 같은 입력이면 어떤 JS 엔진에서도 같은 결과가 나와야 한다.
// ============================================================================

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/** 프레임 번호로부터 결정적으로 입력을 만든다(의사난수 없이 재현 가능한 시퀀스) */
function inputAt(frame: number): InputCommands | undefined {
  if (frame % 17 === 0) return { rotateCW: true, rotateCCW: false, rotate180: false, hardDrop: false, hold: false, softDropHeld: false };
  if (frame % 23 === 0) return { rotateCW: false, rotateCCW: true, rotate180: false, hardDrop: false, hold: false, softDropHeld: false };
  if (frame % 11 === 0) return { rotateCW: false, rotateCCW: false, rotate180: false, hardDrop: true, hold: false, softDropHeld: false };
  if (frame % 31 === 0) return { rotateCW: false, rotateCCW: false, rotate180: false, hardDrop: false, hold: true, softDropHeld: false };
  if (frame % 5 === 0) return { rotateCW: false, rotateCCW: false, rotate180: false, hardDrop: false, hold: false, softDropHeld: true };
  return undefined;
}

function runGame(seed: number, frames: number): string {
  const g = new Game({ ...STANDARD_RULESET }, { ...DEFAULT_HANDLING }, seed);
  for (let f = 0; f < frames; f++) {
    g.update(1, inputAt(f), 0);
    g.events.length = 0;
  }
  return JSON.stringify(g.serialize());
}

describe("결정론", () => {
  it("같은 시드·입력이면 동일한 최종 상태가 나온다", () => {
    const a = runGame(12345, 900);
    const b = runGame(12345, 900);
    expect(a).toBe(b);
  });

  it("시드가 다르면 상태도 갈린다 (테스트가 자명하게 통과하지 않도록)", () => {
    const a = runGame(12345, 900);
    const c = runGame(54321, 900);
    expect(a).not.toBe(c);
  });

  it("분할 스텝(simRate 120/240)도 그 자체로 재현 가능하다", () => {
    // 주의: update(1) 한 번과 update(0.5) 두 번은 결과가 다르다 —
    // 조각이 잠기는 타이밍과 입력 적용 지점이 갈리기 때문이다.
    // 따라서 리플레이 검증은 반드시 기록 당시의 simRate로 재현해야 하며,
    // simRate를 리플레이 메타데이터에 함께 남겨야 한다.
    const runSplit = (seed: number) => {
      const g = new Game({ ...STANDARD_RULESET }, { ...DEFAULT_HANDLING }, seed);
      for (let f = 0; f < 300; f++) {
        g.update(0.5, inputAt(f), 0);
        g.update(0.5, undefined, 0);
        g.events.length = 0;
      }
      return JSON.stringify(g.serialize());
    };
    expect(runSplit(777)).toBe(runSplit(777));
  });

  it("BLITZ 중력 테이블이 원래 공식과 일치한다", () => {
    const blitz = new BlitzScore();
    for (let level = 1; level <= 24; level++) {
      blitz.level = level;
      expect(blitz.gravity()).toBe(Math.min(20, 0.02 * Math.pow(1.35, level - 1)));
    }
    // 상한 구간
    blitz.level = 25;
    expect(blitz.gravity()).toBe(20);
    blitz.level = 999;
    expect(blitz.gravity()).toBe(20);
  });

  it("엔진 소스에 비결정적 API가 없다", () => {
    // Math.log/Math.pow는 엔진 구현 재량이라 사전 계산 테이블로 대체했다.
    // Math.random·시간 API는 재현을 원천적으로 깨뜨린다.
    const banned = [
      /\bMath\.random\s*\(/,
      /\bMath\.pow\s*\(/,
      /\bMath\.log\s*\(/,
      /\bMath\.exp\s*\(/,
      /\bMath\.(sin|cos|tan|atan2?|cbrt)\s*\(/,
      /\bDate\.now\s*\(/,
      /\bperformance\.now\s*\(/,
    ];
    const offenders: string[] = [];

    for (const file of readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"))) {
      // loop.ts는 실시간 렌더 스케줄러라 시뮬레이션 결과에 관여하지 않는다(예외).
      if (file === "loop.ts") continue;
      const src = readFileSync(`${SRC_DIR}/${file}`, "utf8");
      // 주석 제거 후 검사 — 설명에 함수 이름이 등장하는 건 허용
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const re of banned) {
        const hit = code.match(re);
        if (hit) offenders.push(`${file}: ${hit[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
