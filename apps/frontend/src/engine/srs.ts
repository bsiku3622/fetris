import { Piece, Rot } from "./types";

// ============================================================================
// SRS / SRS+ / SRS-X 킥 테이블
// 주의: 아래 모든 오프셋은 "표준 SRS 표기(y-up: 위가 +)"로 저장한다.
// 출처(Hard Drop / tetris.wiki / TETR.IO Wiki)와 1:1 대조 가능하게 하기 위함.
// 보드는 y-down이므로, 실제 회전 적용 시 dy 부호를 뒤집어 사용한다(applyKick 참고).
//
// 인덱스 키: from*4 + to (Rot 열거형 값 사용)
// 각 항목은 [dx,dy]* 테스트 시퀀스(평탄 숫자 배열).
// ============================================================================

export type KickList = readonly number[]; // [dx,dy, dx,dy, ...]

function key(from: Rot, to: Rot): number {
  return from * 4 + to;
}

// ---- JLSTZ 공통 (가이드라인 표준, y-up) -----------------------------------
const JLSTZ: Record<number, KickList> = {
  [key(Rot.Spawn, Rot.Right)]: [0, 0, -1, 0, -1, 1, 0, -2, -1, -2],
  [key(Rot.Right, Rot.Spawn)]: [0, 0, 1, 0, 1, -1, 0, 2, 1, 2],
  [key(Rot.Right, Rot.Two)]: [0, 0, 1, 0, 1, -1, 0, 2, 1, 2],
  [key(Rot.Two, Rot.Right)]: [0, 0, -1, 0, -1, 1, 0, -2, -1, -2],
  [key(Rot.Two, Rot.Left)]: [0, 0, 1, 0, 1, 1, 0, -2, 1, -2],
  [key(Rot.Left, Rot.Two)]: [0, 0, -1, 0, -1, -1, 0, 2, -1, 2],
  [key(Rot.Left, Rot.Spawn)]: [0, 0, -1, 0, -1, -1, 0, 2, -1, 2],
  [key(Rot.Spawn, Rot.Left)]: [0, 0, 1, 0, 1, 1, 0, -2, 1, -2],
};

// ---- I 피스 (TETR.IO SRS+ : y축 대칭, y-up) --------------------------------
// SRS+는 I 킥을 y축 대칭으로 보정한다. 아래는 대칭화된 SRS+ I 킥.
const I_SRS_PLUS: Record<number, KickList> = {
  [key(Rot.Spawn, Rot.Right)]: [0, 0, -2, 0, 1, 0, -2, -1, 1, 2],
  [key(Rot.Right, Rot.Spawn)]: [0, 0, 2, 0, -1, 0, 2, 1, -1, -2],
  [key(Rot.Right, Rot.Two)]: [0, 0, -1, 0, 2, 0, -1, 2, 2, -1],
  [key(Rot.Two, Rot.Right)]: [0, 0, 1, 0, -2, 0, 1, -2, -2, 1],
  [key(Rot.Two, Rot.Left)]: [0, 0, 2, 0, -1, 0, 2, 1, -1, -2],
  [key(Rot.Left, Rot.Two)]: [0, 0, -2, 0, 1, 0, -2, -1, 1, 2],
  [key(Rot.Left, Rot.Spawn)]: [0, 0, 1, 0, -2, 0, 1, -2, -2, 1],
  [key(Rot.Spawn, Rot.Left)]: [0, 0, -1, 0, 2, 0, -1, 2, 2, -1],
};

// ---- 180도 회전 킥 (TETR.IO SRS+ 동작 호환 기본형, y-up) -------------------
// from*4+to 에서 to = (from+2)%4
const JLSTZ_180: Record<number, KickList> = {
  [key(Rot.Spawn, Rot.Two)]: [0, 0, 0, 1, 1, 1, -1, 1, 1, 0, -1, 0],
  [key(Rot.Two, Rot.Spawn)]: [0, 0, 0, -1, -1, -1, 1, -1, -1, 0, 1, 0],
  [key(Rot.Right, Rot.Left)]: [0, 0, 1, 0, 1, 2, 1, 1, 0, 2, 0, 1],
  [key(Rot.Left, Rot.Right)]: [0, 0, -1, 0, -1, 2, -1, 1, 0, 2, 0, 1],
};
const I_180: Record<number, KickList> = {
  [key(Rot.Spawn, Rot.Two)]: [0, 0, -1, 0, -2, 0, 1, 0, 2, 0],
  [key(Rot.Two, Rot.Spawn)]: [0, 0, 1, 0, 2, 0, -1, 0, -2, 0],
  [key(Rot.Right, Rot.Left)]: [0, 0, 0, 1, 0, 2, 0, -1, 0, -2],
  [key(Rot.Left, Rot.Right)]: [0, 0, 0, 1, 0, 2, 0, -1, 0, -2],
};

// ---- SRS-X 강화 180 (NullpoMino 계열, y-up) --------------------------------
// SRS+ 기반에 더 강력한 180 스핀 킥. 그 외 킥은 SRS와 동일.
const JLSTZ_180_X: Record<number, KickList> = {
  [key(Rot.Spawn, Rot.Two)]: [0, 0, 0, 1, 1, 1, -1, 1, 1, 0, -1, 0, 0, 2, 1, 2, -1, 2],
  [key(Rot.Two, Rot.Spawn)]: [0, 0, 0, -1, -1, -1, 1, -1, -1, 0, 1, 0, 0, -2, -1, -2, 1, -2],
  [key(Rot.Right, Rot.Left)]: [0, 0, 1, 0, 1, 2, 1, 1, 0, 2, 0, 1, -1, 0, -1, 2, -1, 1],
  [key(Rot.Left, Rot.Right)]: [0, 0, -1, 0, -1, 2, -1, 1, 0, 2, 0, 1, 1, 0, 1, 2, 1, 1],
};

const EMPTY: KickList = [0, 0];

export interface Kickset {
  /** 90도 또는 180도 회전에 대한 킥 시퀀스 반환. 없으면 [0,0]만. */
  get(piece: Piece, from: Rot, to: Rot): KickList;
}

function build(jlstz: Record<number, KickList>, iTable: Record<number, KickList>, table180: Record<number, KickList>, iTable180: Record<number, KickList>): Kickset {
  return {
    get(piece, from, to) {
      if (piece === Piece.O) return EMPTY;
      const k = key(from, to);
      const is180 = (from + 2) % 4 === to && from !== to;
      if (is180) {
        if (piece === Piece.I) return iTable180[k] ?? EMPTY;
        return table180[k] ?? EMPTY;
      }
      if (piece === Piece.I) return iTable[k] ?? EMPTY;
      return jlstz[k] ?? EMPTY;
    },
  };
}

export const KICKSETS: Record<string, Kickset> = {
  "SRS+": build(JLSTZ, I_SRS_PLUS, JLSTZ_180, I_180),
  "SRS-X": build(JLSTZ, I_SRS_PLUS, JLSTZ_180_X, I_180),
  // 클래식 SRS: I도 비대칭 표준이지만 체감 차이가 작아 SRS+ I를 재사용, 180 없음
  "SRS": build(JLSTZ, I_SRS_PLUS, {}, {}),
  "none": {
    get: () => EMPTY,
  },
};

export function getKickset(name: string): Kickset {
  return KICKSETS[name] ?? KICKSETS["SRS+"];
}
