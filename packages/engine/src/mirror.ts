import { Game } from "./game.js";
import type { GameSnapshot } from "./game.js";
import { ReplayPlayer } from "./replay.js";
import type { ReplayGarbage, ReplayKeys } from "./replay.js";
import type { Handling, RuleSet } from "./types.js";

// ============================================================================
// BoardMirror — 남의 보드를 내 쪽에서 그대로 돌려 보여주는 장치.
//
// 상대가 보내는 것은 보드가 아니라 **누른 키**다. 같은 시드·같은 감도로 같은
// 입력을 먹이면 같은 판이 나오므로(엔진이 결정론적이라 성립한다), 받는 쪽에서
// 다시 돌리면 상대 화면을 프레임 단위로 재현할 수 있다.
//
// 보드를 통째로 보내는 것보다 트래픽이 두 자릿수 배로 적고, 스냅샷 사이가
// 멈춰 보이던 문제도 사라진다 — 미러도 진짜 게임이라 조각이 실제로 떨어진다.
//
// 진행은 "받은 데까지"만 한다. 상대가 알려준 `upto`를 넘어서 돌면 아직 오지
// 않은 입력을 없는 셈 치고 돌게 되어 어긋나므로, 스트림이 끊기면 그 자리에
// 멈춰 서서 기다린다.
// ============================================================================

/** 이만큼 밀리면 한 틱에 여러 프레임을 돌려 따라잡는다 */
const CATCHUP_LEAD = 6;
const CATCHUP_STEPS = 3;
/** 순단·탭 복귀처럼 크게 밀렸을 때 */
const SPRINT_LEAD = 120;
const SPRINT_STEPS = 20;
/**
 * 키프레임으로 되돌릴 기준. 몇 프레임 뒤처진 정도로 매번 상태를 갈아끼우면
 * 그때마다 화면이 튀므로, 따라잡을 수 없을 만큼 벌어졌을 때만 쓴다.
 */
const RESYNC_LEAD = 12;
/**
 * 조각 수가 이만큼까지 벌어지는 건 지연으로 설명된다. 넘어가면 어긋난 것이다.
 * 스트림이 4프레임마다 오므로 그 사이에 놓일 수 있는 조각은 많아야 한둘이다.
 */
const DRIFT_TOLERANCE = 2;

export interface MirrorOptions {
  rule: RuleSet;
  /** 이 사람이 쓰는 감도 — 다르면 같은 키에도 다르게 움직인다 */
  handling: Handling;
  seed: number;
  simRate: number;
  /** 방이 정한 공격 배수(성적 표시용) */
  attackMul?: number;
}

/** 미러가 지금 무엇으로 굴러가는지 */
type MirrorMode =
  /** 아직 아무것도 못 받았다 */
  | "idle"
  /** 입력 스트림을 따라 돈다(정상) */
  | "stream"
  /** 보드 스냅샷만 얹는다(입력을 흘리지 않는 옛 봇) */
  | "snapshot";

export class BoardMirror {
  private player: ReplayPlayer;
  private mode: MirrorMode = "idle";

  constructor(opts: MirrorOptions) {
    this.player = new ReplayPlayer({
      rule: opts.rule,
      handling: opts.handling,
      seed: opts.seed,
      keys: [] as ReplayKeys,
      garbage: [] as ReplayGarbage,
      frames: 0,
      simRate: opts.simRate,
    });
    this.player.game.attackMultiplier = opts.attackMul ?? 1;
  }

  get game(): Game {
    return this.player.game;
  }

  get frame(): number {
    return this.player.frame;
  }

  /** 스냅샷만 오는 상대인가 — 그러면 조각이 뚝뚝 끊겨 보인다 */
  get snapshotOnly(): boolean {
    return this.mode === "snapshot";
  }

  /** 아직 따라잡지 못한 프레임 수 */
  get behind(): number {
    return Math.max(0, this.player.frames - this.player.frame);
  }

  /**
   * 상대가 흘려보낸 입력을 이어 붙인다.
   * `upto`까지는 빠짐없이 왔다는 뜻이라 거기까지 진행할 수 있다.
   */
  feed(upto: number, keys?: readonly number[], garbage?: readonly number[]): void {
    // 스냅샷만 보내던 상대가 중간에 입력을 흘리기 시작해도 갈아타지 않는다 —
    // 지금 상태가 어느 프레임의 것인지 알 수 없어 이어 돌릴 근거가 없다.
    if (this.mode === "snapshot") return;
    this.mode = "stream";
    this.player.extend(upto, keys, garbage);
  }

  /**
   * 상태 키프레임.
   *
   * 두 경우에 받아 적는다.
   *
   *  1. **프레임이 크게 밀렸을 때** — 입력이 통째로 빈 구간(순단)은 따라 돌
   *     방법이 없으므로 상태를 그대로 받아 이어 간다.
   *  2. **내용이 어긋났을 때** — 프레임은 맞는데 판이 다르다면 상대가 나와
   *     다른 조건으로 돌고 있다는 뜻이다(엔진 버전이 달라 룰 하나를 무시하는
   *     봇 같은 경우). 그대로 두면 미러가 제 갈 길로 흘러가 **그럴듯한 가짜
   *     판**을 그린다 — 어긋난 줄도 모르고 보게 되므로 진짜 상태로 되돌린다.
   */
  keyframe(frame: number, snap: GameSnapshot): void {
    if (this.mode === "snapshot") {
      this.player.game.deserialize(snap);
      return;
    }
    if (this.mode === "stream" && !this.stale(frame, snap)) return;
    this.player.syncTo(snap, frame);
    this.mode = "stream";
  }

  /** 이 키프레임으로 되돌려야 하는 상태인가 */
  private stale(frame: number, snap: GameSnapshot): boolean {
    if (frame > this.player.frame + RESYNC_LEAD) return true;
    const theirs = snap?.stats?.piecesPlaced;
    if (typeof theirs !== "number") return false;
    const mine = this.player.game.stats.piecesPlaced;
    /*
      미러는 스트림이 도착하는 만큼 늘 몇 프레임 뒤에 있으므로, 그 사이에 조각이
      놓였으면 상대가 한둘 앞서는 건 정상이다. 그 폭을 넘어서거나 미러가 오히려
      앞서 있다면 지연으로는 설명되지 않는다 — 어긋난 것이다.
    */
    return mine > theirs || theirs - mine > DRIFT_TOLERANCE;
  }

  /** 옛 방식(보드 스냅샷만 보내는 봇) — 받은 그대로 얹는다 */
  snapshot(snap: GameSnapshot): void {
    this.mode = "snapshot";
    this.player.game.deserialize(snap);
  }

  /**
   * 한 틱 진행한다. 밀린 만큼은 조금씩 빨리 감아 따라잡되 한 번에 몰아
   * 돌리지는 않는다(그러면 조각이 순간이동하는 것처럼 보인다).
   *
   * @returns 실제로 진행한 프레임 수. 0이면 받은 데까지 다 돈 것이다.
   */
  advance(): number {
    if (this.mode !== "stream") return 0;
    const behind = this.behind;
    if (behind <= 0) return 0;
    const budget =
      behind > SPRINT_LEAD ? SPRINT_STEPS : behind > CATCHUP_LEAD ? CATCHUP_STEPS : 1;
    let n = 0;
    for (let i = 0; i < budget; i++) {
      if (!this.player.step()) break;
      n++;
    }
    return n;
  }
}
