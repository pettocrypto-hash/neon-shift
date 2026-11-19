const PENTATONIC = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31, 34, 36];

/** Synthesised audio — no asset files, everything on oscillators. */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;
  private failed = false;
  private bedGain: GainNode | null = null;
  private bedLevel = -1;

  unlock(): void {
    this.ensure();
    this.startBed();
  }

  private ensure(): AudioContext | null {
    if (this.failed) return null;
    if (!this.ctx) {
      try {
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          this.failed = true;
          return null;
        }
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.4;
        this.master.connect(this.ctx.destination);
      } catch {
        this.failed = true;
        return null;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(24, slideTo), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  /**
   * The background bed: three detuned oscillators through a low pass. It is silent
   * until the chain raises the intensity, so the silence at the start stays a
   * silence and the music grows out of play, not out of nothing.
   */
  private startBed(): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.bedGain) return;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 260;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain);
    gain.connect(this.master);
    const voices: [number, OscillatorType][] = [
      [55, "sine"],
      [82.5, "sine"],
      [110, "triangle"],
    ];
    for (const [freq, type] of voices) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = Math.random() * 8 - 4;
      osc.connect(filter);
      osc.start();
    }
    this.bedGain = gain;
  }

  /**
   * 0..1 chain heat, ramped so the bed cannot click. Called every frame, so small
   * changes are dropped instead of piling up automation events that nobody hears.
   */
  setIntensity(value: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.bedGain) return;
    const target = this.muted ? 0 : 0.01 + Math.max(0, Math.min(1, value)) * 0.055;
    if (Math.abs(target - this.bedLevel) < 0.002) return;
    this.bedLevel = target;
    this.bedGain.gain.setTargetAtTime(target, ctx.currentTime, 0.25);
  }

  /** one sub-bass hit per landing, the audible twin of the screen rim */
  beatPulse(): void {
    this.tone(55, 0.24, "sine", 0.3, 42);
    this.tone(110, 0.11, "triangle", 0.07);
  }

  shard(combo: number, value: number): void {
    const step = PENTATONIC[Math.min(PENTATONIC.length - 1, combo % PENTATONIC.length)] ?? 0;
    const base = value >= 100 ? 523.25 : value >= 50 ? 440 : value >= 25 ? 392 : 349.23;
    const freq = base * Math.pow(2, step / 12);
    this.tone(freq, 0.15, "triangle", 0.45);
    this.tone(freq * 2, 0.07, "sine", 0.12);
  }

  cleanCut(): void {
    this.tone(880, 0.12, "sine", 0.36);
    this.tone(1320, 0.19, "sine", 0.22);
  }

  phase(): void {
    this.tone(110, 0.42, "triangle", 0.2, 196);
    this.tone(220, 0.3, "sine", 0.1, 330);
  }

  death(): void {
    this.tone(260, 0.3, "sawtooth", 0.32, 52);
    this.tone(96, 0.46, "sine", 0.28, 32);
  }
}
