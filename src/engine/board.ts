import { Piece } from "./types";
import type { CellList } from "./pieces";

// ============================================================================
// 보드 — Int8Array 그리드. hot path(충돌/라인클리어)에서 할당 0.
// 좌표: (x=col, y=row). y=0 이 최상단(버퍼 천장). 가시 영역은 아래쪽 rows칸.
// 셀 값 0=빈칸, 1..8 = Piece 색 ID.
// ============================================================================

export class Board {
  readonly cols: number;
  readonly rows: number; // 가시 행
  readonly bufferRows: number;
  readonly totalRows: number;
  readonly grid: Int8Array; // length = cols * totalRows, row-major

  constructor(cols: number, rows: number, bufferRows: number) {
    this.cols = cols;
    this.rows = rows;
    this.bufferRows = bufferRows;
    this.totalRows = rows + bufferRows;
    this.grid = new Int8Array(cols * this.totalRows);
  }

  clearGrid(): void {
    this.grid.fill(0);
  }

  /** 인덱스 계산 */
  idx(x: number, y: number): number {
    return y * this.cols + x;
  }

  cell(x: number, y: number): number {
    return this.grid[y * this.cols + x];
  }

  /** 점유된 최고 셀의 행(없으면 totalRows). 값이 작을수록 높이 쌓인 것. */
  highestRow(): number {
    const { cols, totalRows, grid } = this;
    for (let y = 0; y < totalRows; y++) {
      for (let x = 0; x < cols; x++) if (grid[y * cols + x]) return y;
    }
    return totalRows;
  }

  /**
   * 주어진 형상이 (px,py) 위치에 놓일 때 충돌하는지.
   * 벽/바닥/기존 블록과 겹치면 true. 천장 위(y<0)는 통과 허용(스폰/회전 여유).
   */
  collides(shape: CellList, px: number, py: number): boolean {
    const { cols, totalRows, grid } = this;
    for (let i = 0; i < 8; i += 2) {
      const x = px + shape[i];
      const y = py + shape[i + 1];
      if (x < 0 || x >= cols) return true; // 좌우 벽
      if (y >= totalRows) return true; // 바닥
      if (y < 0) continue; // 천장 위는 허용
      if (grid[y * cols + x] !== 0) return true; // 기존 블록
    }
    return false;
  }

  /** 형상을 보드에 기록(락). */
  place(shape: CellList, px: number, py: number, value: Piece): void {
    const { cols, grid } = this;
    for (let i = 0; i < 8; i += 2) {
      const x = px + shape[i];
      const y = py + shape[i + 1];
      if (y >= 0) grid[y * cols + x] = value;
    }
  }

  /**
   * 가득 찬 행을 찾아 제거하고 위 블록을 내림. 제거된 행 수 반환.
   * clearedRows(옵션)에 제거된 y 좌표를 채워 이펙트에 쓸 수 있다.
   */
  clearLines(clearedRows?: number[]): number {
    const { cols, totalRows, grid } = this;
    let writeRow = totalRows - 1; // 아래에서부터 채워 내림
    let cleared = 0;
    if (clearedRows) clearedRows.length = 0;

    for (let y = totalRows - 1; y >= 0; y--) {
      let full = true;
      const base = y * cols;
      for (let x = 0; x < cols; x++) {
        if (grid[base + x] === 0) {
          full = false;
          break;
        }
      }
      if (full) {
        cleared++;
        if (clearedRows) clearedRows.push(y);
      } else {
        if (writeRow !== y) {
          // 행 복사 (writeRow <- y)
          grid.copyWithin(writeRow * cols, base, base + cols);
        }
        writeRow--;
      }
    }
    // 남은 위쪽 행은 0으로
    for (let y = writeRow; y >= 0; y--) {
      grid.fill(0, y * cols, y * cols + cols);
    }
    return cleared;
  }

  /** 보드가 완전히 비었는지(퍼펙트 클리어 판정) */
  isEmpty(): boolean {
    const { grid } = this;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] !== 0) return false;
    }
    return true;
  }

  /** 특정 셀이 채워졌거나 벽/바닥인지(스핀 코너 판정용). 천장 위는 '비어있음'으로 본다. */
  isSolid(x: number, y: number): boolean {
    if (x < 0 || x >= this.cols || y >= this.totalRows) return true; // 벽·바닥
    if (y < 0) return false; // 천장 위는 빈 공간
    return this.grid[y * this.cols + x] !== 0;
  }

  /** 가비지 라인을 바닥에 추가(멀티/가비지 모드용). hole = 구멍 컬럼. */
  addGarbage(lines: number, hole: number): void {
    const { cols, totalRows, grid } = this;
    // 위로 lines칸 시프트
    grid.copyWithin(0, lines * cols, totalRows * cols);
    // 바닥 lines칸을 가비지로 채우고 구멍 뚫기
    for (let y = totalRows - lines; y < totalRows; y++) {
      const base = y * cols;
      for (let x = 0; x < cols; x++) {
        grid[base + x] = x === hole ? 0 : Piece.Garbage;
      }
    }
  }
}
