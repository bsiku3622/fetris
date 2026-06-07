
// ============================================================================
// ParticleSystem — object pool 기반. 할당 0 hot path.
// 절제된 funky: 라인클리어 파편, 하드드롭 먼지, 스핀 반짝임 정도만.
// ============================================================================

const MAX = 512;

export class ParticleSystem {
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private color = new Array<string>(MAX).fill("#fff");
  private active = new Uint8Array(MAX);
  private head = 0;
  intensity = 0.6; // 파티클 양 0..1

  private alloc(): number {
    for (let i = 0; i < MAX; i++) {
      const idx = (this.head + i) % MAX;
      if (!this.active[idx]) {
        this.head = (idx + 1) % MAX;
        return idx;
      }
    }
    // 가득 차면 head 재사용
    const idx = this.head;
    this.head = (idx + 1) % MAX;
    return idx;
  }

  private spawn(x: number, y: number, vx: number, vy: number, life: number, size: number, color: string): void {
    const i = this.alloc();
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.color[i] = color;
    this.active[i] = 1;
  }

  /** 라인클리어 — 클리어한 미노 중심(cx,cy)에서 위로 분출 (보드 셀 좌표 기준) */
  lineClear(cx: number, cy: number, bufferRows: number, color: string, lines: number): void {
    if (this.intensity <= 0) return;
    const n = Math.round((6 + lines * 3) * this.intensity);
    const sy = cy - bufferRows;
    for (let k = 0; k < n; k++) {
      // 가로·세로로 넓게 퍼진 위치에서 위로 쭉 (수평은 미세하게만)
      this.spawn(cx + (Math.random() - 0.5) * 4, sy + 0.5 + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 0.7, -2.5 - Math.random() * 2.5, 0.9 + Math.random() * 0.25, 0.08 + Math.random() * 0.06, color);
    }
  }

  /** 하드드롭 먼지 — 넓게 퍼진 채 위로 쭉 올라가 ~1초 후 사라짐 */
  hardDropDust(x: number, y: number, _width: number, bufferRows: number, color: string): void {
    if (this.intensity <= 0) return;
    const sy = y - bufferRows;
    const n = Math.round(8 * this.intensity);
    for (let k = 0; k < n; k++) {
      const px = x + (Math.random() - 0.5) * 7; // 가로로 넓게 퍼뜨림
      const py = sy + 1 - Math.random() * 7; // 낙하 경로 따라 세로로도 퍼뜨림
      // 위로 쭉(수평 거의 없음) + ~1초 수명
      this.spawn(px, py, (Math.random() - 0.5) * 0.6, -3 - Math.random() * 2, 0.9 + Math.random() * 0.25, 0.07 + Math.random() * 0.05, color);
    }
  }

  /** 스핀 반짝임 */
  spinSparkle(cx: number, cy: number, bufferRows: number, color: string): void {
    if (this.intensity <= 0) return;
    const n = Math.round(8 * this.intensity);
    for (let k = 0; k < n; k++) {
      const ang = (k / n) * Math.PI * 2;
      const sp = 3 + Math.random() * 2;
      this.spawn(cx, cy - bufferRows, Math.cos(ang) * sp, Math.sin(ang) * sp, 0.4, 0.18, color);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX; i++) {
      if (!this.active[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.active[i] = 0;
        continue;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.vy[i] *= 0.985; // 위로 쭉 올라가며 완만히 감속(중력 없음)
      this.vx[i] *= 0.98; // 수평은 거의 정지
    }
  }

  draw(ctx: CanvasRenderingContext2D, bx: number, by: number, cell: number): void {
    for (let i = 0; i < MAX; i++) {
      if (!this.active[i]) continue;
      const a = this.life[i] / this.maxLife[i];
      ctx.globalAlpha = a;
      ctx.fillStyle = this.color[i];
      const s = this.size[i] * cell;
      ctx.fillRect(bx + this.px[i] * cell - s / 2, by + this.py[i] * cell - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.active.fill(0);
  }
}

// ============================================================================
// ActionTextManager — T-SPIN/QUAD/B2B/COMBO/PERFECT CLEAR 액션 텍스트.
// 보드 왼쪽 빈 공간에 떠올라 페이드. 절제된 funky 손맛.
// ============================================================================

interface ActionText {
  text: string;
  color: string;
  size: number; // 상대 배율
  life: number;
  maxLife: number;
}

export class ActionTextManager {
  private items: ActionText[] = [];

  push(text: string, color: string, size = 1, life = 1.1): void {
    this.items.unshift({ text, color, size, life, maxLife: life });
    if (this.items.length > 6) this.items.length = 6;
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      this.items[i].life -= dt;
      if (this.items[i].life <= 0) this.items.splice(i, 1);
    }
  }

  /** 보드 왼쪽 영역에 그린다. (x,y)=앵커(보드 좌상단 기준 왼쪽), cell=셀크기 */
  draw(ctx: CanvasRenderingContext2D, anchorX: number, anchorY: number, cell: number): void {
    ctx.save();
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    let yy = anchorY + cell * 5;
    for (const it of this.items) {
      const a = it.life / it.maxLife;
      const rise = (1 - a) * cell * 0.8;
      // 팝: 태어날 때(a≈1) 크게 → 빠르게 정상 크기로 수축
      const pop = 1 + Math.max(0, a - 0.82) * 2.6;
      const fs = Math.floor(cell * 0.62 * it.size * pop);
      ctx.globalAlpha = Math.min(1, a * 1.8);
      ctx.font = `900 ${fs}px Pretendard, system-ui, sans-serif`;
      // 네온 글로우 + 검정 외곽선 + 네온 채움
      ctx.save();
      ctx.shadowColor = it.color;
      ctx.shadowBlur = fs * 0.4;
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, fs * 0.13);
      ctx.strokeStyle = "#000";
      ctx.strokeText(it.text, anchorX, yy - rise);
      ctx.restore();
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, anchorX, yy - rise);
      yy += cell * 1.2;
    }
    ctx.restore();
  }

  clear(): void {
    this.items.length = 0;
  }
}

// ============================================================================
// SpikeDisplay (DamageNumberManager) — 공격 스파이크. 콤보 동안 누적되는 단일 숫자.
// 검정 글자 + 흰 글로우. 값이 클수록 크게. 콤보 끊기면 페이드.
// Tetr.io 스파이크 개념: 짧은 시간에 누적된 공격량.
// ============================================================================

export class DamageNumberManager {
  private value = 0;
  private life = 0;
  private maxLife = 1.6;
  private rise = 0; // 떠오름 오프셋(셀)
  private pop = 0; // 갱신 시 팝
  private col = 4; // 필드 컬럼(놓은 미노 근처)
  private rngSeed = 0x9e3779b9;

  private rand(): number {
    this.rngSeed = (this.rngSeed * 1664525 + 1013904223) >>> 0;
    return this.rngSeed / 4294967296;
  }

  /** 누적 스파이크 표시값 갱신. value=누적 공격량, col=놓은 미노 컬럼(가시 필드). */
  show(value: number, col: number): void {
    if (value <= 0) return;
    this.value = value;
    this.life = this.maxLife;
    this.rise = 0;
    this.pop = 1;
    // 미노 컬럼 근처 랜덤 오프셋
    this.col = col + (this.rand() - 0.5) * 2.5;
  }

  update(dt: number): void {
    if (this.life > 0) {
      this.life -= dt;
      this.rise += dt * 1.0;
      this.pop *= 0.82;
    }
  }

  /** (bx,fieldTop)=필드 좌상단, cols/rows=필드 크기(클램프용). */
  draw(ctx: CanvasRenderingContext2D, bx: number, fieldTop: number, cols: number, rows: number, cell: number): void {
    if (this.life <= 0 || this.value <= 0) return;
    const a = Math.min(1, (this.life / this.maxLife) * 1.6);
    const big = Math.min(this.value / 14, 1);
    const fs = Math.floor(cell * (1.1 + big * 1.8) * (1 + this.pop * 0.3));
    const cx = Math.max(1.2, Math.min(cols - 1.2, this.col));
    const x = bx + cx * cell;
    // 필드 밖(상단 위)에서 떠오름 — 필드를 가리지 않게
    const y = fieldTop - cell * 0.9 - this.rise * cell;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = a;
    ctx.font = `900 ${fs}px Pretendard, system-ui, sans-serif`;
    // 흰색 글로우 + 검정 글자
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = fs * 0.6;
    ctx.fillStyle = "#000000";
    ctx.fillText(String(this.value), x, y);
    ctx.shadowBlur = fs * 0.35;
    ctx.fillText(String(this.value), x, y);
    ctx.restore();
    void rows;
  }

  clear(): void {
    this.value = 0;
    this.life = 0;
  }
}
