import { describe, it, expect } from "vitest";
import { B2BSurge } from "../src/scoring.js";
import { Piece, SpinType } from "../src/types.js";
import { STANDARD_RULESET } from "../src/config.js";

// TETR.IO 시즌2 B2B Charging + Surge 검증
describe("B2BSurge — 시즌2 충전/방출", () => {
  const rule = { ...STANDARD_RULESET, b2bMode: "surge" as const, garbageMultiplier: 1 };

  it("충전 시작 전(B2Bx1)엔 퀘드가 base+1을 송신", () => {
    const s = new B2BSurge(rule);
    const r1 = s.process(4, SpinType.None, Piece.I, false, rule); // 첫 퀘드: base4 + 평시 B2B +1, combo 0 → 5
    expect(r1.attack).toBe(5);
    expect(s.b2b).toBe(1);
    expect(s.surgeCharge).toBe(0);
  });

  it("B2Bx8에서 서지 메터 = 8, 끊기면 정확히 8 방출", () => {
    const s = new B2BSurge(rule);
    for (let i = 0; i < 8; i++) s.process(4, SpinType.None, Piece.I, false, rule); // 8연속 퀘드
    expect(s.b2b).toBe(8);
    expect(s.surgeCharge).toBe(8); // (예전 버그: 9였음)
    const r = s.process(1, SpinType.None, Piece.I, false, rule); // 싱글 → B2B 끊김
    expect(r.surge).toBe(8);
    expect(s.b2b).toBe(0);
    expect(s.surgeCharge).toBe(0);
  });

  it("퍼펙트 클리어는 난이도 클리어가 아니어도 B2B로 친다(시즌2)", () => {
    const s = new B2BSurge(rule);
    const r = s.process(2, SpinType.None, Piece.I, true, rule); // 더블 + 보드 비움(PC)
    expect(r.b2bEligible).toBe(true);
    expect(s.b2b).toBe(1);
  });
});
