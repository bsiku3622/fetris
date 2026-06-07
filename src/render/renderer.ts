import { Game } from "../engine/game";
import { Piece } from "../engine/types";
import { shapeOf, BOX_SIZE } from "../engine/pieces";
import { PIECE_COLORS, FUNKY, darken, lighten } from "./theme";
import type { ParticleSystem, ActionTextManager, DamageNumberManager } from "./effects";

// ============================================================================
// Renderer — 단일 캔버스에 [hold | playfield | next] 를 그린다.
// DPR 대응, 레이아웃은 컨테이너 크기에서 매 프레임 계산(저비용).
// 보드 셀은 매 프레임 전체 redraw(10x20 수준이라 trivial). 이펙트는 오버레이.
// ============================================================================

export interface GfxOptions {
  ghost: boolean;
  ghostOpacity: number; // 0..1
  grid: boolean;
  block3d: boolean;
  boardOpacity: number; // 0.3..1
  flashOnClear: boolean;
  screenShake: number; // 0..1 강도
  particles: number; // 0..1 양
  bloom: boolean;
  showHold: boolean;
  nextCount: number;
}

export const DEFAULT_GFX: GfxOptions = {
  ghost: true,
  ghostOpacity: 0.28,
  grid: true,
  block3d: true,
  boardOpacity: 1,
  flashOnClear: true,
  screenShake: 0.5,
  particles: 0.6,
  bloom: false,
  showHold: true,
  nextCount: 5,
};

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  shakeX = 0;
  shakeY = 0;
  flash = 0; // 라인클리어 플래시 0..1
  // (락 플래시 제거됨)
  // 블록 스프라이트 캐시 — 셀 크기/3d 모드가 바뀔 때만 재생성, 매 프레임 drawImage로 blit
  private spriteCache = new Map<number, HTMLCanvasElement>();
  private spriteCell = -1;
  private sprite3d = true;
  private spritePad = 0; // 글로우 여백
  // 락 플래시 — 방금 놓인 피스 셀들이 번쩍
  bgPhase = 0; // 배경 애니메이션용 위상
  private bgCanvas: HTMLCanvasElement | null = null;
  private bgFrame = 0;
  // 화려한 연출 상태 (GameSession이 설정/감쇠)
  dropTrailX0 = 0; // 하드드롭 트레일(컬럼 범위)
  dropTrailX1 = 0;
  dropTrailAlpha = 0;
  shockAlpha = 0; // 퍼펙트클리어 충격파
  shockR = 0;
  framePulse = 0; // 클리어 시 프레임 번쩍

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D context 생성 실패");
    this.ctx = ctx;
  }

  /** 캔버스 픽셀 버퍼를 컨테이너 CSS 크기 + DPR에 맞춤 */
  resize(): void {
    // 부모(wrap) 기준으로 측정 — canvas 자기 자신을 재면 버퍼크기가 새어들어가 피드백 루프 발생
    const target = this.canvas.parentElement ?? this.canvas;
    const rect = target.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    // 안전장치: 뷰포트보다 커지지 않게 클램프(런어웨이 확대 차단)
    this.cssW = Math.max(1, Math.min(rect.width, window.innerWidth));
    this.cssH = Math.max(1, Math.min(rect.height, window.innerHeight));
    const pw = Math.round(this.cssW * dpr);
    const ph = Math.round(this.cssH * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
  }

  render(game: Game, _alpha: number, gfx: GfxOptions, particles?: ParticleSystem, action?: ActionTextManager, damage?: DamageNumberManager): void {
    const ctx = this.ctx;
    const { cols, rows } = game.board;
    const W = this.cssW;
    const H = this.cssH;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // 배경 — 저해상도 오프스크린에 캐싱해 blit (매 프레임 풀스크린 그라데이션 비용 제거)
    this.renderBackground(W, H);

    // 레이아웃: 프레임은 필드(rows)에만. 스폰존(EXTRA)은 필드 위 배경 영역에 피스만 보임.
    const EXTRA = 2; // 필드 위 스폰존 행 수(배경에 그려짐)
    const drawRows = rows + EXTRA;
    const cell = Math.max(8, Math.floor(Math.min((H * 0.92) / drawRows, (W * 0.96) / (cols + (gfx.showHold ? 11 : 5.7)))));
    const pad = Math.max(8, Math.round(cell * 0.5));
    const boardW = cell * cols;
    const fieldH = cell * rows;
    const panelW = cell * 5.2;
    const totalW = boardW + (gfx.showHold ? panelW : 0) + panelW + pad * 2;
    let originX = Math.floor((W - totalW) / 2);
    const fieldTop = Math.floor((H - fieldH) / 2 + EXTRA * cell * 0.5); // 필드를 화면 중앙 부근에
    const renderTop = game.board.bufferRows - EXTRA; // 이 보드-행부터 화면에 그림
    const by = fieldTop - EXTRA * cell; // 스폰존 포함 렌더 원점(스택/액티브 매핑 기준)

    // 화면 흔들림 적용
    ctx.translate(this.shakeX, this.shakeY);

    const bx = originX + pad + (gfx.showHold ? panelW : 0);

    // Hold 존 (배경과 분리되는 패널)
    if (gfx.showHold) {
      this.drawZone(originX, fieldTop, panelW - pad, cell * 4.2, cell, "HOLD");
      if (game.holdPiece !== Piece.None) {
        this.drawMini(game.holdPiece, originX + (panelW - pad) / 2, fieldTop + cell * 2.7, cell * 2.8, game.canHold ? 1 : 0.55, !game.canHold);
      }
    }

    // 필드 배경 + 그리드 + 프레임 (필드만)
    this.drawField(bx, fieldTop, boardW, fieldH, cols, rows, cell, gfx);

    // 블록 스프라이트 준비(셀 크기/3d 변경 시에만 재생성)
    this.ensureSprites(cell, gfx.block3d);

    // 스택
    this.drawStack(game, bx, by, cell, renderTop);

    // 하드드롭 트레일 — 피스가 떨어진 컬럼에 빛 기둥(잔상)
    if (this.dropTrailAlpha > 0.01) {
      const tx = bx + this.dropTrailX0 * cell;
      const tw = (this.dropTrailX1 - this.dropTrailX0) * cell;
      const tg = ctx.createLinearGradient(0, fieldTop, 0, fieldTop + fieldH);
      tg.addColorStop(0, `rgba(255,255,255,0)`);
      tg.addColorStop(1, `rgba(180,230,255,${this.dropTrailAlpha * 0.5})`);
      ctx.fillStyle = tg;
      ctx.fillRect(tx, fieldTop, tw, fieldH);
    }

    // 고스트 + 액티브 피스 (셀 단위 스냅 — 칸 단위로 또렷하게 낙하)
    if (game.cur !== Piece.None) {
      if (gfx.ghost) this.drawGhost(game, bx, by, cell, renderTop, gfx.ghostOpacity);
      this.drawActive(game, bx, by, cell, renderTop);
    }

    // 라인클리어 플래시 (필드 영역)
    if (gfx.flashOnClear && this.flash > 0) {
      ctx.globalAlpha = this.flash * 0.6;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(bx, fieldTop, boardW, cell * rows);
      ctx.globalAlpha = 1;
    }

    // 퍼펙트클리어 충격파 — 필드 중앙에서 퍼지는 링
    if (this.shockAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = this.shockAlpha;
      ctx.strokeStyle = FUNKY.pink;
      ctx.lineWidth = Math.max(2, cell * 0.4);
      ctx.beginPath();
      ctx.arc(bx + boardW / 2, fieldTop + fieldH / 2, this.shockR * cell, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // 클리어 프레임 펄스 — 네온 프레임이 번쩍
    if (this.framePulse > 0.02) {
      ctx.strokeStyle = `rgba(61,236,253,${this.framePulse})`;
      ctx.lineWidth = 4;
      ctx.strokeRect(bx + 2, fieldTop + 2, boardW - 4, fieldH - 4);
    }

    // 파티클(오버레이) — 필드 기준 좌표
    if (particles) particles.draw(ctx, bx, fieldTop, cell);

    // 상시 B2B 표시 (필드 왼쪽 하단) — 서지 충전 중이면 표시가 불(빨강)로 변함
    const b2b = game.scoring.b2b;
    const surge = game.scoring.surgeCharge;
    if (b2b >= 1) {
      ctx.save();
      ctx.textAlign = "right";
      const ax = bx - pad * 1.2;
      const ay = fieldTop + fieldH - cell * 0.4;
      ctx.lineJoin = "round";
      ctx.textBaseline = "alphabetic";
      const charging = surge > 0;
      const mainCol = charging ? FUNKY.danger : FUNKY.yellow;
      ctx.lineJoin = "round";
      // 라벨: 충전 중이면 "B2B SURGE" — 흰색 테두리
      const label = charging ? "B2B SURGE" : "B2B";
      ctx.font = `900 ${Math.floor(cell * 0.42)}px Pretendard, system-ui, sans-serif`;
      ctx.lineWidth = cell * 0.07;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeText(label, ax, ay - cell * 0.85);
      ctx.fillStyle = charging ? "rgba(255,90,60,0.95)" : "rgba(255,213,0,0.9)";
      ctx.fillText(label, ax, ay - cell * 0.85);
      // ×N — 흰색 테두리 (+ 충전 중 글로우)
      ctx.font = `900 ${Math.floor(cell * (charging ? 1.15 : 1.0))}px Pretendard, system-ui, sans-serif`;
      if (charging) {
        ctx.shadowColor = FUNKY.danger;
        ctx.shadowBlur = cell * 0.5;
      }
      ctx.lineWidth = cell * 0.12;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeText(`×${b2b}`, ax, ay);
      ctx.fillStyle = mainCol;
      ctx.fillText(`×${b2b}`, ax, ay);
      ctx.restore();
    }

    // 공격 스파이크 숫자 (누적, 놓은 미노 근처)
    if (damage) damage.draw(ctx, bx, fieldTop, cols, rows, cell);

    // 액션 텍스트 (필드 왼쪽)
    if (action) action.draw(ctx, bx - pad * 1.5, fieldTop, cell);

    // READY / GO 카운트다운 (필드 중앙)
    const rt = game.readyTimer;
    if (rt >= 0) {
      const txt = rt > 20 ? "READY?" : "GO!";
      const color = rt > 20 ? FUNKY.purple : FUNKY.green;
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const fs = Math.floor(cell * 1.8);
      ctx.font = `900 ${fs}px Pretendard, system-ui, sans-serif`;
      ctx.lineJoin = "round";
      ctx.lineWidth = fs * 0.1;
      const cx = bx + boardW / 2;
      const cy = fieldTop + (cell * rows) / 2;
      ctx.strokeStyle = "#000";
      ctx.strokeText(txt, cx, cy);
      ctx.fillStyle = color;
      ctx.fillText(txt, cx, cy);
      ctx.restore();
    }

    // Next 존 (배경과 분리되는 패널)
    const nx = bx + boardW + pad;
    const nexts = game.nextPieces(gfx.nextCount);
    const nextZoneH = nexts.length > 0 ? cell * (1.5 + nexts.length * 3.2) : cell * 1.05;
    this.drawZone(nx, fieldTop, panelW - pad, nextZoneH, cell, "NEXT");
    for (let i = 0; i < nexts.length; i++) {
      this.drawMini(nexts[i], nx + (panelW - pad) / 2, fieldTop + cell * (2.7 + i * 3.2), cell * 2.8, 1);
    }

    ctx.restore();
  }

  /** 배경을 저해상도 오프스크린에 그려 캐싱하고, 매 프레임은 blit만(저비용). 블롭은 가끔만 갱신. */
  private renderBackground(W: number, H: number): void {
    const lw = Math.max(4, Math.round(W / 3));
    const lh = Math.max(4, Math.round(H / 3));
    if (!this.bgCanvas) this.bgCanvas = document.createElement("canvas");
    const bc = this.bgCanvas;
    const resized = bc.width !== lw || bc.height !== lh;
    if (resized) {
      bc.width = lw;
      bc.height = lh;
    }
    // 블롭은 약 6프레임마다만 재계산(움직임이 느려 충분)
    if (resized || this.bgFrame % 6 === 0) {
      const b = bc.getContext("2d")!;
      const grad = b.createLinearGradient(0, 0, 0, lh);
      grad.addColorStop(0, FUNKY.stageTop);
      grad.addColorStop(1, FUNKY.stageBottom);
      b.globalCompositeOperation = "source-over";
      b.fillStyle = grad;
      b.fillRect(0, 0, lw, lh);
      this.bgPhase += 0.036;
      const blobs: [number, number, string][] = [
        [0.18, 0.25, FUNKY.purple],
        [0.82, 0.7, FUNKY.pink],
        [0.5, 0.9, FUNKY.sky],
      ];
      b.globalCompositeOperation = "lighter";
      for (let i = 0; i < blobs.length; i++) {
        const [bxr, byr, col] = blobs[i];
        const ph = this.bgPhase + i * 2.1;
        const gx = lw * bxr + Math.cos(ph) * (lw * 0.02);
        const gy = lh * byr + Math.sin(ph * 0.8) * (lh * 0.02);
        const r = Math.min(lw, lh) * 0.32;
        const rg = b.createRadialGradient(gx, gy, 0, gx, gy, r);
        rg.addColorStop(0, col + "22");
        rg.addColorStop(1, col + "00");
        b.fillStyle = rg;
        b.fillRect(0, 0, lw, lh);
      }
      b.globalCompositeOperation = "source-over";
    }
    this.bgFrame++;
    this.ctx.drawImage(bc, 0, 0, W, H);
  }

  private drawField(x: number, y: number, w: number, h: number, cols: number, rows: number, cell: number, gfx: GfxOptions): void {
    const ctx = this.ctx;
    // 필드 다크 배경
    ctx.globalAlpha = gfx.boardOpacity;
    const pf = ctx.createLinearGradient(x, y, x, y + h);
    pf.addColorStop(0, FUNKY.playfield);
    pf.addColorStop(1, FUNKY.playfieldEdge);
    ctx.fillStyle = pf;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;

    if (gfx.grid) {
      ctx.strokeStyle = FUNKY.gridLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < cols; c++) {
        ctx.moveTo(x + c * cell + 0.5, y);
        ctx.lineTo(x + c * cell + 0.5, y + h);
      }
      for (let r = 1; r < rows; r++) {
        ctx.moveTo(x, y + r * cell + 0.5);
        ctx.lineTo(x + w, y + r * cell + 0.5);
      }
      ctx.stroke();
    }

    // 네온 프레임 — 필드 둘레만. shadowBlur 없이 반투명 2겹 글로우
    ctx.strokeStyle = "rgba(61,236,253,0.16)";
    ctx.lineWidth = 6;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.strokeStyle = "rgba(61,236,253,0.55)";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  }

  /** HOLD/NEXT 존 — 배경과 분리되는 반투명 패널 + 헤더 라벨. */
  private drawZone(x: number, y: number, w: number, h: number, cell: number, label: string): void {
    const ctx = this.ctx;
    const headH = cell * 1.05;
    // 존 전체 반투명 패널 (배경 분리)
    ctx.fillStyle = "rgba(20, 15, 34, 0.42)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    // 헤더 (살짝 더 진하게)
    ctx.fillStyle = "rgba(61,236,253,0.10)";
    ctx.fillRect(x, y, w, headH);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `900 ${Math.floor(cell * 0.42)}px Pretendard, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, y + headH / 2);
  }

  /** 셀 크기/3d 모드가 바뀌면 모든 블록 색 스프라이트를 미리 렌더(네온 글로우 baked) */
  private ensureSprites(cell: number, block3d: boolean): void {
    const isize = Math.max(1, Math.round(cell));
    if (this.spriteCell === isize && this.sprite3d === block3d) return;
    this.spriteCell = isize;
    this.sprite3d = block3d;
    this.spritePad = 0; // 글로우 제거 — 깔끔하게
    this.spriteCache.clear();
    for (const key of Object.keys(PIECE_COLORS)) {
      const v = Number(key);
      const color = PIECE_COLORS[v];
      const c = document.createElement("canvas");
      c.width = isize;
      c.height = isize;
      const sctx = c.getContext("2d")!;
      this.paintCell(sctx, 0, 0, isize, color, block3d);
      this.spriteCache.set(v, c);
    }
  }

  /** 글로우 패딩을 고려해 블록 스프라이트를 셀 위치에 blit */
  private blitBlock(sp: HTMLCanvasElement, px: number, py: number): void {
    const pad = this.spritePad;
    this.ctx.drawImage(sp, px - pad, py - pad);
  }

  private drawStack(game: Game, bx: number, by: number, cell: number, renderTop: number): void {
    const { grid, cols, totalRows } = game.board;
    for (let y = renderTop; y < totalRows; y++) {
      const sy = y - renderTop;
      for (let x = 0; x < cols; x++) {
        const v = grid[y * cols + x];
        if (v !== 0) {
          const sp = this.spriteCache.get(v);
          if (sp) this.blitBlock(sp, Math.round(bx + x * cell), Math.round(by + sy * cell));
        }
      }
    }
  }

  private drawActive(game: Game, bx: number, by: number, cell: number, renderTop: number): void {
    const shape = shapeOf(game.cur, game.rot);
    const sp = this.spriteCache.get(game.cur);
    const ctx = this.ctx;
    // 액티브 피스만 은은한 글로우 (조종 중인 피스 강조 — 스택엔 글로우 없음)
    ctx.save();
    ctx.shadowColor = PIECE_COLORS[game.cur];
    ctx.shadowBlur = cell * 0.45;
    if (game.softActive) ctx.globalAlpha = 0.6; // 소프트드롭 중 반투명
    for (let i = 0; i < 8; i += 2) {
      const boardRow = game.py + shape[i + 1];
      if (boardRow < renderTop) continue; // 스폰존보다 위면 안 그림
      const sx = bx + (game.px + shape[i]) * cell;
      const sy = by + (boardRow - renderTop) * cell;
      if (sp) this.blitBlock(sp, sx, sy);
    }
    ctx.restore();
  }

  private drawGhost(game: Game, bx: number, by: number, cell: number, renderTop: number, opacity: number): void {
    const gy = game.ghostY();
    const shape = shapeOf(game.cur, game.rot);
    const color = PIECE_COLORS[game.cur];
    const ctx = this.ctx;
    for (let i = 0; i < 8; i += 2) {
      const x = game.px + shape[i];
      const y = gy + shape[i + 1];
      if (y < renderTop) continue;
      const sx = bx + x * cell;
      const sy = by + (y - renderTop) * cell;
      // 다크 배경용: 옅은 채움 + 밝은 네온 외곽
      ctx.globalAlpha = opacity * 0.5;
      ctx.fillStyle = color;
      ctx.fillRect(sx + 2, sy + 2, cell - 4, cell - 4);
      ctx.globalAlpha = Math.min(1, opacity * 2.2);
      ctx.strokeStyle = lighten(color, 0.2);
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 2, sy + 2, cell - 4, cell - 4);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 임의 컨텍스트에 블록 1칸을 그린다(스프라이트 굽기·미니 공용).
   * Tetr.io 스타일: 은은한 세로 그라데이션 + 글로시 상단 하이라이트 + 부드러운 베벨
   * + 색을 어둡게 한 얇은 테두리(검정 두꺼운 테두리 대신).
   */
  private paintCell(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number, color: string, threeD: boolean): void {
    // 베이스 세로 그라데이션 (위 살짝 밝게 → 아래 살짝 어둡게)
    const grad = ctx.createLinearGradient(x, y, x, y + cell);
    grad.addColorStop(0, lighten(color, 0.2));
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, darken(color, 0.16));
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, cell, cell);

    if (threeD) {
      const e = Math.max(1.5, cell * 0.11);
      // 상단 글로시 하이라이트 띠
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = lighten(color, 0.55);
      ctx.fillRect(x, y, cell, e);
      // 좌측 옅은 하이라이트
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, y, e * 0.8, cell);
      // 하단/우측 부드러운 음영
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = darken(color, 0.4);
      ctx.fillRect(x, y + cell - e, cell, e);
      ctx.fillRect(x + cell - e * 0.8, y, e * 0.8, cell);
      ctx.globalAlpha = 1;
    }

    // 얇은 테두리 — 피스 색을 어둡게(셀 구분, 부드러움)
    ctx.strokeStyle = darken(color, 0.5);
    ctx.lineWidth = Math.max(1, cell * 0.045);
    ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
  }

  private drawMini(piece: Piece, cx: number, cy: number, size: number, alpha: number, dim = false): void {
    const box = BOX_SIZE[piece];
    const shape = shapeOf(piece, 0);
    const cell = size / 4;
    // 사용된 홀드: 탁한 회색으로 (재사용 불가 시각화)
    const color = dim ? "#5d5870" : PIECE_COLORS[piece];
    const ox = cx - (box * cell) / 2;
    const oy = cy - (box * cell) / 2;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (let i = 0; i < 8; i += 2) {
      this.paintCell(ctx, ox + shape[i] * cell, oy + shape[i + 1] * cell, cell, color, !dim);
    }
    ctx.restore();
  }
}
