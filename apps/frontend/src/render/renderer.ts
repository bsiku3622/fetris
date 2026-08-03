import { Game } from "@fetris/engine/game";
import { Piece, MAX_PLAN_GHOSTS } from "@fetris/engine/types";
import type { PlanGhost } from "@fetris/engine/types";
import { shapeOf, BOX_SIZE } from "@fetris/engine/pieces";
import { PIECE_COLORS, FUNKY, darken, lighten } from "./theme";
import type { ParticleSystem, ActionTextManager, DamageNumberManager } from "./effects";
import type { HudInfo, StatItem } from "@fetris/engine/modes";

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
  bgIntensity: number; // 0..1 배경 화려함(블롭 밝기)
  glow: number; // 0..1 블록 네온 발광
  bloom: boolean;
  showHold: boolean;
  nextCount: number;
  /**
   * 캔버스가 자기 배경을 칠할지. 대전에서는 끈다 — 보드마다 배경을 칠하면
   * 사이에 경계가 생겨 화면이 뚝뚝 끊겨 보인다. 그때는 무대 뒤에 배경을
   * 하나만 깔고, 캔버스는 투명하게 겹쳐 놓는다.
   */
  backdrop?: boolean;
  /** 보드 아래에 붙일 이름표 — 필드 바로 밑에 붙어야 해서 캔버스가 그린다 */
  label?: { text: string; color: string; alpha?: number };
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
  bgIntensity: 0.6,
  glow: 0.4,
  bloom: false,
  showHold: true,
  nextCount: 5,
};

/** 그래픽 품질 프리셋 — 연출 강도(3D/플래시/흔들림/파티클/배경/글로우)만 조절. 가시성 설정은 보존. */
export const GFX_PRESETS: { id: string; label: string; gfx: Partial<GfxOptions> }[] = [
  { id: "minimum", label: "MINIMUM", gfx: { block3d: false, flashOnClear: false, screenShake: 0, particles: 0, bgIntensity: 0, glow: 0 } },
  { id: "low", label: "LOW", gfx: { block3d: false, flashOnClear: true, screenShake: 0.25, particles: 0.3, bgIntensity: 0.3, glow: 0.2 } },
  { id: "medium", label: "MEDIUM", gfx: { block3d: true, flashOnClear: true, screenShake: 0.5, particles: 0.6, bgIntensity: 0.6, glow: 0.4 } },
  { id: "high", label: "HIGH", gfx: { block3d: true, flashOnClear: true, screenShake: 0.8, particles: 0.85, bgIntensity: 0.85, glow: 0.7 } },
  { id: "ultra", label: "ULTRA", gfx: { block3d: true, flashOnClear: true, screenShake: 1, particles: 1, bgIntensity: 1, glow: 1 } },
];

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
  private spriteGlow = -1; // 스프라이트에 구운 글로우 강도(캐시 키)
  private glowLevel = 0; // 현재 글로우 강도(액티브 피스 런타임 글로우용)
  private spritePad = 0; // 글로우 여백
  // 락 플래시 — 방금 놓인 피스 셀들이 번쩍
  bgPhase = 0; // 배경 애니메이션용 위상
  private bgCanvas: HTMLCanvasElement | null = null;
  private bgFrame = 0;
  private bgIntensityCache = -1; // 배경 화려함 캐시(변경 시 재계산)
  // 화려한 연출 상태 (GameSession이 설정/감쇠)
  framePulse = 0; // 클리어 시 프레임 번쩍
  private garbageMeterValue = 0; // 가비지 게이지 애니메이션 보간값(현재 표시 줄수)
  private garbagePulse = 0; // 게이지 cap 도달/증가 시 펄스(0..1, 감쇠)

  /**
   * @param transparent 캔버스를 투명하게 둘지.
   *
   * 기본은 불투명(alpha: false)이다 — 자기 배경을 직접 칠하는 화면에서는 그게
   * 빠르다. 다만 불투명 컨텍스트에서는 `clearRect`가 투명이 아니라 **검정**을
   * 칠하므로, 배경을 뒤에 깔고 캔버스를 겹치는 대전 화면에서는 반드시 켜야 한다.
   */
  constructor(canvas: HTMLCanvasElement, transparent = false) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: transparent });
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

  render(game: Game, _alpha: number, gfx: GfxOptions, particles?: ParticleSystem, action?: ActionTextManager, damage?: DamageNumberManager, hud?: HudInfo, pendingGarbage = 0, readyGarbage = 0, plan?: readonly PlanGhost[]): void {
    const ctx = this.ctx;
    const { cols, rows } = game.board;
    const W = this.cssW;
    const H = this.cssH;

    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // 배경 — 저해상도 오프스크린에 캐싱해 blit (매 프레임 풀스크린 그라데이션 비용 제거)
    this.glowLevel = gfx.glow ?? 0.4;
    if (gfx.backdrop === false) ctx.clearRect(0, 0, W, H);
    else this.renderBackground(W, H, gfx.bgIntensity ?? 0.6);

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

    // 블록 스프라이트 준비(셀 크기/3d/글로우 변경 시에만 재생성)
    this.ensureSprites(cell, gfx.block3d, this.glowLevel);

    // 가비지 게이지 — 대전(garbageEnabled)에서 항상 표시, 값은 부드럽게 보간
    if (game.rule.garbageEnabled) {
      const gcap = game.rule.garbageCap ?? 8;
      const prev = this.garbageMeterValue;
      this.garbageMeterValue += (pendingGarbage - this.garbageMeterValue) * 0.3;
      if (Math.abs(pendingGarbage - this.garbageMeterValue) < 0.03) this.garbageMeterValue = pendingGarbage;
      // 증가 순간 펄스(차오르는 느낌)
      if (pendingGarbage > prev + 0.01) this.garbagePulse = 1;
      this.garbagePulse *= 0.9;
      if (this.garbagePulse < 0.02) this.garbagePulse = 0;
      this.drawGarbageMeter(bx, fieldTop, fieldH, cell, this.garbageMeterValue, pendingGarbage, gcap, readyGarbage);
    }

    // 스택
    this.drawStack(game, bx, by, cell, renderTop);

    // 계획 고스트 — 실제 판과 무관한 표시용. 스택 위, 액티브 피스 아래에 깔린다.
    if (plan && plan.length > 0) this.drawPlan(plan, bx, by, cell, renderTop, cols);

    // 고스트 + 액티브 피스 (셀 단위 스냅 — 칸 단위로 또렷하게 낙하)
    if (game.cur !== Piece.None) {
      if (gfx.ghost) this.drawGhost(game, bx, by, cell, renderTop, gfx.ghostOpacity);
      this.drawActive(game, bx, by, cell, renderTop);
    }

    // 위험 표시 — 스택이 천장 근처면 빨간 경고 비네트(필드 상단부터 짙게)
    if (game.rule.topOutEnabled || game.rule.garbageEnabled) {
      const topRow = game.board.highestRow();
      const dangerSpan = rows * 0.35; // 상단 35% 진입 시 경고 시작
      const dangerStart = game.board.bufferRows + dangerSpan;
      if (topRow < dangerStart) {
        const intensity = Math.min(1, (dangerStart - topRow) / dangerSpan);
        const pulse = 0.55 + 0.45 * Math.sin(this.bgPhase * 6); // 맥동
        const a = intensity * (0.18 + 0.16 * pulse);
        const grad = ctx.createLinearGradient(0, fieldTop, 0, fieldTop + fieldH * 0.6);
        grad.addColorStop(0, `rgba(255,30,30,${a})`);
        grad.addColorStop(1, "rgba(255,30,30,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(bx, fieldTop, boardW, fieldH * 0.6);
        // 상단 테두리 강조
        ctx.strokeStyle = `rgba(255,40,40,${intensity * (0.4 + 0.3 * pulse)})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(bx + 1.5, fieldTop + 1.5, boardW - 3, fieldH - 3);
      }
    }

    // 스폰 위치 X — 블록아웃(게임오버) 또는 스택이 스폰존 근처일 때 다음 피스 스폰 칸 표시
    this.drawSpawnIndicator(game, bx, by, cell, renderTop);

    // 라인클리어 플래시 (필드 영역)
    if (gfx.flashOnClear && this.flash > 0) {
      ctx.globalAlpha = this.flash * 0.6;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(bx, fieldTop, boardW, cell * rows);
      ctx.globalAlpha = 1;
    }

    // 클리어 프레임 펄스 — 네온 프레임이 번쩍
    if (this.framePulse > 0.02) {
      ctx.strokeStyle = `rgba(61,236,253,${this.framePulse})`;
      ctx.lineWidth = 4;
      ctx.strokeRect(bx + 2, fieldTop + 2, boardW - 4, fieldH - 4);
    }

    // 파티클(오버레이) — 필드 기준 좌표
    if (particles) particles.draw(ctx, bx, fieldTop, cell);

    // 상시 B2B 표시 (HOLD 패널 바로 아래) — 서지 충전 중이면 불(빨강)로 변함
    const b2b = game.scoring.b2b;
    const surge = game.scoring.surgeCharge;
    if (b2b >= 1 && gfx.showHold) {
      ctx.save();
      ctx.textAlign = "left";
      const lx = originX + pad * 0.4;
      const ly = fieldTop + cell * 4.2 + cell * 1.05; // 홀드 패널 바로 아래
      ctx.lineJoin = "round";
      ctx.textBaseline = "alphabetic";
      const charging = surge > 0;
      const mainCol = charging ? FUNKY.danger : FUNKY.yellow;
      const label = charging ? "B2B SURGE" : "B2B";
      ctx.font = `900 ${Math.floor(cell * 0.4)}px Pretendard, system-ui, sans-serif`;
      ctx.fillStyle = charging ? "rgba(255,90,60,0.95)" : "rgba(255,213,0,0.9)";
      ctx.fillText(label, lx, ly);
      // ×N — 흰색 테두리 (+ 충전 중 글로우)
      ctx.font = `900 ${Math.floor(cell * (charging ? 1.05 : 0.92))}px Pretendard, system-ui, sans-serif`;
      if (charging) {
        ctx.shadowColor = FUNKY.danger;
        ctx.shadowBlur = cell * 0.5;
      }
      ctx.lineWidth = cell * 0.1;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeText(`×${b2b}`, lx, ly + cell * 1.0);
      ctx.fillStyle = mainCol;
      ctx.fillText(`×${b2b}`, lx, ly + cell * 1.0);
      ctx.restore();
    }

    // 공격 스파이크 숫자 (누적, 놓은 미노 근처)
    if (damage) damage.draw(ctx, bx, fieldTop, cols, rows, cell);

    // 액션 텍스트 (필드 왼쪽)
    if (action) action.draw(ctx, bx - pad * 1.5, fieldTop, cell);

    // 시작 카운트다운 (필드 중앙)
    //
    // Ready를 길게 잡은 판(대전 라운드 전환)은 3·2·1로 센다. 기본 1초짜리
    // 판은 셀 것이 없으므로 예전대로 READY?/GO!를 띄운다.
    const rt = game.readyTimer;
    // Ready를 길게 잡은 판(대전)은 보드마다 숫자를 그리지 않는다 —
    // 화면 정중앙에 하나만 띄우는 편이 조용하고, 무대가 그걸 맡는다.
    const counted = (game.rule.readyFrames ?? 60) > 60;
    if (rt >= 0 && !counted) {
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

    // 사이드 통계 (테트리오식) — 필드 좌우 테두리에 붙여서. 좌측은 우측정렬, 우측은 좌측정렬.
    if (hud) {
      const statBottom = fieldTop + fieldH - cell * 0.35;
      /*
        왼쪽 통계는 가비지 게이지와 같은 편에 선다. 필드 기준으로만 띄우면
        게이지 바에 글자가 달라붙어 둘 다 읽기 어려우므로, 게이지 폭만큼 더
        물러난 자리에서 시작한다.
      */
      const meterW = game.rule.garbageEnabled ? Math.max(8, Math.round(cell * 0.55)) : 0;
      const meterGap = game.rule.garbageEnabled ? Math.max(3, Math.round(cell * 0.16)) : 0;
      const leftX = bx - meterW - meterGap - Math.round(cell * 0.45);
      if (hud.left.length) this.drawStatStack(hud.left, leftX, statBottom, cell, "right");
      if (hud.right.length) this.drawStatStack(hud.right, bx + boardW + pad * 1.4, statBottom, cell, "left");
    }

    // 이름 — 필드 바로 아래. DOM 라벨로는 보드와 이만큼 붙일 수 없다.
    if (gfx.label) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const fs = Math.max(10, Math.round(cell * 0.62));
      ctx.font = `900 ${fs}px Pretendard, system-ui, sans-serif`;
      ctx.globalAlpha = gfx.label.alpha ?? 1;
      ctx.fillStyle = gfx.label.color;
      ctx.letterSpacing = `${Math.round(fs * 0.12)}px`;
      ctx.fillText(gfx.label.text.toUpperCase(), bx + boardW / 2, fieldTop + fieldH + cell * 0.34);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * 가비지 게이지 — 필드 왼쪽 세로 바. 대전 중 항상 표시.
   * @param animated 표시용 보간값(부드러운 채움)
   * @param actual 실제 대기 줄 수(숫자/색 기준)
   */
  private drawGarbageMeter(fieldX: number, fieldY: number, fieldH: number, cell: number, animated: number, actual: number, cap: number, ready: number): void {
    const ctx = this.ctx;
    const meterW = Math.max(8, Math.round(cell * 0.55));
    const gap = Math.max(3, Math.round(cell * 0.16));
    const mx = fieldX - meterW - gap;
    // 게이지 길이를 실제 블록 높이에 맞춘다 — 1줄 = 셀 1칸.
    // cap 비율로 그리면 cap이 낮을 때 몇 줄 안 되는데도 필드 끝까지 차서
    // 실제로 들어올 양을 눈으로 가늠할 수 없다.
    const barH = Math.min(fieldH, animated * cell);
    const danger = actual >= cap; // cap 도달(이번에 다 들어옴)

    ctx.save();
    // 배경 트랙(항상 표시)
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(mx, fieldY, meterW, fieldH);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.strokeRect(mx, fieldY, meterW, fieldH);

    // 채움(아래→위): 충전 중(대기) = 호박색, 투하 준비(활성) = 불투명 빨강 (Tetr.io식 단계 표시)
    if (barH > 0.5) {
      const glow = Math.max(this.garbagePulse, danger ? 0.7 : 0);
      if (glow > 0.02) {
        ctx.shadowColor = danger ? "rgba(255,45,45,0.9)" : "rgba(255,170,30,0.8)";
        ctx.shadowBlur = cell * 0.7 * glow;
      }
      ctx.fillStyle = danger ? "rgba(255,70,45,0.55)" : "rgba(255,180,40,0.85)";
      ctx.fillRect(mx, fieldY + fieldH - barH, meterW, barH);
      ctx.shadowBlur = 0;
      // 투하 준비된 줄(활성) — 바닥부터 불투명 빨강으로 덮어 단계 구분
      const readyH = Math.min(barH, ready * cell);
      if (readyH > 0.5) {
        ctx.fillStyle = "rgba(255,45,45,0.96)";
        ctx.fillRect(mx, fieldY + fieldH - readyH, meterW, readyH);
      }
    }

    // 숫자(실제값)
    if (actual >= 1) {
      ctx.shadowBlur = 0;
      const fs = Math.max(10, Math.floor(cell * 0.5));
      ctx.font = `900 ${fs}px Pretendard, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = Math.max(2, fs * 0.18);
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      const label = String(Math.round(actual));
      const ty = Math.max(fieldY + fs + 2, fieldY + fieldH - barH - 4);
      ctx.strokeText(label, mx + meterW / 2, ty);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, mx + meterW / 2, ty);
    }
    ctx.restore();
  }

  /** 통계 스택 — 라벨(작게,흐림) + 값(크게,흰색) + 선택적 보조(작게). bottomY 기준 위로 쌓음. */
  private drawStatStack(items: StatItem[], x: number, bottomY: number, cell: number, align: "left" | "right"): void {
    if (!items.length) return;
    const ctx = this.ctx;
    const blockH = cell * 1.75;
    const labelFs = Math.max(8, Math.floor(cell * 0.4));
    const valueFs = Math.max(12, Math.floor(cell * 0.92));
    const subFs = Math.max(9, Math.floor(cell * 0.5));
    const subGap = cell * 0.04;
    const labelFont = `900 ${labelFs}px Pretendard, system-ui, sans-serif`;
    const valueFont = `900 ${valueFs}px Pretendard, system-ui, sans-serif`;
    const subFont = `800 ${subFs}px Pretendard, system-ui, sans-serif`;
    const topY = bottomY - items.length * blockH;
    ctx.save();
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = cell * 0.15;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const blockTop = topY + i * blockH;
      const labelY = blockTop + labelFs;
      const valueY = blockTop + labelFs + valueFs * 0.95;
      // 라벨
      ctx.textAlign = align;
      ctx.font = labelFont;
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fillText(it.label, x, labelY);
      // 값(+보조). 보조는 큰 값과 같은 베이스라인에 작게.
      if (it.sub) {
        if (align === "right") {
          ctx.textAlign = "right";
          ctx.font = subFont;
          const sw = ctx.measureText(it.sub).width;
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.fillText(it.sub, x, valueY);
          ctx.font = valueFont;
          ctx.fillStyle = "#ffffff";
          ctx.fillText(it.value, x - sw - subGap, valueY);
        } else {
          ctx.textAlign = "left";
          ctx.font = valueFont;
          ctx.fillStyle = "#ffffff";
          ctx.fillText(it.value, x, valueY);
          const vw = ctx.measureText(it.value).width;
          ctx.font = subFont;
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.fillText(it.sub, x + vw + subGap, valueY);
        }
      } else {
        ctx.textAlign = align;
        ctx.font = valueFont;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(it.value, x, valueY);
      }
    }
    ctx.restore();
  }

  /** 스폰 위치 인디케이터 — 게임오버(블록아웃)면 실패한 스폰 칸에 강한 빨간 X,
   *  아니면 스택이 스폰존 근처일 때 다음 피스 스폰 칸에 옅은 X(테트리오식 위험 경고). */
  private drawSpawnIndicator(game: Game, bx: number, by: number, cell: number, renderTop: number): void {
    const dead = game.isGameOver() && game.blockOutCells.length > 0;
    let cells: number[];
    let intensity: number;
    if (dead) {
      cells = game.blockOutCells;
      intensity = 1;
    } else {
      const topRow = game.board.highestRow();
      const warnFrom = game.board.bufferRows + 1; // 가시 상단 1칸 위부터 경고
      const span = 3;
      if (topRow > warnFrom + span) return; // 충분히 낮으면 표시 안 함
      intensity = Math.min(1, (warnFrom + span - topRow) / span);
      cells = game.peekSpawnCells();
    }
    if (!cells.length) return;
    const ctx = this.ctx;
    ctx.save();
    const pulse = dead ? 1 : 0.5 + 0.5 * Math.sin(this.bgPhase * 6);
    ctx.globalAlpha = dead ? 0.95 : Math.min(0.9, (0.2 + 0.6 * intensity) * pulse);
    ctx.strokeStyle = dead ? "rgba(255,55,55,1)" : "rgba(255,90,90,1)";
    ctx.lineWidth = Math.max(2, cell * 0.12);
    ctx.lineCap = "round";
    for (let i = 0; i < cells.length; i += 2) {
      const boardRow = cells[i + 1];
      if (boardRow < renderTop) continue; // 천장 위(스폰존보다 위)는 못 그림
      const sx = bx + cells[i] * cell;
      const sy = by + (boardRow - renderTop) * cell;
      const m = cell * 0.24;
      ctx.beginPath();
      ctx.moveTo(sx + m, sy + m);
      ctx.lineTo(sx + cell - m, sy + cell - m);
      ctx.moveTo(sx + cell - m, sy + m);
      ctx.lineTo(sx + m, sy + cell - m);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 배경을 저해상도 오프스크린에 그려 캐싱하고, 매 프레임은 blit만(저비용). 블롭은 가끔만 갱신. */
  private renderBackground(W: number, H: number, intensity: number): void {
    const lw = Math.max(4, Math.round(W / 3));
    const lh = Math.max(4, Math.round(H / 3));
    if (!this.bgCanvas) this.bgCanvas = document.createElement("canvas");
    const bc = this.bgCanvas;
    const resized = bc.width !== lw || bc.height !== lh;
    if (resized) {
      bc.width = lw;
      bc.height = lh;
    }
    const intensityChanged = this.bgIntensityCache !== intensity;
    if (intensityChanged) this.bgIntensityCache = intensity;
    // 블롭은 약 6프레임마다만 재계산(움직임이 느려 충분)
    if (resized || intensityChanged || this.bgFrame % 6 === 0) {
      const b = bc.getContext("2d")!;
      const grad = b.createLinearGradient(0, 0, 0, lh);
      grad.addColorStop(0, FUNKY.stageTop);
      grad.addColorStop(1, FUNKY.stageBottom);
      b.globalCompositeOperation = "source-over";
      b.fillStyle = grad;
      b.fillRect(0, 0, lw, lh);
      this.bgPhase += 0.036;
      // 블롭 밝기는 bgIntensity에 비례(0.6≈기존, 1=훨씬 화려, 0=그라데이션만)
      const ab = Math.max(0, Math.min(255, Math.round(55 * intensity)));
      if (ab > 0) {
        const ah = ab.toString(16).padStart(2, "0");
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
          const r = Math.min(lw, lh) * (0.32 + intensity * 0.1);
          const rg = b.createRadialGradient(gx, gy, 0, gx, gy, r);
          rg.addColorStop(0, col + ah);
          rg.addColorStop(1, col + "00");
          b.fillStyle = rg;
          b.fillRect(0, 0, lw, lh);
        }
        b.globalCompositeOperation = "source-over";
      }
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

  /** 셀 크기/3d/글로우가 바뀌면 모든 블록 색 스프라이트를 미리 렌더(네온 글로우 baked) */
  private ensureSprites(cell: number, block3d: boolean, glow: number): void {
    const isize = Math.max(1, Math.round(cell));
    const g = Math.round(glow * 100) / 100;
    if (this.spriteCell === isize && this.sprite3d === block3d && this.spriteGlow === g) return;
    this.spriteCell = isize;
    this.sprite3d = block3d;
    this.spriteGlow = g;
    // 글로우 여백 — 스프라이트 둘레로 발광이 번질 공간
    this.spritePad = g > 0 ? Math.round(isize * 0.32 * g) : 0;
    const pad = this.spritePad;
    this.spriteCache.clear();
    for (const key of Object.keys(PIECE_COLORS)) {
      const v = Number(key);
      const color = PIECE_COLORS[v];
      const c = document.createElement("canvas");
      c.width = isize + pad * 2;
      c.height = isize + pad * 2;
      const sctx = c.getContext("2d")!;
      // 글로우 패스 — 색 블록을 shadowBlur로 한 번 깔아 발광 halo 생성
      if (g > 0) {
        sctx.save();
        sctx.shadowColor = color;
        sctx.shadowBlur = isize * 0.55 * g;
        sctx.fillStyle = color;
        sctx.fillRect(pad + isize * 0.16, pad + isize * 0.16, isize * 0.68, isize * 0.68);
        sctx.restore();
      }
      this.paintCell(sctx, pad, pad, isize, color, block3d);
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
    // 액티브 피스 추가 글로우(조종 중인 피스 강조) — glow 설정에 비례, 스택의 베이크 글로우 위에 살짝
    ctx.save();
    ctx.shadowColor = PIECE_COLORS[game.cur];
    ctx.shadowBlur = cell * 0.4 * this.glowLevel;
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

  /**
   * 계획 고스트 — 봇이 "여기에 놓을 생각"이라고 알려준 자리.
   *
   * 실제 낙하 고스트와 헷갈리면 안 되므로 점선 외곽선으로 그린다. 게임 상태가
   * 아니라 남이 보내준 표시일 뿐이라, 보드 밖으로 나가는 좌표는 조용히 버린다.
   */
  private drawPlan(plan: readonly PlanGhost[], bx: number, by: number, cell: number, renderTop: number, cols: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([Math.max(2, cell * 0.26), Math.max(2, cell * 0.14)]);
    ctx.lineWidth = Math.max(2, cell * 0.14);
    ctx.lineJoin = "round";
    for (let n = 0; n < plan.length && n < MAX_PLAN_GHOSTS; n++) {
      const g = plan[n];
      if (g.piece === Piece.None) continue;
      const shape = shapeOf(g.piece, g.rot);
      const color = PIECE_COLORS[g.piece];
      const bright = lighten(color, 0.45);
      const alpha = Math.max(0, Math.min(1, g.alpha ?? 0.6));
      for (let i = 0; i < 8; i += 2) {
        const x = g.x + shape[i];
        const y = g.y + shape[i + 1];
        if (y < renderTop || x < 0 || x >= cols) continue;
        const sx = bx + x * cell;
        const sy = by + (y - renderTop) * cell;
        // 어두운 보드 위에서 뜨도록 옅은 채움 + 밝은 점선 + 글로우
        ctx.shadowColor = "transparent";
        ctx.globalAlpha = alpha * 0.45;
        ctx.fillStyle = color;
        ctx.fillRect(sx + 2, sy + 2, cell - 4, cell - 4);
        ctx.shadowColor = bright;
        ctx.shadowBlur = cell * 0.35;
        ctx.globalAlpha = Math.min(1, alpha * 1.25);
        ctx.strokeStyle = bright;
        ctx.strokeRect(sx + 2, sy + 2, cell - 4, cell - 4);
      }
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
   * 3D: 4면 경사(베벨) 타일 — 빛은 좌상단. 솟아오른 캡처럼 보이도록.
   * 비3D: 단순 세로 그라데이션.
   */
  private paintCell(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number, color: string, threeD: boolean): void {
    if (!threeD) {
      const grad = ctx.createLinearGradient(x, y, x, y + cell);
      grad.addColorStop(0, lighten(color, 0.18));
      grad.addColorStop(1, darken(color, 0.16));
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, cell, cell);
      ctx.strokeStyle = darken(color, 0.5);
      ctx.lineWidth = Math.max(1, cell * 0.045);
      ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      return;
    }

    // ---- 3D 베벨 타일(은은하게) ----
    const b = Math.max(1.5, cell * 0.1); // 얇은 경사면
    const x0 = x;
    const y0 = y;
    const x1 = x + cell;
    const y1 = y + cell;
    const ix0 = x + b;
    const iy0 = y + b;
    const ix1 = x + cell - b;
    const iy1 = y + cell - b;

    // 안쪽 캡(대부분의 면) — 글로시 세로 그라데이션
    const ig = ctx.createLinearGradient(x0, y0, x0, y1);
    ig.addColorStop(0, lighten(color, 0.16));
    ig.addColorStop(0.55, color);
    ig.addColorStop(1, darken(color, 0.14));
    ctx.fillStyle = ig;
    ctx.fillRect(x0, y0, cell, cell);

    const quad = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, fill: string) => {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx, cy);
      ctx.lineTo(dx, dy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    // 4면 경사 — 상(밝음) / 좌(중밝) / 우(중어둠) / 하(어둠). 대비는 약하게.
    quad(x0, y0, x1, y0, ix1, iy0, ix0, iy0, lighten(color, 0.4));
    quad(x0, y0, ix0, iy0, ix0, iy1, x0, y1, lighten(color, 0.18));
    quad(x1, y0, x1, y1, ix1, iy1, ix1, iy0, darken(color, 0.16));
    quad(x0, y1, ix0, iy1, ix1, iy1, x1, y1, darken(color, 0.32));

    // 얇은 외곽 테두리 — 셀 분리
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
