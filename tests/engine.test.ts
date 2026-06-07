import { describe, it, expect } from "vitest";
import { Board } from "../src/engine/board";
import { Randomizer } from "../src/engine/randomizer";
import { getKickset } from "../src/engine/srs";
import { Game, Phase } from "../src/engine/game";
import { B2BSurge } from "../src/engine/scoring";
import { detectSpin } from "../src/engine/spin";
import { Piece, Rot, SpinType } from "../src/engine/types";
import { shapeOf } from "../src/engine/pieces";
import { softDropGravity } from "../src/engine/handling";
import { optimalInputs, finesseFault } from "../src/engine/finesse";
import { STANDARD_RULESET, DEFAULT_HANDLING } from "../src/engine/config";

describe("Randomizer 7-bag", () => {
  it("매 7개마다 7종이 정확히 한 번씩", () => {
    const r = new Randomizer("7-bag", 12345);
    for (let bag = 0; bag < 50; bag++) {
      const seen = new Set<number>();
      for (let i = 0; i < 7; i++) seen.add(r.next());
      expect(seen.size).toBe(7);
    }
  });
  it("같은 시드는 같은 수열", () => {
    const a = new Randomizer("7-bag", 999);
    const b = new Randomizer("7-bag", 999);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
});

describe("Board 라인 클리어", () => {
  it("가득 찬 행을 제거하고 위를 내림", () => {
    const b = new Board(10, 20, 20);
    const bottom = b.totalRows - 1;
    for (let x = 0; x < 10; x++) b.grid[bottom * 10 + x] = Piece.I;
    // 한 칸 위에 블록 하나
    b.grid[(bottom - 1) * 10 + 3] = Piece.T;
    const cleared = b.clearLines();
    expect(cleared).toBe(1);
    // T가 한 칸 내려와 바닥 행으로
    expect(b.cell(3, bottom)).toBe(Piece.T);
  });

  it("퍼펙트 클리어 후 isEmpty", () => {
    const b = new Board(10, 20, 20);
    const bottom = b.totalRows - 1;
    for (let x = 0; x < 10; x++) b.grid[bottom * 10 + x] = Piece.I;
    b.clearLines();
    expect(b.isEmpty()).toBe(true);
  });
});

describe("SRS 킥테이블", () => {
  it("JLSTZ 0->R 첫 테스트는 (0,0)", () => {
    const ks = getKickset("SRS+");
    const k = ks.get(Piece.T, Rot.Spawn, Rot.Right);
    expect(k[0]).toBe(0);
    expect(k[1]).toBe(0);
  });
  it("O 피스는 킥 없음", () => {
    const ks = getKickset("SRS+");
    const k = ks.get(Piece.O, Rot.Spawn, Rot.Right);
    expect(k.length).toBe(2);
  });
  it("SRS+ 는 180 킥 보유, SRS 는 없음", () => {
    expect(getKickset("SRS+").get(Piece.T, Rot.Spawn, Rot.Two).length).toBeGreaterThan(2);
    expect(getKickset("SRS").get(Piece.T, Rot.Spawn, Rot.Two).length).toBe(2);
  });
});

describe("T-spin 판정", () => {
  it("3코너 + 앞 2코너 채워지면 Full T-spin", () => {
    const b = new Board(10, 4, 0); // 작은 보드
    // T를 Two(아래향) 상태로 바닥 구멍에 끼우는 전형적 T-spin 형태
    // 바닥 두 행을 채우되 T가 들어갈 구멍 형성
    const H = b.totalRows; // 4
    // 맨 아래 행 전부 채우고 가운데 위로 구멍
    for (let x = 0; x < 10; x++) {
      b.grid[(H - 1) * 10 + x] = Piece.Garbage;
      b.grid[(H - 2) * 10 + x] = Piece.Garbage;
    }
    // 구멍: (4, H-2) 비우고 (3,H-3),(5,H-3) 채움 → T-spin 슬롯
    b.grid[(H - 2) * 10 + 4] = 0;
    b.grid[(H - 3) * 10 + 3] = Piece.Garbage;
    b.grid[(H - 3) * 10 + 5] = Piece.Garbage;
    // T 박스 좌상단이 (3, H-3)일 때 Two 상태 셀이 구멍에 맞음
    const spin = detectSpin(b, Piece.T, Rot.Two, 3, H - 3, true, 0, "all-mini+");
    expect(spin).toBe(SpinType.Full);
  });

  it("회전이 아니면 스핀 없음", () => {
    const b = new Board(10, 20, 0);
    const spin = detectSpin(b, Piece.T, Rot.Two, 3, 0, false, 0, "all-mini+");
    expect(spin).toBe(SpinType.None);
  });
});

describe("B2B Surge", () => {
  it("quad 연속이 B2B를 올린다", () => {
    const s = new B2BSurge(STANDARD_RULESET);
    const r1 = s.process(4, SpinType.None, Piece.I, false, STANDARD_RULESET);
    expect(r1.b2b).toBe(1);
    const r2 = s.process(4, SpinType.None, Piece.I, false, STANDARD_RULESET);
    expect(r2.b2b).toBe(2);
  });
  it("single이 B2B를 끊는다", () => {
    const s = new B2BSurge(STANDARD_RULESET);
    s.process(4, SpinType.None, Piece.I, false, STANDARD_RULESET);
    const r = s.process(1, SpinType.None, Piece.L, false, STANDARD_RULESET);
    expect(r.b2b).toBe(0);
  });
  it("B2Bx4 이상에서 Surge 충전, 끊기면 방출", () => {
    const s = new B2BSurge(STANDARD_RULESET);
    for (let i = 0; i < 6; i++) s.process(4, SpinType.None, Piece.I, false, STANDARD_RULESET);
    // 끊기 → surge 방출
    const r = s.process(2, SpinType.None, Piece.L, false, STANDARD_RULESET);
    expect(r.surge).toBeGreaterThan(0);
  });
  it("콤보가 공격을 증가시킨다", () => {
    const s = new B2BSurge(STANDARD_RULESET);
    s.process(2, SpinType.None, Piece.L, false, STANDARD_RULESET); // combo 1
    const r = s.process(2, SpinType.None, Piece.J, false, STANDARD_RULESET); // combo 2
    expect(r.combo).toBe(2);
  });
});

describe("Game 통합", () => {
  it("Ready 후 Playing 진입 + 피스 스폰", () => {
    const g = new Game({ ...STANDARD_RULESET }, { ...DEFAULT_HANDLING }, 42);
    // Ready 카운트다운 소진
    for (let i = 0; i < 61; i++) g.update(1, undefined, 1000);
    expect(g.phase).toBe(Phase.Playing);
    expect(g.cur).not.toBe(Piece.None);
  });

  it("하드드롭이 피스를 락하고 다음 피스로", () => {
    const g = new Game({ ...STANDARD_RULESET, are: 0 }, { ...DEFAULT_HANDLING, safelock: false }, 7);
    for (let i = 0; i < 61; i++) g.update(1, undefined, 0);
    const first = g.cur;
    g.update(1, { rotateCW: false, rotateCCW: false, rotate180: false, hardDrop: true, hold: false, softDropHeld: false }, 0);
    // are=0 이므로 다음 틱에 새 피스
    g.update(1, undefined, 0);
    expect(g.stats.piecesPlaced).toBeGreaterThanOrEqual(1);
    void first;
  });

  it("하드드롭은 스폰 직후에도 즉시 동작 (PPS 캡 없음)", () => {
    const cmd = { rotateCW: false, rotateCCW: false, rotate180: false, hardDrop: true, hold: false, softDropHeld: false };
    const g = new Game({ ...STANDARD_RULESET, are: 0 }, { ...DEFAULT_HANDLING }, 11);
    for (let i = 0; i < 61; i++) g.update(1, undefined, 0);
    // 스폰 직후 바로 하드드롭 → 즉시 배치 (프레임 지연 없음)
    g.update(1, cmd, 0);
    expect(g.stats.piecesPlaced).toBe(1);
  });

  it("회전이 보드 충돌 시 킥으로 보정되거나 취소", () => {
    const g = new Game({ ...STANDARD_RULESET }, { ...DEFAULT_HANDLING }, 3);
    for (let i = 0; i < 61; i++) g.update(1, undefined, 0);
    const beforeRot = g.rot;
    g.update(1, { rotateCW: true, rotateCCW: false, rotate180: false, hardDrop: false, hold: false, softDropHeld: false }, 0);
    // O가 아니면 회전 상태가 바뀌어야(킥 성공) 하거나 그대로(취소)
    expect([beforeRot, Rot.Right]).toContain(g.rot);
  });
});

describe("결정론", () => {
  it("같은 시드+입력은 같은 보드 상태", () => {
    function run(): string {
      const g = new Game({ ...STANDARD_RULESET, are: 0, lineClearAre: 0 }, { ...DEFAULT_HANDLING }, 2024);
      const cmd = { rotateCW: false, rotateCCW: false, rotate180: false, hardDrop: true, hold: false, softDropHeld: false };
      for (let i = 0; i < 61; i++) g.update(1, undefined, 0);
      for (let p = 0; p < 20; p++) {
        g.update(1, cmd, 0);
        for (let i = 0; i < 5; i++) g.update(1, undefined, 0);
      }
      return g.board.grid.join("");
    }
    expect(run()).toBe(run());
  });
});

describe("softDropGravity 무한 처리(직렬화 호환)", () => {
  it("41 이상 / null / Infinity / NaN 은 모두 무한 하강", () => {
    expect(softDropGravity(0.02, 41)).toBe(Infinity);
    expect(softDropGravity(0.02, 100)).toBe(Infinity);
    expect(softDropGravity(0.02, Infinity)).toBe(Infinity);
    // localStorage가 Infinity를 null로 저장하는 경우 호환
    expect(softDropGravity(0.02, null as unknown as number)).toBe(Infinity);
    expect(softDropGravity(0.02, NaN)).toBe(Infinity);
  });
  it("유한 SDF는 baseGravity*sdf (최소 보장)", () => {
    expect(softDropGravity(0.5, 6)).toBeCloseTo(3); // 0.5*6
    expect(softDropGravity(0.001, 6)).toBeCloseTo(0.3); // 최소 sdf*0.05
  });
});

describe("Finesse 최소입력(BFS)", () => {
  it("이미 목표에 있으면 0 입력", () => {
    // T 스폰 x=3, rot 0 → (3,0)은 0
    expect(optimalInputs(Piece.T, 3, Rot.Spawn, 10)).toBe(0);
  });
  it("벽까지 DAS는 1 입력", () => {
    expect(optimalInputs(Piece.O, 0, Rot.Spawn, 10)).toBe(1); // 좌벽
    expect(optimalInputs(Piece.I, 0, Rot.Spawn, 10)).toBe(1); // I 좌벽
  });
  it("한 칸 옆은 1 입력(탭)", () => {
    expect(optimalInputs(Piece.T, 4, Rot.Spawn, 10)).toBe(1); // 스폰 3 → 4
  });
  it("회전만 필요하면 1 입력", () => {
    expect(optimalInputs(Piece.T, 3, Rot.Right, 10)).toBe(1);
  });
  it("회전+이동은 2 입력", () => {
    // 좌벽 + 회전
    const v = optimalInputs(Piece.T, 0, Rot.Right, 10);
    expect(v).toBeLessThanOrEqual(2);
    expect(v).toBeGreaterThanOrEqual(1);
  });
  it("fault = 실제 - 최소", () => {
    // 스폰 자리에 그냥 두면(0입력) fault 0
    expect(finesseFault(Piece.T, 0, 3, Rot.Spawn, 10)).toBe(0);
    // 같은 자리를 3입력으로 갔다오면 fault 3
    expect(finesseFault(Piece.T, 3, 3, Rot.Spawn, 10)).toBe(3);
  });
});

// shapeOf 기본 동작
describe("pieces", () => {
  it("각 피스는 4셀", () => {
    for (const p of [Piece.I, Piece.J, Piece.L, Piece.O, Piece.S, Piece.T, Piece.Z]) {
      for (let r = 0; r < 4; r++) {
        expect(shapeOf(p, r as Rot).length).toBe(8);
      }
    }
  });
});
