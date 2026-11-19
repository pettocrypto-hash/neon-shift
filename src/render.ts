import { Container, Graphics, Text } from "pixi.js";
import {
  ORBIT_RADIUS,
  SHARD_STRIDE,
  SHARD_SLOTS,
  S_ACTIVE,
  S_ANGLE,
  S_COLLECTED,
  S_EXPIRE,
  S_SPAWN,
  S_VALUE,
  TURN,
  W_ACTIVE,
  W_ARRIVE,
  W_DRIFT,
  W_GAPHALF,
  W_SPAWN,
  W_START,
  WAVE_SLOTS,
  WAVE_STRIDE,
  phaseAtTick,
  type Run,
  waveCenterAt,
} from "./sim/sim";

const TAU = Math.PI * 2;
const CYAN = 0x37e8ff;
const GOLD = 0xffcf5c;
/** shortest signed angle difference, wrapped into (-PI, PI] */
function wrapPi(a: number): number {
  return (((a + Math.PI) % TAU) + TAU) % TAU - Math.PI;
}

/** lifetime of the death flare, exported so the overlay hold cannot drift from it */
export const DEATH_FLARE_MS = 700;

/** chain length that counts as fully heated: the one source for rim glow and audio bed */
export const COMBO_FULL = 14;

/** 0..1: how hot the current chain is. Rim and audio bed must agree on this. */
export function comboHeat(combo: number): number {
  return Math.min(1, combo / COMBO_FULL);
}

const RED = 0xff2b45;
const WHITE = 0xffffff;
/**
 * The scanner's own colour. It has to shift the wall's hue, not just add brightness: on the
 * saturated cyan core a violet stroke only pushes every channel to white and vanishes. Magenta
 * lifts red hard while leaving green low, so it reads as a colour change on the wall.
 */
const SCAN = 0xff4fd8;
/** narrow-pass reward: the one place gold is allowed outside the 100-shard */
const SLIP = 0xffd166;

export const VALUE_COLOR: Record<number, number> = { 10: 0x6fd7ff, 25: 0x9d7bff, 50: 0xff7a6b, 100: GOLD };

const num = (a: Int32Array, i: number): number => a[i] as number;

/**
 * Pixi's arc() joins the current point, which is (0,0) after every stroke(), so an
 * unguarded arc paints a chord from the centre. Always move to the arc start first.
 */
function arcAt(g: Graphics, r: number, from: number, to: number): Graphics {
  return g.moveTo(Math.cos(from) * r, Math.sin(from) * r).arc(0, 0, r, from, to, false);
}

/** nested translucent discs fake a gradient without a gradient dependency */
function soft(g: Graphics, x: number, y: number, radius: number, color: number, alpha: number, steps = 6): void {
  for (let k = steps; k >= 1; k--) g.circle(x, y, (radius * k) / steps).fill({ color, alpha: alpha / steps });
}

/** minimal hsl helper — keeps the palette in one place without a dependency */
function hsl(h: number, s: number, l: number): number {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hh / 60);
  const rgb =
    seg === 0 ? [c, x, 0] : seg === 1 ? [x, c, 0] : seg === 2 ? [0, c, x] : seg === 3 ? [0, x, c] : seg === 4 ? [x, 0, c] : [c, 0, x];
  const r = Math.round((rgb[0]! + m) * 255);
  const g = Math.round((rgb[1]! + m) * 255);
  const b = Math.round((rgb[2]! + m) * 255);
  return (r << 16) | (g << 8) | b;
}

interface Particle {
  a: number;
  r: number;
  va: number;
  vr: number;
  life: number;
  max: number;
  color: number;
  size: number;
}

interface Ring {
  r: number;
  vr: number;
  life: number;
  max: number;
  color: number;
  width: number;
}

interface Star {
  a: number;
  d: number;
  size: number;
  tw: number;
  /** 0 = far layer (slow, dim, small), 1 = near layer (fast, bright, large) */
  depth: number;
  drift: number;
  color: number;
}

interface Mote {
  a: number;
  r: number;
  va: number;
  vr: number;
  size: number;
  tw: number;
}

/**
 * Vector-only renderer: no textures, no filters, no assets. Depth comes from
 * layered translucent shapes with additive blending, which stays cheap enough
 * for a phone while looking far richer than flat primitives.
 */
export class Scene {
  private root = new Container();
  /** rebuilt only when the size or the phase hue changes */
  private bgStatic = new Graphics();
  private nebula = new Graphics();
  private fieldStatic = new Graphics();
  private field = new Graphics();
  private waves = new Graphics();
  /** normal blending: additive red over a blue field turns pink, threat must stay red */
  private danger = new Graphics();
  private shards = new Graphics();
  private ship = new Graphics();
  private fx = new Graphics();
  /** screen-edge glow: the one layer that is visible even on a 320 px phone */
  private rim = new Graphics();
  /** "+N" at the landing point, one Text per hit, destroyed when it expires */
  private floaters: { t: Text; angle: number; life: number }[] = [];

  private stars: Star[] = [];
  private dust: Mote[] = [];
  /** unwrapped radians: a wrap can never fold the ribbon across the arena */
  private trail: number[] = [];
  private trailPos = -1;
  private lastRad = 0;
  private parts: Particle[] = [];
  private rings: Ring[] = [];
  /** light trails that run from a collected shard to the core */
  private streaks: { a: number; t: number; color: number }[] = [];

  private px = 320;
  private py = 320;
  private scale = 140;
  private time = 0;
  private shake = 0;
  private flash = 0;
  private flashTimes: number[] = [];
  private reduceMotion = false;
  private reduceFlash = false;

  private hue = 190;
  private lastPhase = 0;
  /** 0 → 1 across a phase change: the arc that runs once around the ring */
  private phaseSweep = 1;
  /** the short wash in the new accent colour, fades faster than the arc */
  private phaseWash = 0;
  private lastDir = 0;
  private tapPulse = 0;
  /** tap afterimages: where the hull was a moment ago, along the direction it left */
  private ghosts: { a: number; dir: number; life: number; i: number }[] = [];
  private lastActiveWaves = 0;
  /** set by the wave that just landed clean: it still owes its white ring */
  private ringDue = false;
  private wasAlive = true;
  private coreEnergy = 0;
  private nearPulse = 0;
  private nearEdge = 0;
  private lastMargin = -1;
  private beatPulse = 0;
  /** 1 on the death tick, decays over 0.7 s: the red band running inward */
  private deathFlare = 0;
  /** radians of the impact, kept because the ship is gone from the sim by then */
  private deathAngle = 0;
  /** waves already celebrated, so a two-frame tick cannot fire twice */
  private landed = new Set<number>();
  private cacheHue = -1;
  private cacheW = 0;
  private cacheH = 0;
  private cacheRebuilds = 0;

  /** how often the static layers were rebuilt: 0 on a steady frame, +1 per phase or resize */
  get rebuilds(): number {
    return this.cacheRebuilds;
  }

  /** gap margin of the last landing: 1 = on the edge, > 1 would have been death */
  get landMargin(): number {
    return this.lastMargin;
  }

  /** 1 on a landing tick, decaying: the audio engine fires its bass pulse on its edge */
  get beat(): number {
    return this.beatPulse;
  }

  constructor(stage: Container) {
    this.root.addChild(
      this.bgStatic,
      this.nebula,
      this.fieldStatic,
      this.field,
      this.waves,
      this.danger,
      this.shards,
      this.ship,
      this.fx,
      this.rim,
    );
    stage.addChild(this.root);
    for (const g of [this.nebula, this.fieldStatic, this.field, this.waves, this.shards, this.ship, this.fx, this.rim]) {
      g.blendMode = "add";
    }
    this.makeStars();
  }

  resize(w: number, h: number): void {
    this.px = w / 2;
    this.py = h / 2;
    this.scale = Math.min(w, h) * 0.42;
    this.root.position.set(this.px, this.py);
    this.makeStars();
  }

  setAccessibility(reduceFlash: boolean, reduceMotion: boolean): void {
    this.reduceFlash = reduceFlash;
    this.reduceMotion = reduceMotion;
  }

  reset(): void {
    this.trail.length = 0;
    this.trailPos = -1;
    this.lastRad = 0;
    this.parts.length = 0;
    this.rings.length = 0;
    this.streaks.length = 0;
    this.flash = 0;
    this.shake = 0;
    this.wasAlive = true;
    this.tapPulse = 0;
    this.ghosts.length = 0;
    this.hue = 190;
    this.lastPhase = 0;
    this.phaseSweep = 1;
    this.phaseWash = 0;
    this.nearPulse = 0;
    this.beatPulse = 0;
    this.deathFlare = 0;
    this.deathAngle = 0;
    for (const f of this.floaters) f.t.destroy();
    this.floaters.length = 0;
    this.lastMargin = -1;
    this.ringDue = false;
    this.landed.clear();
  }

  private makeStars(): void {
    this.dust = [];
    for (let i = 0; i < (this.reduceMotion ? 16 : 42); i++) {
      this.dust.push({
        a: Math.random() * TAU,
        r: Math.random() * 1.4,
        va: (Math.random() - 0.5) * 0.0035,
        vr: 0.0006 + Math.random() * 0.0016,
        size: 0.6 + Math.random() * 1.2,
        tw: Math.random() * TAU,
      });
    }
    this.stars = [];
    for (let i = 0; i < (this.reduceMotion ? 26 : 58); i++) this.pushStar(0);
    for (let i = 0; i < (this.reduceMotion ? 14 : 32); i++) this.pushStar(1);
  }

  /**
   * Two layers, one ratio: the near layer drifts about six times faster than the far
   * one, and is bigger and brighter. Nothing else moves the background, so that
   * difference alone is what makes the field read as depth.
   */
  private pushStar(depth: number): void {
    const near = depth === 1;
    this.stars.push({
      depth,
      a: Math.random() * TAU,
      d: 0.5 + Math.random() * 1.5,
      size: near ? 1 + Math.random() * 1.6 : 0.4 + Math.random() * 0.7,
      tw: Math.random() * TAU,
      drift: (near ? 0.000075 : 0.000013) * (0.85 + Math.random() * 0.3),
      color: Math.random() < 0.22 ? 0x9d7bff : Math.random() < 0.5 ? 0xd8f6ff : 0x6fd7ff,
    });
  }

  /** angle arrives in sim ticks, everything drawn here is radians */
  burst(angle: number, color: number, count: number, power = 1): void {
    if (this.reduceMotion) count = Math.ceil(count / 2);
    const rad = (angle / TURN) * TAU;
    const r0 = ORBIT_RADIUS * this.scale;
    for (let i = 0; i < count; i++) {
      const max = 320 + Math.random() * 460;
      this.parts.push({
        a: rad + (Math.random() - 0.5) * 0.07,
        r: r0 * (0.96 + Math.random() * 0.08),
        va: (Math.random() - 0.5) * 0.008 * power,
        vr: (Math.random() * 0.55 + 0.1) * 0.55 * power,
        life: max,
        max,
        color,
        size: 0.9 + Math.random() * 2.4,
      });
    }
    if (this.parts.length > 420) this.parts.splice(0, this.parts.length - 420);
    if (power >= 1.1) this.shock(0.55, color, 2.5);
    this.coreEnergy = Math.min(1, this.coreEnergy + 0.25 * power);
  }

  /** a streak that flies from the shard's spot on the orbit into the core */
  streak(angle: number, color: number): void {
    this.streaks.push({ a: ((angle / TURN) * TAU), t: 0, color });
    if (this.streaks.length > 10) this.streaks.shift();
  }

  /**
   * The hull slipped through with almost nothing to spare. Called once per wave,
   * on the arrival tick, when the gap edge came within a sixth of its half-width.
   */
  /**
   * The last frame a wall is visible: one landing per wave. Also decides whether the
   * ship cut it close (gold diamond) or went through comfortably (white ring).
   */
  private land(spawn: number, shipRad: number, gapCentre: number, half: number): void {
    if (this.landed.has(spawn)) return;
    this.landed.add(spawn);
    this.beatPulse = 1;
    const dS = wrapPi(shipRad - gapCentre);
    this.lastMargin = Math.abs(dS) / half;
    // the wave itself decides its landing feedback, so the ring site never has to
    // re-read a margin that may already belong to a different wave
    this.ringDue = this.lastMargin <= 0.86;
    if (!this.ringDue) this.nearPass(gapCentre + Math.sign(dS || 1) * half);
  }

  /** narrow pass reward: gold double diamond at the brushed edge plus two slashes */
  private drawSlip(g: Graphics, r0: number): void {
    const k = this.nearPulse;
    if (k <= 0) return;
    const grow = 1 - k;
    const ex0 = Math.cos(this.nearEdge) * r0;
    const ey0 = Math.sin(this.nearEdge) * r0;
    // starts a beat after the landing, so it never overlaps the white landing ring
    if (grow > 0.12) {
      // capped at ~60 px: the reward must stay smaller than the orbit it happened on,
      // otherwise it reads as a stray shape instead of a sparkle at the edge
      const alpha = k * k;
      for (const s of [1, 0.62]) {
        const rad = (46 + grow * 14) * s;
        const spin = (this.time / 700) * (s === 1 ? 1 : -1) + grow * 0.9;
        const pts: number[] = [];
        for (let i = 0; i < 4; i++) {
          const a = spin + (i / 4) * TAU;
          pts.push(ex0 + Math.cos(a) * rad, ey0 + Math.sin(a) * rad);
        }
        g.poly(pts).stroke({ width: 5 * s, color: SLIP, alpha: alpha * s });
        g.poly(pts).stroke({ width: 16 * s, color: SLIP, alpha: 0.16 * alpha * s });
      }
    }
    const rr = r0 + 10 + grow * 22;
    for (const off of [-0.05, 0.05]) {
      const a = this.nearEdge + off;
      g.moveTo(Math.cos(a) * (rr - 16), Math.sin(a) * (rr - 16))
        .lineTo(Math.cos(a) * (rr + 16), Math.sin(a) * (rr + 16))
        .stroke({ width: 4, color: SLIP, alpha: 0.9 * k });
    }
  }

  /**
   * Ghosts behind the hull, spaced along the direction it just left. They are static
   * once spawned — they only fade — so reduceMotion keeps two of them: the tap still
   * has to be readable, the same rule that keeps the "+N" number.
   */
  private spawnGhosts(angle: number, oldDir: number): void {
    // spacing in pixels, converted to radians: 0.22 rad was 22 px on a 390 wide screen
    // and only 18 px on a 320 one, so the chain got tighter exactly where it matters
    const r0 = Math.max(1, ORBIT_RADIUS * this.scale);
    const step = 22 / r0;
    for (let i = 1; i <= (this.reduceMotion ? 2 : 3); i++) {
      this.ghosts.push({ a: angle - oldDir * step * i, dir: oldDir, life: 1 - i * 0.08, i });
    }
    if (this.ghosts.length > 9) this.ghosts.splice(0, this.ghosts.length - 9);
  }

  /** "+N" at a landing: angle in TURN units, the same space burst() uses */
  addFloat(angle: number, value: number, color: number): void {
    if (this.floaters.length > 5) {
      this.floaters.shift()?.t.destroy();
    }
    const t = new Text({
      text: `+${value}`,
      style: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 15,
        fontWeight: "700",
        fill: color,
        stroke: { color: 0x05070f, width: 3 },
      },
    });
    t.anchor.set(0.5);
    this.root.addChild(t);
    this.floaters.push({ t, angle: (angle / TURN) * TAU, life: 1 });
  }

  private nearPass(edgeRad: number): void {
    // deliberately no round shock ring here: the diamond below is the signal
    this.burst((edgeRad / TAU) * TURN, 0xffffff, this.reduceMotion ? 4 : 8, 0.7);
    this.nearEdge = edgeRad;
    this.nearPulse = 1;
    this.coreEnergy = Math.min(1, this.coreEnergy + 0.18);
  }

  private shock(power: number, color: number, width = 3): void {
    const r0 = ORBIT_RADIUS * this.scale;
    this.rings.push({ r: r0 * 0.9, vr: 0.09 * power, life: 520, max: 520, color, width });
    if (this.rings.length > 18) this.rings.splice(0, this.rings.length - 18);
  }

  screenFlash(strength: number): void {
    if (this.reduceFlash) return;
    const now = this.time;
    this.flashTimes = this.flashTimes.filter((t) => now - t < 1000);
    if (this.flashTimes.length >= 3) return; // hard two-to-three-per-second budget
    this.flashTimes.push(now);
    this.flash = Math.max(this.flash, strength * 0.5);
  }

  addShake(v: number): void {
    if (this.reduceMotion) return;
    this.shake = Math.max(this.shake, v);
  }

  update(run: Run | null, dtMs: number, frozen = false): void {
    this.time += dtMs;
    const dt = Math.min(dtMs, 60);
    /** effect clock: stands still while the game is paused or the run has ended */
    const fxDt = frozen ? 0 : dt;
    const r0 = ORBIT_RADIUS * this.scale;
    const hyp = Math.sqrt(this.px * this.px + this.py * this.py) * 1.25;

    const phase = run ? Math.min(40, Math.max(1, phaseAtTick(run.tick))) : 1;
    this.hue = 190 + Math.min(150, (phase - 1) * 12);
    if (run && this.lastPhase !== 0 && phase !== this.lastPhase) {
      // the phase change gets its own language — wash plus one lap of arc. No shock
      // ring here: that flat "something happened" belongs to hits and death.
      this.phaseWash = 1;
      this.phaseSweep = 0;
    }
    this.lastPhase = run ? phase : 0;
    const accent = hsl(this.hue, 0.95, 0.62);
    /** complementary second accent keeps the instrument from reading as monochrome */
    const accent2 = hsl(this.hue + 120, 0.85, 0.66);
    this.coreEnergy = Math.max(0, this.coreEnergy - fxDt / 900);
    if (run && run.combo > 1) this.coreEnergy = Math.max(this.coreEnergy, comboHeat(run.combo));

    // --------------------------------------------------- static layers (cached)
    // Wash, grid, brackets and the fixed track depend only on size and phase
    // hue, so they are rebuilt on change instead of every single frame.
    if (this.cacheHue !== this.hue || this.cacheW !== this.px || this.cacheH !== this.py) {
      this.cacheHue = this.hue;
      this.cacheW = this.px;
      this.cacheH = this.py;
      this.cacheRebuilds++;
      const bs = this.bgStatic.clear();
      // graded backdrop: deep indigo up top, near black at the bottom. Bands are
      // only drawn when this cache rebuilds, so the gradient itself is free.
      const bands = 44;
      const top = this.py + 60;
      const bandH = (top * 2) / bands;
      for (let i = 0; i < bands; i++) {
        const k = i / (bands - 1);
        bs.rect(-this.px - 60, -top + i * bandH, this.px * 2 + 120, bandH + 0.6)
          .fill({ color: hsl(214 + (this.hue - 190) * 0.18, 0.62, 0.035 + 0.05 * (1 - k)), alpha: 1 });
      }
      // broad wash behind the arena, so the play space never reads as flat black
      soft(bs, 0, 0, r0 * 2.1, hsl(this.hue + 40, 0.9, 0.35), 0.16);
      soft(bs, 0, 0, r0 * 1.25, hsl(this.hue + 10, 0.9, 0.45), 0.18);
      // vignette: a very thick dark ring pushed outside the play area
      bs.circle(0, 0, hyp).stroke({ width: hyp * 0.55, color: 0x000000, alpha: 0.52 });
      bs.circle(0, 0, hyp * 0.72).stroke({ width: hyp * 0.22, color: 0x000000, alpha: 0.16 });

      const fs = this.fieldStatic.clear();
      // dot matrix over the whole view, one fill for every dot
      for (let gx = -this.px; gx <= this.px; gx += 44) {
        for (let gy = -this.py; gy <= this.py; gy += 44) fs.circle(gx, gy, 1);
      }
      fs.fill({ color: accent, alpha: 0.035 });
      // corner brackets, viewport frame and telemetry ticks
      const bx = this.px - 16;
      const by = this.py - 16;
      for (const c of [-1, 1]) {
        for (const r of [-1, 1]) {
          fs.moveTo(c * bx, r * by - r * 22).lineTo(c * bx, r * by).lineTo(c * bx - c * 22, r * by);
        }
      }
      fs.stroke({ width: 1.4, color: accent, alpha: 0.3 });
      fs.rect(-this.px + 5, -this.py + 5, this.px * 2 - 10, this.py * 2 - 10).stroke({ width: 1, color: accent, alpha: 0.07 });
      for (const c of [-1, 1]) {
        for (let i = 0; i < 3; i++) fs.moveTo(c * (bx - 8), by - 34 - i * 7).lineTo(c * (bx - 26 + i * 5), by - 34 - i * 7);
      }
      fs.stroke({ width: 1, color: accent, alpha: 0.2 });
      // fixed track rings
      fs.circle(0, 0, r0 * 1.03).stroke({ width: 34, color: accent, alpha: 0.045 });
      fs.circle(0, 0, r0).stroke({ width: 3, color: hsl(this.hue, 0.8, 0.45), alpha: 0.16 });
      fs.circle(0, 0, r0).stroke({ width: 1.2, color: 0xd8f6ff, alpha: 0.45 });
      // chromatic fringe: a high-tech split of the track into cool and warm edges
      fs.circle(0, 0, r0 - 1.8).stroke({ width: 1, color: 0xff4fd8, alpha: 0.16 });
      fs.circle(0, 0, r0 + 1.8).stroke({ width: 1, color: 0x4ff0ff, alpha: 0.16 });
      fs.circle(0, 0, r0 * 1.12).stroke({ width: 1, color: accent, alpha: 0.12 });
      fs.circle(0, 0, r0 * 0.62).stroke({ width: 1, color: accent, alpha: 0.06 });
      fs.circle(0, 0, r0 * 0.36).stroke({ width: 1, color: accent, alpha: 0.05 });
    }

    // the nebula still drifts, so it stays on the dynamic layer
    const bg = this.nebula.clear();
    for (let i = 0; i < 5; i++) {
      const a = this.time / (9000 + i * 2600) + (i / 5) * TAU;
      const dist = this.scale * (0.45 + i * 0.28);
      const radius = this.scale * (0.68 + (i % 3) * 0.24);
      const color = i % 2 === 0 ? hsl(this.hue + 20, 0.85, 0.45) : hsl(this.hue + 90, 0.8, 0.38);
      // six steps per cloud were 30 fills a frame. The stacked circles cannot be merged —
      // their accumulation *is* the soft falloff — so the ramp drops to four steps instead:
      // 20 fills, same linear falloff, same cloud layout.
      soft(bg, Math.cos(a) * dist, Math.sin(a) * dist, radius, color, 0.13, 4);
    }

    // --------------------------------------------------------------- field
    const fg = this.field.clear();
    // One path per (layer, colour, brightness bucket). Ninety individual dots used to
    // cost ninety fills — 70 % of every draw operation in the frame — for points that
    // are one or two pixels wide. Four brightness buckets are indistinguishable there,
    // and each bucket now costs a single fill.
    const groups = new Map<string, { color: number; alpha: number; pts: number[] }>();
    const crosses: number[] = [];
    for (const s of this.stars) {
      s.a += s.drift * dt;
      const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.time / 620 + s.tw));
      const dist = s.d * this.scale * 1.35;
      const size = s.size * (this.reduceMotion ? 0.8 : 1);
      const ssx = Math.cos(s.a) * dist;
      const ssy = Math.sin(s.a) * dist;
      // the far layer stays dim on purpose: it must sit behind, not compete
      const near = s.depth === 1;
      // The near layer is bright enough for a coarse staircase to read as flicker, so it gets
      // eight steps (2.2x alpha over 8 = 0.055 per step); the far layer stays at four.
      const levels = near ? 8 : 4;
      const level = Math.round(((tw - 0.45) / 0.55) * levels);
      const shade = 0.45 + (level / levels) * 0.55;
      const key = `${s.depth}:${s.color}:${level}`;
      let g = groups.get(key);
      if (!g) {
        g = { color: s.color, alpha: (near ? 0.7 : 0.34) * shade, pts: [] };
        groups.set(key, g);
      }
      g.pts.push(ssx, ssy, size);
      if (near && size > 1.4) {
        // the halo is large and soft: a coarse bucket is invisible there, so it stays at four.
        // The key must use the *coarse* level too — keyed on the fine one, every fine step
        // opened its own halo group and the buckets never met.
        const glowLevel = Math.round(level / 2);
        const glowKey = `g:${s.depth}:${s.color}:${glowLevel}`;
        let gg = groups.get(glowKey);
        if (!gg) {
          gg = { color: s.color, alpha: 0.14 * (0.45 + (glowLevel / 4) * 0.55), pts: [] };
          groups.set(glowKey, gg);
        }
        gg.pts.push(ssx, ssy, size * 2.6);
        // bright stars get a diffraction cross, all crosses in one path
        const sp = size * 5.5;
        crosses.push(ssx - sp, ssy, ssx + sp, ssy, ssx, ssy - sp, ssx, ssy + sp);
      }
    }
    for (const g of groups.values()) {
      for (let i = 0; i < g.pts.length; i += 3) fg.circle(g.pts[i]!, g.pts[i + 1]!, g.pts[i + 2]!);
      fg.fill({ color: g.color, alpha: g.alpha });
    }
    if (crosses.length > 0) {
      for (let i = 0; i < crosses.length; i += 4) {
        fg.moveTo(crosses[i]!, crosses[i + 1]!).lineTo(crosses[i + 2]!, crosses[i + 3]!);
      }
      fg.stroke({ width: 0.9, color: 0xd8f6ff, alpha: 0.22 });
    }

    const spin = this.time / 5200;
    const shipT = run ? (run.shipAngle / TURN) * TAU : 99;
    // every group is one path and one stroke: 96 ticks cost three draw calls, not 96
    const ticks = (pick: (major: boolean, lit: boolean) => boolean, width: number, color: number, alpha: number): void => {
      for (let i = 0; i < 96; i++) {
        const a = spin + (i / 96) * TAU;
        const major = i % 8 === 0;
        if (!pick(major, run !== null && Math.cos(a - shipT) > 0.55)) continue;
        const inner = r0 * (major ? 1.045 : 1.03);
        const outer = r0 * (major ? 1.075 : 1.055);
        fg.moveTo(Math.cos(a) * inner, Math.sin(a) * inner).lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
      }
      fg.stroke({ width, color, alpha });
    };
    ticks((major, lit) => !lit && !major, 1, accent, 0.12);
    ticks((major, lit) => !lit && major, 1.6, accent, 0.3);
    ticks((_major, lit) => lit, 1.4, WHITE, 0.55);

    // direction chevrons, so the sense of travel is readable
    if (run && run.alive === 1) {
      const sign = run.dir >= 0 ? 1 : -1;
      for (let k = 1; k <= 2; k++) {
        const ca = shipT + sign * k * 0.14;
        const cx = Math.cos(ca) * r0;
        const cy = Math.sin(ca) * r0;
        const tx = -Math.sin(ca) * sign;
        const ty = Math.cos(ca) * sign;
        fg.poly([
          cx + tx * 5, cy + ty * 5,
          cx - tx * 2 + Math.cos(ca) * 3.2, cy - ty * 2 + Math.sin(ca) * 3.2,
          cx - tx * 2 - Math.cos(ca) * 3.2, cy - ty * 2 - Math.sin(ca) * 3.2,
        ]).fill({ color: WHITE, alpha: 0.22 });
      }
    }

    // nested mandala shells behind the core, counter-rotating
    for (let m = 0; m < 2; m++) {
      const rot = ((m === 0 ? 1 : -1) * this.time) / (5200 + m * 2600);
      const rad = r0 * (0.44 + m * 0.26);
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = rot + (i / 6) * TAU;
        pts.push(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      fg.poly(pts).stroke({ width: 1, color: accent, alpha: 0.14 });
    }

    // outer instrument scale
    for (let i = 0; i < 120; i++) {
      const a = -spin * 0.6 + (i / 120) * TAU;
      const len = i % 10 === 0 ? 9 : 4;
      fg.moveTo(Math.cos(a) * r0 * 1.36, Math.sin(a) * r0 * 1.36)
        .lineTo(Math.cos(a) * (r0 * 1.36 + len), Math.sin(a) * (r0 * 1.36 + len));
    }
    fg.stroke({ width: 1, color: accent2, alpha: 0.22 });

    // radar sweep, a soft rotating wedge. Eight slivers became three: the fan is a 1 %-alpha
    // gradient, so stepping it in three bands instead of eight is not visible. Each band keeps
    // the summed alpha of the slivers it replaces.
    const sweep = this.time / 3200;
    const sweepBands = [
      { first: 0, last: 1, alpha: 0.105 },
      { first: 2, last: 4, alpha: 0.07 },
      { first: 5, last: 7, alpha: 0.028 },
    ];
    for (const band of sweepBands) {
      for (let k = band.first; k <= band.last; k++) {
        const a0 = sweep - k * 0.045;
        fg.moveTo(0, 0).arc(0, 0, r0 * 1.28, a0 - 0.045, a0, false);
      }
      fg.fill({ color: accent, alpha: band.alpha });
    }

    // drifting dust motes: cheap depth cue across the whole arena. Same batching as the
    // stars — brightness buckets, one fill each, instead of one per mote. Six steps, not
    // three: the motes twinkle between 0.02 and 0.18 alpha, so three buckets jumped by 44 %.
    const dustPts: number[][] = [[], [], [], [], [], []];
    for (const d of this.dust) {
      d.a += d.va * (dt / 16);
      d.r += d.vr * (dt / 16);
      if (d.r > 1.45) {
        d.r = 0.25;
        d.a = Math.random() * TAU;
      }
      const al = 0.1 + 0.08 * Math.sin(this.time / 900 + d.tw);
      const lvl = Math.round(((al - 0.02) / 0.16) * 5);
      dustPts[lvl]!.push(Math.cos(d.a) * d.r * r0, Math.sin(d.a) * d.r * r0, d.size);
    }
    for (let lvl = 0; lvl < dustPts.length; lvl++) {
      const pts = dustPts[lvl]!;
      if (pts.length === 0) continue;
      for (let i = 0; i < pts.length; i += 3) fg.circle(pts[i]!, pts[i + 1]!, pts[i + 2]!);
      fg.fill({ color: accent2, alpha: 0.02 + (lvl / 5) * 0.16 });
    }

    // volumetric rays from the core: narrow at the hub, wide at the rim
    // all eight rays in one path and one fill: same alpha, so nothing is lost
    for (let i = 0; i < 8; i++) {
      const a = this.time / 9000 + (i / 8) * TAU;
      const spread = 0.05 + 0.02 * Math.sin(this.time / 1700 + i);
      const len = r0 * (1.16 + 0.1 * Math.sin(this.time / 2400 + i * 1.7));
      fg.poly([
        Math.cos(a) * 18, Math.sin(a) * 18,
        Math.cos(a - spread) * len, Math.sin(a - spread) * len,
        Math.cos(a + spread) * len, Math.sin(a + spread) * len,
      ]);
    }
    fg.fill({ color: accent, alpha: 0.04 });

    // sonar: rings drift out of the core and fade, so the floor has a pulse
    for (let k = 0; k < 3; k++) {
      const t = (this.time / 4200 + k / 3) % 1;
      fg.circle(0, 0, r0 * (0.18 + t * 1.1)).stroke({ width: 1.2, color: accent, alpha: 0.18 * (1 - t) });
    }

    // dashed halo ring, all dashes in one stroke
    const spin2 = -this.time / 7000;
    for (let i = 0; i < 36; i++) {
      const a0 = spin2 + (i / 36) * TAU;
      arcAt(fg, r0 * 1.22, a0, a0 + TAU / 36 * 0.55);
    }
    fg.stroke({ width: 1, color: accent, alpha: 0.09 });
    // aurora ribbons far behind the arena
    for (let i = 0; i < 3; i++) {
      const a0 = this.time / (15000 + i * 5000) + i * 2.1;
      arcAt(fg, r0 * (1.5 + i * 0.3), a0, a0 + 1.9)
        .stroke({ width: 30 + i * 12, color: hsl(this.hue + 60 + i * 45, 0.9, 0.5), alpha: 0.03 });
    }
    // energy nodes on the inner ring, brighter with combo
    const nodeGlow = run ? Math.min(1, run.combo / 8) : 0;
    for (let i = 0; i < 6; i++) {
      const a = this.time / 4200 + (i / 6) * TAU;
      const nx = Math.cos(a) * r0 * 0.78;
      const ny = Math.sin(a) * r0 * 0.78;
      fg.circle(nx, ny, 2.2 + nodeGlow * 1.6).fill({ color: accent, alpha: 0.3 + nodeGlow * 0.45 });
      fg.circle(nx, ny, 8 + nodeGlow * 6).fill({ color: accent, alpha: 0.05 + nodeGlow * 0.06 });
    }

    // ----------------------------------------------------------------- core
    const breathe = (1 + Math.sin(this.time / 900) * 0.045) * (1 + this.coreEnergy * 0.35);
    for (let i = 5; i >= 1; i--) {
      fg.circle(0, 0, (14 + i * 11) * breathe).fill({ color: accent, alpha: 0.04 + 0.025 * i });
    }
    fg.circle(0, 0, 24 * breathe).fill({ color: WHITE, alpha: 0.14 });
    fg.circle(0, 0, 12 * breathe).fill({ color: WHITE, alpha: 0.95 });
    // rotating hex shell around the core
    const hex: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = this.time / 2600 + (i / 6) * TAU;
      hex.push(Math.cos(a) * 34 * breathe, Math.sin(a) * 34 * breathe);
    }
    fg.poly(hex).stroke({ width: 1.2, color: accent, alpha: 0.22 });
    // counter-rotating second shell and a segmented reactor ring
    const hex2: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = -this.time / 3400 + 0.5 + (i / 6) * TAU;
      hex2.push(Math.cos(a) * 50 * breathe, Math.sin(a) * 50 * breathe);
    }
    fg.poly(hex2).stroke({ width: 1, color: accent, alpha: 0.13 });
    for (let i = 0; i < 12; i++) {
      const a0 = this.time / 1800 + (i / 12) * TAU;
      arcAt(fg, 20 * breathe, a0, a0 + 0.16);
    }
    fg.stroke({ width: 2, color: accent2, alpha: 0.4 });
    // core arcs
    for (let i = 0; i < 3; i++) {
      const a0 = this.time / (1400 + i * 500) + (i / 3) * TAU;
      arcAt(fg, 26 + i * 7, a0, a0 + 1.6).stroke({ width: 1.6, color: accent, alpha: 0.4 - i * 0.09 });
    }
    // combo gauge: a ring around the core that fills with the chain
    if (run && run.combo > 0) {
      const k = Math.min(1, run.combo / 12);
      const from = -Math.PI / 2;
      arcAt(fg, 41, from, from + TAU * k).stroke({ width: 3, color: accent, alpha: 0.5 });
      arcAt(fg, 46, from, from + TAU * k).stroke({ width: 1, color: WHITE, alpha: 0.22 });
    }
    // lens flare cross
    const flare = 30 + this.coreEnergy * 26;
    fg.moveTo(-flare, 0).lineTo(flare, 0).stroke({ width: 1.4, color: 0xffffff, alpha: 0.18 + this.coreEnergy * 0.25 });
    fg.moveTo(0, -flare * 0.62).lineTo(0, flare * 0.62).stroke({ width: 1.4, color: 0xffffff, alpha: 0.12 + this.coreEnergy * 0.18 });

    // ---------------------------------------------------------------- waves
    const wg = this.waves.clear();
    const dg = this.danger.clear();
    let active = 0;
    /** how dangerous the current ship position is: 0 in the gap, 1 in a closing wall */
    let threat = 0;
    /** gap centre of the wave that threatens the ship most, -1 when safe */
    let aim = -1;
    /** metronome: 1 exactly on an arrival tick, decaying over the next ~0.7 s */
    let beat = 0;
    // one ship angle for the combo arc and the wave loop, instead of two copies of the same line
    const shipRad = run ? (run.shipAngle / TURN) * TAU : 0;
    // combo arc: the chain written on the ring, right behind the ship's travel. Length comes
    // from run.combo, brightness from comboHeat — the same heat that drives the rim — and it
    // is two strokes, so a whole chain costs two draw operations whatever its length.
    if (run && run.alive === 1 && run.combo > 0) {
      const heat = comboHeat(run.combo);
      const span = (Math.min(run.combo, COMBO_FULL) / COMBO_FULL) * 0.9;
      const tail = shipRad - (run.dir >= 0 ? span : -span);
      const lo = Math.min(shipRad, tail);
      const hi = Math.max(shipRad, tail);
      arcAt(wg, r0 * 1.2, lo, hi).stroke({ width: 10, color: accent, alpha: 0.12 + 0.3 * heat });
      arcAt(wg, r0 * 1.2, lo, hi).stroke({ width: 3, color: WHITE, alpha: 0.32 + 0.45 * heat });
    }
    if (run) {
      for (let s = 0; s < WAVE_SLOTS; s++) {
        const o = s * WAVE_STRIDE;
        if (num(run.waves, o + W_ACTIVE) === 0) continue;
        active++;
        const spawn = num(run.waves, o + W_SPAWN);
        const arrive = num(run.waves, o + W_ARRIVE);
        const span = arrive - spawn;
        if (span <= 0) continue;
        const prog = (run.tick - spawn) / span;
        if (prog < 0 || prog > 1.8) continue;
        const r = prog <= 1 ? r0 * prog : r0 + (prog - 1) * this.scale * 0.7;
        const fade = prog <= 1 ? 0.3 + prog * 0.7 : Math.max(0, 1 - (prog - 1) / 0.8);
        const center = waveCenterAt(
          num(run.waves, o + W_START),
          num(run.waves, o + W_DRIFT),
          spawn,
          arrive,
          Math.min(run.tick, arrive),
        );
        const half = (num(run.waves, o + W_GAPHALF) / TURN) * TAU;
        const a0 = (center / TURN) * TAU;
        const start = a0 + half;
        const end = a0 + TAU - half;
        // urgency shifts the colour towards red as the wave closes in
        const urgency = Math.max(0, Math.min(1, 1 - (arrive - run.tick) / 34));
        // threat reads pure red — gold is reserved for the 100-shard alone
        const waveColor = urgency > 0.02 ? RED : accent;
        const pulse = 0.85 + 0.15 * Math.sin(this.time / 90);

        // layered halo: three steps are enough, a fourth at 2% alpha only cost fill
        arcAt(wg, r, start, end).stroke({ width: 46, color: waveColor, alpha: 0.05 * fade * pulse });
        arcAt(wg, r, start, end).stroke({ width: 18, color: waveColor, alpha: 0.09 * fade * pulse });
        arcAt(wg, r, start, end).stroke({ width: 7, color: waveColor, alpha: 0.25 * fade * pulse });
        arcAt(wg, r, start, end).stroke({ width: 2.2, color: 0xeaffff, alpha: fade });
        // bevel: the core lights the wall from inside, so the inner lip is bright and
        // the outer lip cuts dark into the halo — that asymmetry reads as thickness
        arcAt(wg, r + 5, start, end).stroke({ width: 9, color: 0x04070e, alpha: 0.6 * fade });
        arcAt(wg, r - 9, start, end).stroke({ width: 2, color: WHITE, alpha: 0.55 * fade });
        // wall echo: as the wall closes in it throws a soft afterglow into its own halo — one
        // stroke, and it only exists while urgency does, so it belongs to the moment before landing.
        if (urgency > 0.02) {
          arcAt(wg, r + 22, start, end).stroke({ width: 14, color: waveColor, alpha: 0.18 * urgency * fade });
        }
        // trailing speed streaks: the wall reads as fast, not as a thin line. Kept as seven
        // strokes on purpose: below r = 36 px their radial spans start behind the centre and
        // the lines cross there, so one shared path would render that crossing once instead
        // of adding it up seven times.
        for (let i = 0; i < 7; i++) {
          const sa = start + ((end - start) * (i + 0.5)) / 7;
          const ex = Math.cos(sa);
          const ey = Math.sin(sa);
          wg.moveTo(ex * (r - 36), ey * (r - 36)).lineTo(ex * (r - 9), ey * (r - 9))
            .stroke({ width: 1.4, color: waveColor, alpha: 0.2 * fade });
        }
        // segmented energy dashes on the inside of the arc
        const segs = 26;
        for (let i = 0; i < segs; i++) {
          const t0 = start + ((end - start) * i) / segs;
          arcAt(wg, r - 6, t0, t0 + ((end - start) / segs) * 0.5);
        }
        wg.stroke({ width: 3, color: waveColor, alpha: 0.5 * fade });
        // energy streaks flowing along the inside of the wall
        const span2 = end - start;
        const flow = (this.time / 110) % span2;
        for (let i = 0; i < 12; i++) {
          const t0 = start + ((i / 12) * span2 + flow) % span2;
          arcAt(wg, r - 14, t0, t0 + 0.07);
        }
        wg.stroke({ width: 1.4, color: 0xffffff, alpha: 0.22 * fade });
        // scan line: one bright segment running along the wall's length, 0.9 rad/s. It sits on the
        // wall's dark outer lip (r + 6) — on the wall body a white line would add itself onto an
        // already white core and vanish — and it keeps its own alpha instead of the wall's fade,
        // so it reads as a scanner rather than as part of the wall. Faded in over 15 px instead of
        // switching on at a threshold, and it shares span2 with the flow streaks.
        const scanAt = start + ((this.time / 1100) % span2);
        const scanLen = Math.min(0.28, end - scanAt);
        const scanIn = Math.min(1, Math.max(0, (r - 30) / 15));
        // the scanner rides on the wall, so it shares the wall's fate: it dims with the wall's fade
        // instead of staying at full strength while the wall around it fades out.
        const scanAlpha = scanIn * fade;
        if (scanLen > 0.03 && scanAlpha > 0.02) {
          arcAt(wg, r + 6, scanAt, scanAt + scanLen).stroke({ width: 8, color: SCAN, alpha: scanAlpha });
        }
        const sinceArrive = run.tick - arrive;
        // Final approach: 54 ticks (0.45 s) of pulsing gap. Long enough for a
        // 250 ms reaction plus one tap of correction, short enough that the wall
        // is already visibly close, so the pulse reads as "now", not "soon".
        if (sinceArrive < 0 && sinceArrive >= -54) {
          const k = 1 + sinceArrive / 54;
          const blink = 0.55 + 0.45 * Math.sin(this.time / (40 - 18 * k));
          arcAt(fg, r0, a0 - half, a0 + half).stroke({ width: 7, color: WHITE, alpha: (0.12 + 0.4 * k) * blink });
          for (const edge of [start, end]) {
            const ex = Math.cos(edge);
            const ey = Math.sin(edge);
            fg.moveTo(ex * r0 * 0.92, ey * r0 * 0.92)
              .lineTo(ex * r0 * (1.05 + 0.1 * k), ey * r0 * (1.05 + 0.1 * k));
          }
          fg.stroke({ width: 2 + 4 * k, color: WHITE, alpha: 0.3 + 0.65 * k * blink });
        }
        // The sim clears the slot on the arrival tick, so the last frame the wall
        // is visible is one tick before it lands. Everything that belongs to the
        // landing has to happen here, once per wave.
        if (sinceArrive >= -1) this.land(spawn, shipRad, a0, half);
        if (this.beatPulse > 0.04) beat = Math.max(beat, this.beatPulse);
        // is the ship standing in the wall that is about to arrive?
        if (urgency > 0.14) {
          if (Math.abs(wrapPi(shipRad - a0)) > half && urgency >= threat) {
            threat = urgency;
            aim = a0;
          }
        }
        // gap caps stay per edge on purpose: they sit on the *growing* wall radius, and at
        // r below ~20 px the two ends are closer than the 9 px halo — merged, the overlap
        // would render once instead of adding up, and the opening would look dimmer exactly
        // while it is still tiny near the core.
        for (const edge of [start, end]) {
          const ex = Math.cos(edge);
          const ey = Math.sin(edge);
          wg.moveTo(ex * (r - 12), ey * (r - 12)).lineTo(ex * r, ey * r).stroke({ width: 2.4, color: 0xffffff, alpha: 0.65 * fade });
          wg.circle(ex * r, ey * r, 3.2).fill({ color: 0xffffff, alpha: 0.9 * fade });
          wg.circle(ex * r, ey * r, 9).fill({ color: waveColor, alpha: 0.16 * fade });
        }
        // chevrons at both gap edges, pointing into the opening
        if (prog < 1.15 && fade > 0.3) {
          for (const edge of [start, end]) {
            const dirIn = edge === start ? -1 : 1;
            const ex = Math.cos(edge);
            const ey = Math.sin(edge);
            const tx = -ey * dirIn;
            const ty = ex * dirIn;
            const px0 = ex * (r0 + 17);
            const py0 = ey * (r0 + 17);
            wg.moveTo(px0 - tx * 11 + ex * 5, py0 - ty * 11 + ey * 5)
              .lineTo(px0 + tx * 2, py0 + ty * 2)
              .lineTo(px0 - tx * 11 - ex * 5, py0 - ty * 11 - ey * 5);
          }
          wg.stroke({ width: 2, color: WHITE, alpha: 0.45 * fade });
        }
        // safe-zone hint exactly on the orbit, so the gap reads before the wave arrives
        if (prog < 1.05) {
          arcAt(wg, r0, a0 - half, a0 + half).stroke({ width: 4, color: waveColor, alpha: 0.16 * fade });
          // instrument pointer outside the orbit, aimed at the gap centre
          const gx = Math.cos(a0);
          const gy = Math.sin(a0);
          wg.moveTo(gx * r0 * 1.15, gy * r0 * 1.15).lineTo(gx * r0 * 1.33, gy * r0 * 1.33)
            .stroke({ width: 3, color: waveColor, alpha: 0.55 * fade });
          const remain = Math.max(0, 1 - prog);
          wg.circle(gx * r0 * 1.12, gy * r0 * 1.12, 3.2 + 4.2 * (1 - remain)).fill({ color: WHITE, alpha: 0.75 * fade });
          // countdown: a bar outside the orbit closes onto the gap centre
          arcAt(fg, r0 * 1.44, a0 - half * remain, a0 + half * remain)
            .stroke({ width: 5, color: waveColor, alpha: 0.4 + 0.45 * (1 - remain) });
        }
        // gap projection: two thin rays from the opening's edges out to the orbit, so
        // the landing spot is readable from prog 0.2 on, not only on the last stretch
        if (prog > 0.2 && prog < 1) {
          const pa = Math.min(0.55, 0.18 + (prog - 0.2) * 1.2) * fade;
          for (const edge of [start, end]) {
            const ex = Math.cos(edge);
            const ey = Math.sin(edge);
            wg.moveTo(ex * r, ey * r).lineTo(ex * r0, ey * r0);
          }
          wg.stroke({ width: 1.5, color: waveColor, alpha: pa });
        }
        // danger corridor: the wall about to hit the orbit glows red and throws beams inward
        if (urgency > 0.04 && prog < 1.2) {
          const rim = Math.min(1, Math.max(0, (prog - 0.5) / 0.5));
          arcAt(dg, r0 + 7, start, end).stroke({ width: 7, color: RED, alpha: 0.85 * urgency * rim * pulse });
          arcAt(dg, r0 + 7, start, end).stroke({ width: 2, color: 0xffd8dd, alpha: 0.9 * urgency * rim });
          for (const edge of [start, end]) {
            const ex = Math.cos(edge);
            const ey = Math.sin(edge);
            dg.moveTo(ex * r0 * 0.82, ey * r0 * 0.82).lineTo(ex * r0 * 1.04, ey * r0 * 1.04);
          }
          dg.stroke({ width: 3, color: RED, alpha: 0.9 * urgency });
          for (const edge of [start, end]) dg.circle(Math.cos(edge) * r0, Math.sin(edge) * r0, 4.5);
          dg.fill({ color: RED, alpha: 0.95 * urgency });
        }
      }
    }
    // A landed wave releases a quiet ring at the orbit, unless it was a narrow pass:
    // that one already got its gold diamond.
    if (run && run.alive === 1 && this.lastActiveWaves > active && this.ringDue) {
      this.ringDue = false;
      this.shock(0.7, 0xffffff, 2);
    }
    this.lastActiveWaves = run ? active : 0;

    // ------------------------------------------------------------- screen rim
    // The rhythm belongs to the whole frame, not only to the track: every landing
    // breathes at the screen edge and a long chain keeps the edge warm. Seven nested
    // strokes fake the falloff, so it stays one draw call per frame.
    const rimG = this.rim.clear();
    const rimW = this.px * 2;
    const rimH = this.py * 2;

    // phase change: a wash in the new accent, then an arc that laps the ring once.
    // Both run on fxDt, so pausing keeps the moment still.
    this.phaseWash = Math.max(0, this.phaseWash - fxDt / 420);
    this.phaseSweep = Math.min(1, this.phaseSweep + fxDt / 700);
    if (this.phaseWash > 0.01) {
      const wash = 0.13 * this.phaseWash * (this.reduceFlash ? 0.25 : 1);
      rimG.rect(-this.px, -this.py, rimW, rimH).fill({ color: accent, alpha: wash });
    }
    if (this.phaseSweep < 1 && !this.reduceMotion) {
      const head = this.phaseSweep * TAU;
      const trail = 0.6 + 1.1 * (1 - this.phaseSweep);
      const fade = 1 - this.phaseSweep * 0.6;
      arcAt(rimG, r0 * 1.04, head - trail, head).stroke({ width: 10, color: accent, alpha: 0.3 * fade });
      arcAt(rimG, r0 * 1.04, head - trail, head).stroke({ width: 3, color: WHITE, alpha: 0.7 * fade });
      arcAt(rimG, r0 * 1.04, head - 0.035, head).stroke({ width: 7, color: WHITE, alpha: 0.9 * fade });
    }
    const heat = run && run.alive === 1 ? comboHeat(run.combo) : 0;
    const rimGlow = (0.9 * beat + 0.3 * heat) * (this.reduceFlash ? 0.4 : 1) * (this.reduceMotion ? 0.55 : 1);
    if (rimGlow > 0.012) {
      for (let i = 0; i < 7; i++) {
        const inset = 2 + i * 12;
        const a = rimGlow * (1 - i / 7) ** 2 * 0.75;
        rimG
          .roundRect(-this.px + inset, -this.py + inset, rimW - inset * 2, rimH - inset * 2, 36)
          .stroke({ width: 14, color: accent, alpha: a });
      }
    }

    // death: one red band runs inward from the edge and fades. It owns the frame for
    // DEATH_FLARE_MS, and main.ts holds the game-over overlay back by the same value.
    this.deathFlare = Math.max(0, this.deathFlare - fxDt / DEATH_FLARE_MS);
    if (this.deathFlare > 0.01) {
      const spread = 1 - this.deathFlare;
      const inset = 2 + spread * Math.min(this.px, this.py) * 0.72;
      for (let i = 0; i < 6; i++) {
        const off = inset + i * 13;
        const a = this.deathFlare ** 1.4 * (1 - i / 6) ** 2 * (this.reduceFlash ? 0.3 : 0.8);
        rimG
          .roundRect(-this.px + off, -this.py + off, rimW - off * 2, rimH - off * 2, 34)
          .stroke({ width: 16, color: RED, alpha: a });
      }
      // a thin white inner edge stops the red from reading as a plain brightening
      rimG
        .roundRect(-this.px + inset, -this.py + inset, rimW - inset * 2, rimH - inset * 2, 34)
        .stroke({ width: 2, color: WHITE, alpha: this.deathFlare * (this.reduceFlash ? 0.2 : 0.55) });
      // rail debris: twelve red ticks leave the track where the wall hit
      for (let i = 0; i < 12; i++) {
        const a = this.deathAngle + (i - 5.5) * 0.14;
        const rr = r0 + spread * 95;
        rimG
          .moveTo(Math.cos(a) * (rr - 7), Math.sin(a) * (rr - 7))
          .lineTo(Math.cos(a) * (rr + 7), Math.sin(a) * (rr + 7))
          .stroke({ width: 3, color: RED, alpha: this.deathFlare * 0.55 });
      }
    }

    // points float up from the spot they were scored at, so the HUD is not the only
    // place the reward exists
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i]!;
      f.life = Math.max(0, f.life - fxDt / 780);
      // the number is information, not decoration: with reduceMotion it stays where it
      // appeared and only fades, so the score is still readable without movement
      const rise = this.reduceMotion ? 0 : (1 - f.life) * 26;
      const rad = r0 + 24 + rise;
      f.t.position.set(Math.cos(f.angle) * rad, Math.sin(f.angle) * rad);
      f.t.alpha = Math.min(1, f.life * 1.8);
      f.t.scale.set(this.reduceMotion ? 1 : 1 + (1 - f.life) * 0.18);
      if (f.life <= 0) {
        f.t.destroy();
        this.floaters.splice(i, 1);
      }
    }

    // beat metronome: the track flashes on the arrival tick, so the rhythm is felt
    if (beat > 0.03 && !this.reduceMotion) {
      fg.circle(0, 0, r0).stroke({ width: 2 + beat * 12, color: WHITE, alpha: 0.62 * beat });
      fg.circle(0, 0, r0).stroke({ width: 34, color: accent, alpha: 0.16 * beat });
      fg.circle(0, 0, r0 * (1 + (1 - beat) * 0.05)).stroke({ width: 1.2, color: accent, alpha: 0.25 * beat });
    }

    // rail highlight: drawn late because its colour depends on the threat above
    if (run && run.alive === 1) {
      arcAt(fg, r0, shipT - 0.55, shipT + 0.55).stroke({ width: 12, color: accent, alpha: 0.05 });
      arcAt(fg, r0, shipT - 0.55, shipT + 0.55).stroke({ width: 3, color: threat > 0 ? RED : WHITE, alpha: 0.16 });
    }

    // --------------------------------------------------------------- shards
    const sg = this.shards.clear();
    if (run) {
      for (let i = 0; i < SHARD_SLOTS; i++) {
        const o = i * SHARD_STRIDE;
        if (num(run.shards, o + S_ACTIVE) === 0) continue;
        if (num(run.shards, o + S_COLLECTED) === 1) continue;
        const spawn = num(run.shards, o + S_SPAWN);
        const expire = num(run.shards, o + S_EXPIRE);
        if (run.tick < spawn || run.tick > expire) continue;
        const angle = num(run.shards, o + S_ANGLE);
        const value = num(run.shards, o + S_VALUE);
        const a = (angle / TURN) * TAU;
        // a tiny radial bob gives the shards life without lying about their angle
        const bob = 1.5 * Math.sin(this.time / 300 + i);
        const x = Math.cos(a) * (r0 + bob);
        const y = Math.sin(a) * (r0 + bob);
        const life = (expire - run.tick) / Math.max(1, expire - spawn);
        const alpha = 0.4 + Math.min(1, life) * 0.6;
        const wob = 1 + Math.sin(this.time / 230 + i * 1.7) * 0.09;
        const rad = (6 + (value >= 100 ? 9 : value >= 50 ? 6.5 : value >= 25 ? 4.5 : 2.6)) * wob;
        const color = VALUE_COLOR[value] ?? CYAN;
        const spinA = this.time / (value >= 50 ? 420 : 700) + i;

        sg.circle(x, y, rad * 4.2).fill({ color, alpha: 0.09 * alpha });
        sg.circle(x, y, rad * 2.4).fill({ color, alpha: 0.2 * alpha });
        // spawn pulse: a ring leaves the shard so a fresh one is noticed
        const age = run.tick - spawn;
        if (age < 34) {
          const k = age / 34;
          sg.circle(x, y, rad * (1 + k * 2.4)).stroke({ width: 1.8 * (1 - k), color, alpha: 0.75 * (1 - k) });
        }

        if (value <= 10) {
          sg.circle(x, y, rad).fill({ color: WHITE, alpha: alpha * 0.9 });
          sg.circle(x, y, rad * 1.8).fill({ color, alpha: 0.35 * alpha });
        } else {
          // 25 diamond, 50 square, 100 hexagon: one polygon path for all three
          const sides = value >= 100 ? 6 : 4;
          const rr = rad * (value >= 100 ? 1.45 : 1.5);
          const rot = value === 50 ? 0 : spinA;
          const pts: number[] = [];
          for (let k = 0; k < sides; k++) {
            const ang = rot + (k / sides) * TAU;
            pts.push(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
          }
          if (value >= 100) {
            sg.poly(pts).stroke({ width: 1.6, color: GOLD, alpha });
            const sp = rr * 1.6;
            sg.moveTo(x - sp, y).lineTo(x + sp, y).stroke({ width: 1, color: GOLD, alpha: 0.5 * alpha });
            sg.moveTo(x, y - sp).lineTo(x, y + sp).stroke({ width: 1, color: GOLD, alpha: 0.5 * alpha });
          } else {
            sg.poly(pts).fill({ color, alpha });
            sg.poly(pts).stroke({ width: 1, color: WHITE, alpha: 0.5 * alpha });
          }
          // lock-on brackets around the rare shards
          if (value >= 50) {
            const br = rr * 2.15;
            for (let q = 0; q < 4; q++) {
              const qa = (q * Math.PI) / 2 + Math.PI / 4 + spinA * 0.35;
              sg.moveTo(x + Math.cos(qa - 0.34) * br, y + Math.sin(qa - 0.34) * br)
                .lineTo(x + Math.cos(qa) * br, y + Math.sin(qa) * br)
                .lineTo(x + Math.cos(qa + 0.34) * br, y + Math.sin(qa + 0.34) * br);
            }
            sg.stroke({ width: 1.2, color, alpha: 0.45 * alpha });
          }
          if (value === 50) {
            const s3 = rad * 0.56;
            sg.rect(x - s3, y - s3, s3 * 2, s3 * 2).fill({ color: WHITE, alpha: 0.5 * alpha });
          } else {
            sg.circle(x, y, rad * 0.6).fill({ color: WHITE, alpha: 0.7 * alpha });
          }
        }
      }
    }

    // ---------------------------------------------------------------- ship
    const pg = this.ship.clear();
    if (run) {
      if (run.alive === 1) {
        if (this.trail.length === 0) {
          this.lastRad = (run.shipAngle / TURN) * TAU;
          this.trail.push(this.lastRad);
          this.trailPos = run.shipAngle;
        } else if (this.trailPos !== run.shipAngle) {
          const raw = (run.shipAngle / TURN) * TAU;
          this.trail.push((this.trail[this.trail.length - 1] ?? 0) + wrapPi(raw - this.lastRad));
          this.lastRad = raw;
          this.trailPos = run.shipAngle;
          if (this.trail.length > (this.reduceMotion ? 10 : 26)) this.trail.shift();
        }
        if (this.lastDir !== 0 && this.lastDir !== run.dir) {
          this.tapPulse = 1;
          this.spawnGhosts((run.shipAngle / TURN) * TAU, this.lastDir);
        }
      }
      this.lastDir = run.dir;
      this.tapPulse = Math.max(0, this.tapPulse - fxDt / 220);
      for (let i = this.ghosts.length - 1; i >= 0; i--) {
        const g = this.ghosts[i]!;
        g.life -= fxDt / 260;
        if (g.life <= 0) this.ghosts.splice(i, 1);
      }
      this.nearPulse = Math.max(0, this.nearPulse - fxDt / 340);
      this.beatPulse = Math.max(0, this.beatPulse - fxDt / 620);

      const sa = (run.shipAngle / TURN) * TAU;
      const sx = Math.cos(sa) * r0;
      const sy = Math.sin(sa) * r0;

      // comet tail: one tapered ribbon along the orbit. The angles are unwrapped,
      // so the polygon can never fold across the 0 <-> TAU seam.
      // Short and deliberately flat: 26 ticks of trail are ~4% of the orbit, so a
      // gradient inside it was invisible on a phone and only cost a closure per frame.
      const n = this.trail.length;
      if (n > 2) {
        const pts: number[] = [];
        for (let i = 0; i < n; i++) {
          const ta = this.trail[i] ?? 0;
          const w = 0.5 + (i / n) * 4.6;
          pts.push(Math.cos(ta) * (r0 + w), Math.sin(ta) * (r0 + w));
        }
        for (let i = n - 1; i >= 0; i--) {
          const ta = this.trail[i] ?? 0;
          const w = 0.5 + (i / n) * 4.6;
          pts.push(Math.cos(ta) * (r0 - w), Math.sin(ta) * (r0 - w));
        }
        pg.poly(pts).fill({ color: accent, alpha: 0.15 });
      }

      // ship glow + body, pointing along its travel direction
      const heading = sa + (run.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      const pulse = 1 + this.tapPulse * 0.35;
      // headlight cone, so the orbit reads as a scanned path
      const coneWidth = 0.3;
      const coneLen = 86 * pulse;
      pg.poly([
        sx,
        sy,
        sx + Math.cos(heading - coneWidth) * coneLen,
        sy + Math.sin(heading - coneWidth) * coneLen,
        sx + Math.cos(heading + coneWidth) * coneLen,
        sy + Math.sin(heading + coneWidth) * coneLen,
      ]).fill({ color: accent, alpha: 0.06 });
      pg.circle(sx, sy, 30 * pulse).fill({ color: accent, alpha: 0.12 });
      pg.circle(sx, sy, 14 * pulse).fill({ color: accent, alpha: 0.32 });
      // tap afterimages sit over the glow but under the hull, so the real ship still
      // reads as the front of the group
      for (const g of this.ghosts) {
        // staggered in and out of the rail: sitting exactly on the bright orbit line
        // swallowed them, and alternating gives the group a staggered read
        const gx = Math.cos(g.a) * (r0 + (g.i % 2 === 0 ? 5 : -5));
        const gy = Math.sin(g.a) * (r0 + (g.i % 2 === 0 ? 5 : -5));
        const gh = g.a + (g.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
        // size and stagger follow from the ordinal: the real hull is always the
        // biggest and brightest, so the group can never be mistaken for it
        const gs = 0.95 - g.i * 0.14;
        const gnx = Math.cos(gh) * 12 * gs;
        const gny = Math.sin(gh) * 12 * gs;
        const gwx = Math.cos(gh + Math.PI / 2) * 6 * gs;
        const gwy = Math.sin(gh + Math.PI / 2) * 6 * gs;
        // bright white, not cyan: the hull's own glow is cyan, so a white echo sits on
        // top of it instead of inside it. Filled, because an outline was too quiet.
        pg.poly([
          gx + gnx, gy + gny,
          gx - gnx * 0.5 + gwx, gy - gny * 0.5 + gwy,
          gx - gnx * 0.5 - gwx, gy - gny * 0.5 - gwy,
        ])
          .fill({ color: WHITE, alpha: g.life * (this.reduceMotion ? 0.45 : 0.75) })
          .stroke({ width: 1.2, color: 0xd8f6ff, alpha: g.life * (this.reduceMotion ? 0.55 : 0.9) });
      }
      const nose = 13 * pulse;
      const back = 7.5 * pulse;
      const wing = 6.2 * pulse;
      const nx = sx + Math.cos(heading) * nose;
      const ny = sy + Math.sin(heading) * nose;
      const b1x = sx - Math.cos(heading) * back + Math.cos(heading + Math.PI / 2) * wing;
      const b1y = sy - Math.sin(heading) * back + Math.sin(heading + Math.PI / 2) * wing;
      const b2x = sx - Math.cos(heading) * back - Math.cos(heading + Math.PI / 2) * wing;
      const b2y = sy - Math.sin(heading) * back - Math.sin(heading + Math.PI / 2) * wing;
      pg.poly([nx, ny, b1x, b1y, sx - Math.cos(heading) * 2.5, sy - Math.sin(heading) * 2.5, b2x, b2y]).fill({ color: 0xffffff, alpha: 0.95 });
      pg.poly([nx, ny, b1x, b1y, b2x, b2y]).stroke({ width: 1.2, color: accent, alpha: 0.9 });
      // exhaust
      for (let k = 1; k <= 3; k++) {
        const d = back + k * 4;
        pg.circle(sx - Math.cos(heading) * d, sy - Math.sin(heading) * d, 3.2 - k * 0.7).fill({ color: accent, alpha: 0.3 / k });
      }
      // combo rings: the ship visibly charges up
      if (run.combo >= 4) {
        const k = Math.min(1, run.combo / 12);
        pg.circle(sx, sy, 18 + k * 12).stroke({ width: 1.6, color: accent, alpha: 0.15 + k * 0.35 });
        pg.circle(sx, sy, 24 + k * 18).stroke({ width: 1, color: WHITE, alpha: 0.06 + k * 0.14 });
      }
      // standing outside the gap while a wall closes in reads red, immediately
      if (threat > 0) {
        dg.circle(sx, sy, 23).stroke({ width: 2, color: RED, alpha: 0.3 + 0.55 * threat });
        dg.circle(sx, sy, 31).stroke({ width: 1, color: RED, alpha: 0.18 * threat });
      }
      // which way to the gap, while standing in the wall
      if (threat > 0 && aim >= 0) {
        const gapDelta = wrapPi(aim - sa);
        const toGap = gapDelta >= 0 ? 1 : -1;
        const ax = Math.cos(sa);
        const ay = Math.sin(sa);
        // dotted path home along the orbit: which way, and how far still to go
        const steps = Math.max(3, Math.min(20, Math.round(Math.abs(gapDelta) / 0.14)));
        for (let i = 0; i < steps; i++) {
          const t0 = sa + (gapDelta / steps) * i;
          arcAt(pg, r0, t0, t0 + (gapDelta / steps) * 0.5).stroke({
            width: 3,
            color: WHITE,
            alpha: (0.14 + 0.32 * threat) * (0.55 + 0.45 * Math.sin(this.time / 90 - i * 0.5)),
          });
        }
        const cx = sx - ax * 34;
        const cy = sy - ay * 34;
        for (const side of [1, -1]) {
          pg.moveTo(cx, cy)
            .lineTo(cx - ax * 9 + side * ay * toGap * 10, cy - ay * 9 - side * ax * toGap * 10)
            .stroke({ width: 2.4, color: WHITE, alpha: (0.3 + 0.5 * threat) * (0.7 + 0.3 * Math.sin(this.time / 70)) });
        }
        // a second, smaller chevron stacked behind the first: the direction is unmistakable
        const bx = cx - ay * toGap * 15;
        const by = cy + ax * toGap * 15;
        for (const side of [1, -1]) {
          pg.moveTo(bx, by)
            .lineTo(bx - ax * 6 + side * ay * toGap * 6, by - ay * 6 - side * ax * toGap * 6)
            .stroke({ width: 1.6, color: WHITE, alpha: (0.18 + 0.35 * threat) });
        }
      }
      // narrow pass: its own gold diamond, deliberately not a ring
      this.drawSlip(pg, r0);
      // tap shockwave
      if (this.tapPulse > 0.6) {
        pg.circle(sx, sy, 10 + (1 - this.tapPulse) * 26).stroke({ width: 1.6, color: 0xffffff, alpha: (this.tapPulse - 0.6) * 1.6 });
      }
    }

    // ----------------------------------------------------------- particles
    const xg = this.fx.clear();
    if (this.reduceMotion) this.streaks.length = 0;
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      if (s === undefined) {
        this.streaks.splice(i, 1);
        continue;
      }
      s.t += fxDt / 320;
      if (s.t >= 1) {
        // the streak lands: the core takes the energy visibly
        this.coreEnergy = Math.min(1, this.coreEnergy + 0.14);
        this.streaks.splice(i, 1);
        continue;
      }
      const k = 1 - s.t;
      const r = r0 * k;
      const x = Math.cos(s.a) * r;
      const y = Math.sin(s.a) * r;
      xg.moveTo(Math.cos(s.a) * (r + r0 * 0.12 * k), Math.sin(s.a) * (r + r0 * 0.12 * k))
        .lineTo(x, y)
        .stroke({ width: 3.2 * k, color: s.color, alpha: 0.85 * k });
      xg.circle(x, y, 6 * k).fill({ color: s.color, alpha: 0.35 * k });
    }
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      if (p === undefined) {
        this.parts.splice(i, 1);
        continue;
      }
      p.life -= dt;
      if (p.life <= 0) {
        this.parts.splice(i, 1);
        continue;
      }
      p.a += p.va * (fxDt / 16);
      p.r += p.vr * (fxDt / 16);
      const k = p.life / p.max;
      const x = Math.cos(p.a) * p.r;
      const y = Math.sin(p.a) * p.r;
      xg.circle(x, y, p.size * (0.35 + k)).fill({ color: p.color, alpha: k * 0.85 });
      xg.circle(x, y, p.size * (1.4 + k * 2)).fill({ color: p.color, alpha: k * 0.12 });
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      if (ring === undefined) {
        this.rings.splice(i, 1);
        continue;
      }
      ring.life -= dt;
      if (ring.life <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      ring.r += ring.vr * ring.max * (fxDt / 1000) * 6;
      const k = ring.life / ring.max;
      xg.circle(0, 0, ring.r).stroke({ width: ring.width * k, color: ring.color, alpha: k * k * 0.7 });
    }

    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - fxDt / 130);
      xg.rect(-this.px, -this.py, this.px * 2, this.py * 2).fill({ color: accent, alpha: 0.05 * this.flash });
    }

    // death shockwave, detected here so main.ts stays free of view details
    if (run && this.wasAlive && run.alive === 0) {
      this.shock(1.6, RED, 5);
      this.shock(1.0, 0xffffff, 2);
      this.flash = Math.max(this.flash, this.reduceFlash ? 0 : 0.4);
      this.coreEnergy = 1;
      // the hull itself comes apart, and the frame answers once
      this.deathFlare = 1;
      this.deathAngle = (run.shipAngle / TURN) * TAU;
      this.burst(run.shipAngle, RED, this.reduceMotion ? 9 : 24, 1.5);
      this.shake = Math.max(this.shake, 0.6);
    }
    this.wasAlive = run ? run.alive === 1 : true;

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - fxDt / 100);
      const amp = this.shake * 9;
      this.root.position.set(this.px + (Math.random() - 0.5) * amp, this.py + (Math.random() - 0.5) * amp);
    } else {
      this.root.position.set(this.px, this.py);
    }
  }
}
