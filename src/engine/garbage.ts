import { mulberry32 } from "./randomizer";
import type { GarbageChunk } from "./types";

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

  /** lines줄짜리 구멍 배열 생성. 첫 줄은 항상 새로, 이후는 messiness 확률로 변경. */
  holes(lines: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < lines; i++) {
      if (this.lastHole < 0 || this.rng() < this.messiness) {
        this.lastHole = Math.floor(this.rng() * this.cols);
      }
      out.push(this.lastHole);
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
