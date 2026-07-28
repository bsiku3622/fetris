import { Piece } from "./types";
import { ALL_PIECES } from "./pieces";
import type { RandomizerName } from "./types";

// ============================================================================
// 랜더마이저 — 큐를 채운다. 결정론을 위해 시드 가능한 PRNG(mulberry32) 사용.
// 같은 시드 → 같은 피스열 (리플레이/테스트/디버그에 필수).
// ============================================================================

/** 빠르고 시드 가능한 PRNG. [0,1) 반환. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Randomizer 전체 상태 스냅샷(undo/Zen 이어하기 — desync 없는 정확 복원용) */
export interface RandomizerState {
  a: number; // rng 내부 상태
  bag: Piece[];
  bagIndex: number;
  history: Piece[];
}

export class Randomizer {
  private a: number; // mulberry32 내부 상태(스냅샷 가능하도록 직접 보유)
  private bag: Piece[] = [];
  private bagIndex = 0;
  private type: RandomizerName;
  private history: Piece[] = []; // classic 모드용

  constructor(type: RandomizerName, seed: number) {
    this.type = type;
    this.a = seed >>> 0;
  }

  /** mulberry32 한 스텝. [0,1) 반환. (상태를 this.a에 보존해 스냅샷 가능) */
  private rng(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  reset(seed: number): void {
    this.a = seed >>> 0;
    this.bag = [];
    this.bagIndex = 0;
    this.history = [];
  }

  /** 전체 상태 스냅샷(deep copy) */
  snapshot(): RandomizerState {
    return { a: this.a, bag: this.bag.slice(), bagIndex: this.bagIndex, history: this.history.slice() };
  }

  /** 스냅샷 복원 */
  restore(s: RandomizerState): void {
    this.a = s.a >>> 0;
    this.bag = s.bag.slice();
    this.bagIndex = s.bagIndex;
    this.history = s.history.slice();
  }

  private shuffle(arr: Piece[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }

  /** 다음 피스 1개 반환 */
  next(): Piece {
    switch (this.type) {
      case "7-bag":
        return this.nextBag(1);
      case "14-bag":
        return this.nextBag(2);
      case "pairs":
        return this.nextPairs();
      case "classic":
        return this.nextClassic();
      case "random":
        return ALL_PIECES[Math.floor(this.rng() * 7)];
      default:
        return this.nextBag(1);
    }
  }

  private nextBag(copies: number): Piece {
    if (this.bagIndex >= this.bag.length) {
      this.bag = [];
      for (let c = 0; c < copies; c++) this.bag.push(...ALL_PIECES);
      this.shuffle(this.bag);
      this.bagIndex = 0;
    }
    return this.bag[this.bagIndex++];
  }

  // pairs: 같은 피스 2개씩 들어간 백을 섞음
  private nextPairs(): Piece {
    if (this.bagIndex >= this.bag.length) {
      const pick = ALL_PIECES[Math.floor(this.rng() * 7)];
      this.bag = [pick, pick];
      this.bagIndex = 0;
    }
    return this.bag[this.bagIndex++];
  }

  // classic: 메모리리스 + 1회 재시도(NES 스타일 중복 회피)
  private nextClassic(): Piece {
    let pick = ALL_PIECES[Math.floor(this.rng() * 7)];
    const last = this.history[this.history.length - 1];
    if (pick === last) {
      pick = ALL_PIECES[Math.floor(this.rng() * 7)];
    }
    this.history.push(pick);
    if (this.history.length > 4) this.history.shift();
    return pick;
  }
}

/** 큐 — 랜더마이저에서 미리 당겨 NEXT 표시분을 항상 채워둔다. */
export class Queue {
  private rand: Randomizer;
  private buf: Piece[] = [];
  private minAhead: number;

  constructor(rand: Randomizer, minAhead: number) {
    this.rand = rand;
    this.minAhead = Math.max(minAhead, 7);
    this.refill();
  }

  reset(seed: number): void {
    this.rand.reset(seed);
    this.buf = [];
    this.refill();
  }

  private refill(): void {
    while (this.buf.length < this.minAhead) {
      this.buf.push(this.rand.next());
    }
  }

  /** 다음 피스 꺼내기 */
  shift(): Piece {
    const p = this.buf.shift()!;
    this.refill();
    return p;
  }

  /** NEXT 미리보기 (복사 없이 슬라이스 — count개) */
  peek(count: number): Piece[] {
    return this.buf.slice(0, count);
  }

  /** undo/이어하기용: 버퍼 + 랜더마이저 내부까지 전체 스냅샷(정확 복원) */
  snapshot(): QueueSnapshot {
    return { buf: this.buf.slice(), rand: this.rand.snapshot() };
  }

  /** 전체 스냅샷 복원 — 랜더마이저 내부 상태까지 되돌려 가방 desync 방지 */
  restore(s: QueueSnapshot): void {
    this.buf = s.buf.slice();
    this.rand.restore(s.rand);
  }

  /** 레거시 Zen 저장(버퍼만) 복원 — 구버전 localStorage 호환 */
  restoreBuffer(buf: Piece[]): void {
    this.buf = buf.slice();
  }
}

/** 큐 전체 스냅샷(버퍼 + 랜더마이저 상태) */
export interface QueueSnapshot {
  buf: Piece[];
  rand: RandomizerState;
}
