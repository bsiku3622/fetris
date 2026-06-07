import { Piece } from "../engine/types";

// ============================================================================
// 렌더 테마 — funky-ui 네온 팔레트를 피스 색으로. 캔버스는 실제 hex가 필요하므로
// 여기서 토큰 값을 1:1로 정의(funky-ui design.md 기준).
// ============================================================================

export const FUNKY = {
  bg: "#fff5d1",
  surface: "#ffffff",
  sunken: "#fff0b8",
  ink: "#222222",
  inkMuted: "#6f6a52",
  border: "#000000",
  pink: "#ff4eba",
  purple: "#7828c8",
  cyan: "#3decfd",
  yellow: "#ffd500",
  orange: "#ff9100",
  sky: "#00c8ff",
  green: "#00c22a",
  danger: "#ff3b3b",
  blue: "#2f6bff", // J 전용 로열 블루 (I 청록과 확실히 구분)
  // 게임 다크 스테이지 — 네온 블록이 빛나게
  stageTop: "#241b38",
  stageBottom: "#140f22",
  playfield: "#1a1528",
  playfieldEdge: "#0e0a18",
  gridLine: "rgba(255,255,255,0.13)",
} as const;

/** 피스별 면색 — 표준 테트리스 색배치(직관적). I=청록, J=파랑, L=주황, O=노랑, S=초록, T=보라, Z=빨강. */
export const PIECE_COLORS: Record<number, string> = {
  [Piece.I]: FUNKY.cyan,
  [Piece.J]: FUNKY.blue,
  [Piece.L]: FUNKY.orange,
  [Piece.O]: FUNKY.yellow,
  [Piece.S]: FUNKY.green,
  [Piece.T]: FUNKY.purple,
  [Piece.Z]: FUNKY.danger,
  [Piece.Garbage]: "#9a937a",
};

/** 약간 어둡게(블록 하단 엣지 음영용) */
export function darken(hex: string, amount = 0.25): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.round(r * (1 - amount));
  g = Math.round(g * (1 - amount));
  b = Math.round(b * (1 - amount));
  return `rgb(${r},${g},${b})`;
}

export function lighten(hex: string, amount = 0.3): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  r = Math.round(r + (255 - r) * amount);
  g = Math.round(g + (255 - g) * amount);
  b = Math.round(b + (255 - b) * amount);
  return `rgb(${r},${g},${b})`;
}
