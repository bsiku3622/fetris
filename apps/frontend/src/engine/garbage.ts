import { mulberry32 } from "./randomizer";
import type { GarbageChunk, GarbageHoleMode } from "./types";

// ============================================================================
// 가비지 hole 패턴 생성 — 송신측(sender-authoritative)이 결정해 상대에게 보낸다.
// 시드 기반 PRNG라 결정론적(리플레이/테스트 가능). messiness로 구멍 연속성 제어.
// ============================================================================

/** 송신측 가비지 구멍 생성기. messiness 확률로 줄마다 구멍을 새로 뽑는다. */
export class GarbageGen {
  private rng: () => number;
  private cols: number;
  private messiness: number;
  private lastHole = -1;

  constructor(seed: number, cols: number, messiness: number) {
    this.rng = mulberry32(seed >>> 0);
    this.cols = cols;
    this.messiness = messiness;
  }

  reset(seed: number): void {
    this.rng = mulberry32(seed >>> 0);
    this.lastHole = -1;
  }

  /**
   * lines줄짜리 구멍 배열 생성.
   *  - clean(기본, TETR.IO "change on attack"): 공격마다 구멍 컬럼을 새로 뽑는다 → 공격이 올 때마다
   *           우물 위치가 바뀌어 치즈처럼 파야 한다. 한 공격 안에서는 깔끔(같은 컬럼)하되
   *           messiness 확률로 줄별로 컬럼이 흔들린다(within-attack scatter, 기본 0).
   *  - cheese: 줄마다 새 컬럼(최대 치즈).
   */
  holes(lines: number, mode: GarbageHoleMode = "clean"): number[] {
    const out: number[] = [];
    if (mode === "cheese") {
      for (let i = 0; i < lines; i++) {
        this.lastHole = Math.floor(this.rng() * this.cols);
        out.push(this.lastHole);
      }
      return out;
    }
    // clean: 이번 공격의 기준 컬럼을 매번 새로 뽑는다(직전 공격과 같을 확률은 1/cols).
    let hole = Math.floor(this.rng() * this.cols);
    this.lastHole = hole;
    for (let i = 0; i < lines; i++) {
      if (i > 0 && this.rng() < this.messiness) {
        hole = Math.floor(this.rng() * this.cols);
        this.lastHole = hole;
      }
      out.push(hole);
    }
    return out;
  }
}

/** 큐에 쌓인 가비지 총 줄 수 */
export function queuedLines(queue: GarbageChunk[]): number {
  let n = 0;
  for (let i = 0; i < queue.length; i++) n += queue[i].holes.length;
  return n;
}

/**
 * 들어온 공격을 큐로 상쇄. amount줄만큼 큐 앞에서 제거하고, 상쇄하고 남은 공격을 반환.
 * 부분 상쇄(묶음 일부만 지워짐)도 처리한다. queue는 제자리에서 변형된다.
 */
export function cancelGarbage(queue: GarbageChunk[], amount: number): number {
  let out = amount;
  while (out > 0 && queue.length > 0) {
    const chunk = queue[0];
    if (chunk.holes.length <= out) {
      out -= chunk.holes.length;
      queue.shift();
    } else {
      chunk.holes.splice(0, out);
      out = 0;
    }
  }
  return out;
}
