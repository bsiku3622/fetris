// ============================================================================
// SoundEngine — Web Audio 합성 SFX (에셋 불필요, 저지연, 저작권 클린/CC0).
// 리버브 버스(공간감) + 마스터 EQ/리미터. 모든 사운드는 합성.
// ============================================================================

export interface AudioOptions {
  enabled: boolean;
  master: number; // 0..1
  sfx: number; // 0..1
  music: number; // 0..1
}

export const DEFAULT_AUDIO: AudioOptions = {
  enabled: true,
  master: 0.8,
  sfx: 0.55,
  music: 0.35,
};

type SfxName =
  | "move"
  | "rotate"
  | "lock"
  | "harddrop"
  | "hold"
  | "clear1"
  | "clear2"
  | "clear3"
  | "tetris"
  | "tspin"
  | "pc"
  | "b2b"
  | "combo"
  | "levelup"
  | "gameover"
  | "hit"
  | "ready"
  | "go";

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private eq: BiquadFilterNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  opts: AudioOptions;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicStep = 0;
  private unlockHandler: (() => void) | null = null;

  constructor(opts: AudioOptions = DEFAULT_AUDIO) {
    this.opts = { ...opts };
    this.installUnlock();
  }

  /** 자동재생 정책 우회 — 첫 사용자 제스처에서 AudioContext 생성·resume. */
  private installUnlock(): void {
    if (typeof window === "undefined") return;
    const handler = () => {
      this.ensure();
      if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
      if (this.ctx && this.ctx.state === "running") this.removeUnlock();
    };
    this.unlockHandler = handler;
    const o = { capture: true } as AddEventListenerOptions;
    window.addEventListener("pointerdown", handler, o);
    window.addEventListener("keydown", handler, o);
    window.addEventListener("touchstart", handler, o);
  }

  private removeUnlock(): void {
    if (!this.unlockHandler) return;
    const o = { capture: true } as EventListenerOptions;
    window.removeEventListener("pointerdown", this.unlockHandler, o);
    window.removeEventListener("keydown", this.unlockHandler, o);
    window.removeEventListener("touchstart", this.unlockHandler, o);
    this.unlockHandler = null;
  }

  dispose(): void {
    this.stopMusic();
    this.removeUnlock();
  }

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    const ctx = this.ctx;
    this.master = ctx.createGain();

    // 마스터 체인: master → EQ(air) → limiter → destination
    this.eq = ctx.createBiquadFilter();
    this.eq.type = "highshelf";
    this.eq.frequency.value = 6000;
    this.eq.gain.value = 2.5;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.1;
    this.master.connect(this.eq);
    this.eq.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.sfxGain = ctx.createGain();
    this.musicGain = ctx.createGain();

    // 리버브 버스(공간감): sfx → dry → master, sfx → convolver → wet → master
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(0.42, 2.6);
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.dryGain.gain.value = 1;
    this.wetGain.gain.value = 0.28;
    this.sfxGain.connect(this.dryGain);
    this.sfxGain.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.dryGain.connect(this.master);
    this.wetGain.connect(this.master);
    this.musicGain.connect(this.master); // 음악은 드라이

    this.applyVolumes();
  }

  setOptions(o: Partial<AudioOptions>): void {
    Object.assign(this.opts, o);
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.master || !this.sfxGain) return;
    this.master.gain.value = this.opts.enabled ? this.opts.master : 0;
    this.sfxGain.gain.value = this.opts.sfx;
    if (this.musicGain) this.musicGain.gain.value = this.opts.music * 0.5;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** 단일 톤. 종료 시 게인을 0까지 내려 클릭 제거. */
  private tone(freq: number, dur: number, type: OscillatorType, gain: number, delay = 0, slideTo?: number, attack = 0.004): void {
    if (!this.ctx || !this.sfxGain || !this.opts.enabled) return;
    const t = this.now() + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    const atk = Math.min(attack, dur * 0.5);
    const rel = 0.006;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + atk);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0008, gain * 0.04), t + Math.max(atk + 0.002, dur - rel));
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  /**
   * 필터드 노이즈 — bandpass/highpass/lowpass + 주파수 스윕 + 부드러운 엔벨로프.
   * "질감"(공기 가르는 슉/틱)의 핵심. 톤이 아니라 노이즈라 음정이 없다.
   */
  private fnoise(dur: number, gain: number, type: BiquadFilterType, freq: number, q = 1, freqTo?: number, delay = 0): void {
    if (!this.ctx || !this.sfxGain || !this.opts.enabled) return;
    const t = this.now() + delay;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.setValueAtTime(freq, t);
    if (freqTo) filt.frequency.exponentialRampToValueAtTime(Math.max(40, freqTo), t + dur);
    filt.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.006, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(Math.max(0.0006, gain * 0.03), t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.005);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /** 리버브 임펄스 응답(IR) — 부드러운 플레이트풍. */
  private makeImpulse(dur: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      const a = 0.32;
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, decay);
        const n = (Math.random() * 2 - 1) * env;
        last = last + a * (n - last);
        d[i] = last;
      }
    }
    return buf;
  }

  /** 벨/차임 — 레이어드 사인 부분음(약간 디튠)으로 "만족스러운 블룸". */
  private bell(freq: number, dur: number, gain: number, delay = 0): void {
    if (!this.ctx || !this.sfxGain || !this.opts.enabled) return;
    const partials: [number, number][] = [
      [1, 1],
      [2.0, 0.4],
      [3.0, 0.18],
      [1.005, 0.6],
    ];
    for (const [mult, amp] of partials) {
      this.tone(freq * mult, dur, "sine", gain * amp, delay, undefined, 0.004);
    }
  }

  play(name: SfxName): void {
    if (!this.opts.enabled) return;
    this.ensure();
    switch (name) {
      case "move":
        this.tone(440, 0.05, "triangle", 0.05, 0, 300);
        this.tone(1050, 0.02, "sine", 0.015);
        break;
      case "rotate":
        // 조용한 톤 틱(노이즈 X).
        this.tone(700, 0.03, "triangle", 0.038, 0, 560);
        break;
      case "hit":
        this.tone(200, 0.04, "sine", 0.045, 0, 120);
        break;
      case "lock":
        this.tone(220, 0.06, "sine", 0.06, 0, 120);
        break;
      case "harddrop":
        // 저역 쿵 + 서브 + 짧은 클릭 + 가벼운 에어리 스네어. 리버브로 "쿵—" 울림.
        this.tone(150, 0.13, "sine", 0.16, 0, 78);
        this.tone(60, 0.18, "sine", 0.12, 0, 40);
        this.tone(420, 0.035, "triangle", 0.06, 0, 200);
        this.fnoise(0.05, 0.025, "bandpass", 3000, 0.9, 1100);
        break;
      case "hold":
        // 부드러운 더블 비프(낮고 둥글게).
        this.tone(620, 0.06, "sine", 0.04, 0, undefined, 0.006);
        this.tone(520, 0.06, "sine", 0.035, 0.07, undefined, 0.006);
        break;
      case "clear1":
        this.clearBase(1, false);
        break;
      case "clear2":
        this.clearBase(2, false);
        break;
      case "clear3":
        this.clearBase(3, false);
        break;
      case "tetris":
        this.clearBase(4, false);
        break;
      case "tspin":
        this.clearBase(2, true);
        break;
      case "pc":
        // 퍼펙트 클리어 — 시원하게 "팡": 노이즈 크랙 + 저역 펀치 + 동시 화음 스탭 + 에어리 스네어
        this.fnoise(0.18, 0.13, "highpass", 1100);
        this.fnoise(0.1, 0.07, "highpass", 4500);
        this.tone(130, 0.26, "sine", 0.16, 0, 70);
        [523, 784, 1046, 1568].forEach((f, i) => this.tone(f, 0.4, "triangle", 0.07, i * 0.008, undefined, 0.004));
        this.fnoise(0.4, 0.04, "bandpass", 3200, 0.9, 900);
        break;
      case "b2b":
        break;
      case "combo":
        this.combo(2);
        break;
      case "levelup":
        this.arp([392, 523, 659], 0.08, "triangle");
        break;
      case "gameover":
        this.tone(190, 0.6, "sine", 0.2, 0, 80);
        break;
      case "ready":
        this.tone(440, 0.14, "triangle", 0.11, 0, 440, 0.02);
        break;
      case "go":
        this.tone(660, 0.22, "triangle", 0.15, 0, 880, 0.02);
        break;
    }
  }

  /**
   * 라인 클리어 베이스 — 싱글/더블/트리플은 동일 사운드, 테트리스(quad)·스핀만 별도.
   * 고조는 콤보 카운터가 담당.
   */
  private clearBase(lines: number, isSpin: boolean): void {
    if (!this.ctx || !this.opts.enabled) return;
    if (isSpin) {
      this.tone(110, 0.28, "sine", 0.1, 0, 70, 0.006);
      [330, 440, 554].forEach((f, i) => this.bell(f, 0.5, 0.05, i * 0.018));
      this.fnoise(0.35, 0.011, "bandpass", 2400, 0.9, 600);
    } else if (lines >= 4) {
      this.tone(110, 0.3, "sine", 0.13, 0, 70, 0.006);
      [262, 330, 392, 523].forEach((f, i) => this.bell(f, 0.52, 0.05, i * 0.018));
      this.bell(1046, 0.55, 0.03, 0.05);
      this.fnoise(0.34, 0.055, "bandpass", 3000, 0.9, 900);
    } else {
      this.tone(110, 0.26, "sine", 0.09, 0, 70, 0.006);
      this.bell(392, 0.42, 0.06, 0);
    }
  }

  /** 라인 클리어 — 종류별 베이스 + 콤보 상승 톤. */
  clear(lines: number, isSpin: boolean, b2b: boolean, combo: number): void {
    if (!this.opts.enabled) return;
    this.ensure();
    this.clearBase(lines, isSpin);
    if (b2b) this.tone(660, 0.3, "sine", 0.045, 0.02, undefined, 0.04);
    if (combo >= 2) this.combo(combo);
  }

  /** 콤보 — 메이저 스케일 상승 벨. 최상단 도달 시 고음 V자 플러리시. */
  combo(count: number): void {
    if (!this.opts.enabled) return;
    this.ensure();
    const steps = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
    const semi = steps[Math.min(Math.max(0, count - 1), steps.length - 1)];
    // 콤보 음정 한계(스케일 최상단) 도달 → "따라라라란" 고음 V자
    if (count - 1 >= steps.length - 1) {
      [2093, 1568, 1318, 1760, 2637].forEach((f, i) => this.bell(f, 0.4, 0.05, i * 0.08));
      return;
    }
    const f = 523 * Math.pow(2, semi / 12);
    this.bell(f, 0.35, 0.06);
  }

  /** 스핀 성립(공중) — 에어리 노이즈 스윕 + 저-중역 톤 꼬리. */
  spinHit(major = false): void {
    if (!this.opts.enabled) return;
    this.ensure();
    this.fnoise(0.3, 0.02, "bandpass", major ? 3600 : 3000, 1.1, 700);
    this.tone(major ? 560 : 480, 0.2, "sine", 0.055, 0.01, 300, 0.02);
  }

  /** 일반 B2B 끊김 — 순수 저음 톤. */
  b2bBreak(): void {
    if (!this.opts.enabled) return;
    this.ensure();
    this.tone(234, 0.22, "sine", 0.1, 0, 164, 0.05);
    this.tone(703, 0.12, "sine", 0.035, 0.02);
  }

  /** 사망 / 필드 리셋 — 부드러운 "우웅" 저음 하강. */
  death(): void {
    if (!this.opts.enabled) return;
    this.ensure();
    this.tone(190, 0.7, "sine", 0.2, 0, 78);
    this.tone(95, 0.7, "sine", 0.12, 0, 50);
  }

  /** B2B 서지 방출 — 묵직한 "쿠웅" 붐(lowpass 럼블 + 저역 사인). */
  surgeRelease(): void {
    if (!this.opts.enabled) return;
    this.ensure();
    if (!this.ctx || !this.sfxGain) return;
    const t = this.now();
    const dur = 1.8;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const env = Math.min(1, i / (len * 0.02)) * Math.pow(1 - i / len, 2.2);
      const n = (Math.random() * 2 - 1) * env;
      last = last + 0.12 * (n - last);
      d[i] = last * 3;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(400, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + dur);
    lp.Q.value = 0.7;
    const rg = this.ctx.createGain();
    rg.gain.value = 0.5;
    src.connect(lp);
    lp.connect(rg);
    rg.connect(this.sfxGain);
    src.start(t);
    src.stop(t + dur + 0.05);
    this.tone(48, 1.5, "sine", 0.42, 0, 30);
    this.tone(72, 1.0, "sine", 0.26, 0.02, 40);
    this.tone(96, 0.7, "sine", 0.14, 0.02, 60);
  }

  /** 공격 스파이크 — 저역 "펑펑" 버스트. 양 많을수록 펑 횟수↑. */
  spike(amount: number): void {
    if (!this.opts.enabled || amount <= 0) return;
    this.ensure();
    const big = Math.min(amount / 10, 1);
    const pops = Math.min(1 + Math.floor(amount / 3), 3);
    for (let i = 0; i < pops; i++) {
      const dl = i * 0.07;
      this.fnoise(0.14 + big * 0.08, 0.1 + big * 0.05, "lowpass", 520 - big * 200, 0.8, 110, dl);
      this.tone(150 - big * 55, 0.16 + big * 0.1, "sine", 0.12 + big * 0.07, dl, 58 - big * 18);
    }
  }

  resetCombo(): void {
    /* no-op */
  }
  resetSpin(): void {
    /* no-op */
  }

  private arp(freqs: number[], step: number, type: OscillatorType = "sine"): void {
    for (let i = 0; i < freqs.length; i++) {
      this.tone(freqs[i], step * 1.8, type, 0.075, i * step, undefined, 0.01);
    }
  }

  // ---- 배경음악: 16분음표 스텝 시퀀서 (베이스 펄스 + 아르페지오 + 코드 스탭 + 리드) ----
  private curTrack: BgmTrack = BGM_TRACKS.lobby;

  /** 트랙 지정 음악 시작. 다른 트랙이 재생 중이면 교체. */
  startMusic(track: BgmTrackId = "lobby"): void {
    const next = BGM_TRACKS[track];
    if (this.musicTimer !== null && this.curTrack === next) return;
    this.stopMusic();
    this.curTrack = next;
    this.ensure();
    if (!this.ctx) return;
    this.musicStep = 0;
    const tr = this.curTrack;
    const stepMs = 60000 / tr.bpm / 4; // 16분음표 길이
    const stepFn = () => {
      if (!this.opts.enabled || this.opts.music <= 0) return;
      this.seqStep(this.musicStep);
      this.musicStep++;
    };
    stepFn();
    this.musicTimer = setInterval(stepFn, stepMs);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  /** 한 16분음표 스텝 처리 */
  private seqStep(step: number): void {
    const tr = this.curTrack;
    const bars = tr.chords.length;
    const bar = Math.floor(step / 16) % bars;
    const s = step % 16; // 0..15
    const chord = tr.chords[bar];
    const root = chord[0];
    const stepSec = 60 / tr.bpm / 4;

    // 베이스 — 패턴에 따라 루트 펄스(한 옥타브 아래)
    if (tr.bass[s]) {
      this.note(root / 2, stepSec * 1.6, "triangle", 0.09, 0, tr.lp);
    }
    // 코드 스탭 — 짧게 삼화음
    if (tr.stab[s]) {
      for (const f of chord) this.note(f, stepSec * 1.8, tr.wave, 0.035, 0, tr.lp);
    }
    // 아르페지오 — arpRate마다 코드 음을 한 옥타브 위로 또박또박
    if (tr.arpRate > 0 && s % tr.arpRate === 0) {
      const ai = Math.floor(step / tr.arpRate);
      const f = chord[ai % chord.length] * 2;
      this.note(f, stepSec * tr.arpRate * 1.4, tr.wave, 0.045, 0, tr.lp + 800);
    }
    // 리드 — 패턴(반음 오프셋, null=쉼)
    if (tr.lead) {
      const off = tr.lead[s];
      if (off !== null) {
        this.note(root * 2 * Math.pow(2, off / 12), stepSec * 2.2, tr.wave, 0.05, 0, tr.lp + 1200);
      }
    }
  }

  /** 음악용 단음 — 빠른 어택 + 짧은 감쇠(플럭) */
  private note(freq: number, dur: number, type: OscillatorType, gain: number, delay: number, lpCut: number): void {
    if (!this.ctx || !this.musicGain) return;
    const t = this.now() + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lpCut;
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0006, gain * 0.04), t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.01);
    osc.connect(lp);
    lp.connect(g);
    g.connect(this.musicGain);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }
}

// ---- BGM 트랙 정의 (스텝 시퀀서) ----
export type BgmTrackId = "lobby" | "energetic" | "mysterious" | "building" | "chill";

interface BgmTrack {
  bpm: number;
  chords: number[][]; // 마디(bar)당 삼화음
  bass: number[]; // 16스텝 베이스 패턴(1/0)
  stab: number[]; // 16스텝 코드 스탭 패턴(1/0)
  arpRate: number; // 아르페지오 간격(스텝). 0=없음
  lead: (number | null)[] | null; // 16스텝 리드(반음 오프셋, null=쉼)
  wave: OscillatorType;
  lp: number;
}

const X = 1;
const o = 0;

const BGM_TRACKS: Record<BgmTrackId, BgmTrack> = {
  // 로비 — 잔잔하지만 살짝 움직이는 아르페지오 (Am-F-G-C)
  lobby: {
    bpm: 96,
    chords: [
      [220.0, 261.63, 329.63],
      [174.61, 220.0, 261.63],
      [196.0, 246.94, 293.66],
      [261.63, 329.63, 392.0],
    ],
    bass: [X, o, o, o, o, o, o, o, X, o, o, o, o, o, o, o],
    stab: [o, o, o, o, X, o, o, o, o, o, o, o, X, o, o, o],
    arpRate: 2,
    lead: null,
    wave: "triangle",
    lp: 1400,
  },
  // 신나는 — 빠른 드라이빙 베이스 + 16분 아르페지오 + 비트마다 스탭 (C-G-Am-F)
  energetic: {
    bpm: 152,
    chords: [
      [261.63, 329.63, 392.0],
      [246.94, 293.66, 392.0],
      [220.0, 261.63, 329.63],
      [174.61, 261.63, 349.23],
    ],
    bass: [X, o, o, X, o, o, X, o, X, o, o, X, o, o, X, o],
    stab: [X, o, o, o, X, o, o, o, X, o, o, o, X, o, o, o],
    arpRate: 1,
    lead: null,
    wave: "triangle",
    lp: 3000,
  },
  // 신비로운 — 느린 단조, 성긴 아르페지오 + 떠다니는 리드
  mysterious: {
    bpm: 104,
    chords: [
      [146.83, 174.61, 220.0],
      [174.61, 220.0, 261.63],
      [164.81, 196.0, 246.94],
      [146.83, 196.0, 233.08],
    ],
    bass: [X, o, o, o, o, o, o, o, X, o, o, o, o, o, o, o],
    stab: [o, o, o, o, o, o, o, o, o, o, o, o, o, o, o, o],
    arpRate: 3,
    lead: [o, null, null, null, null, null, 7, null, null, null, 5, null, null, null, null, null],
    wave: "sine",
    lp: 1100,
  },
  // 점증(마라톤) — 상승감 있는 중간 템포, 8분 베이스 + 16분 아르페지오
  building: {
    bpm: 134,
    chords: [
      [220.0, 261.63, 329.63],
      [261.63, 329.63, 392.0],
      [196.0, 246.94, 392.0],
      [164.81, 196.0, 246.94],
    ],
    bass: [X, o, X, o, X, o, X, o, X, o, X, o, X, o, X, o],
    stab: [X, o, o, o, o, o, X, o, o, o, X, o, o, o, o, o],
    arpRate: 2,
    lead: null,
    wave: "triangle",
    lp: 2000,
  },
  // 칠(4-wide/custom) — 부드러운 lo-fi, 성긴 아르페지오
  chill: {
    bpm: 88,
    chords: [
      [196.0, 246.94, 293.66],
      [174.61, 220.0, 277.18],
      [164.81, 207.65, 246.94],
      [146.83, 185.0, 233.08],
    ],
    bass: [X, o, o, o, o, o, X, o, X, o, o, o, o, o, o, o],
    stab: [o, o, o, o, X, o, o, o, o, o, o, o, X, o, o, o],
    arpRate: 4,
    lead: null,
    wave: "sine",
    lp: 1200,
  },
};

/** 게임 모드 → BGM 트랙 매핑 */
export function bgmForMode(mode: string): BgmTrackId {
  switch (mode) {
    case "sprint":
    case "blitz":
    case "combo":
      return "energetic";
    case "zen":
      return "mysterious";
    case "marathon":
      return "building";
    case "fourwide":
    case "custom":
      return "chill";
    default:
      return "lobby";
  }
}
