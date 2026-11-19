/**
 * NEON SHIFT — simulation core, M0, RULES_VERSION 7.
 *
 * v7 withdraws v6: the 12000 gap with a 120-tick lead only paid off for players
 * tapping four or more times per wave. v5's table (10500 / lead 210) dominates
 * v4 at one to four taps per wave, so it is the entry the game keeps.
 *
 * Rules of this module:
 *  - No imports. No DOM. No Pixi. Runs unchanged in Node.
 *  - No Math.random / Date / performance / Math.sin|cos. No floats in state.
 *  - Everything is an integer; angles are 1/65536 turn (TURN).
 *  - Flat state: integers + preallocated Int32Arrays. No class hierarchy.
 *
 * See the build spec for the tick order, the spawn plan and the hash field list.
 */

// ---------------------------------------------------------------- constants

export const TURN = 65536;
export const TICK_HZ = 120;
export const SHIP_SPEED = 300;
export const ORBIT_RADIUS = 0.62;
export const SHARD_RADIUS = 1500;
export const PHASE_TICKS = 720;
export const WAVE_SLOTS = 4;
export const SHARD_SLOTS = 24;
export const MAX_TAPS_PER_TICK = 1;
export const HASH_EVERY_TICKS = 240;
export const RULES_VERSION = 7;
export const REPLAY_FORMAT_VERSION = 1;
export const SHARD_VALUES = [10, 25, 50, 100] as const;
export const CLEAN_CUT_PERCENT = 35;
export const REACH_PERCENT = 85;
export const DRIFT_PERCENT_MAX = 30;
export const MIN_GAP_HALF = 2400;
export const MIN_INTERVAL = 88;
export const MIN_LEAD = 96;
export const COMBO_BREAK_DISTANCE = 19660; // truncDiv(TURN * 30, 100)
export const MAX_CATCHUP_TICKS = 14;
export const MAX_WAVE_ATTEMPTS = 16;
export const MIN_SHIFT = 4096;
export const SCORE_CAP = 2000000000;
export const START_ANGLE = 0;
export const START_DIR = 1;

/** wave slot layout */
export const W_ACTIVE = 0;
export const W_SPAWN = 1;
export const W_ARRIVE = 2;
export const W_START = 3;
export const W_DRIFT = 4;
export const W_GAPHALF = 5;
export const W_PHASE = 6;
export const W_ID = 7;
export const WAVE_STRIDE = 8;

/** shard slot layout */
export const S_ACTIVE = 0;
export const S_ANGLE = 1;
export const S_SPAWN = 2;
export const S_EXPIRE = 3;
export const S_VALUE = 4;
export const S_COLLECTED = 5;
export const S_MISSED = 6;
export const S_REACHABLE = 7;
export const S_ID = 8;
export const SHARD_STRIDE = 9;

export interface PhaseParams {
  readonly name: string;
  readonly gapHalf: number;
  readonly interval: number;
  readonly lead: number;
  readonly drift: number;
  readonly shards: number;
  readonly mult: number;
}

/** Difficulty Director table — frozen. Index 0 is phase 1. */
export const PHASES: readonly PhaseParams[] = [
  { name: "ANLAUF", gapHalf: 10500, interval: 190, lead: 210, drift: 0, shards: 2, mult: 1 },
  { name: "ANLAUF", gapHalf: 9600, interval: 176, lead: 196, drift: 0, shards: 2, mult: 1 },
  { name: "TAKT", gapHalf: 7400, interval: 148, lead: 144, drift: 600, shards: 3, mult: 2 },
  { name: "ATEMPAUSE", gapHalf: 6800, interval: 154, lead: 140, drift: 800, shards: 3, mult: 2 },
  { name: "GEGENLAUF", gapHalf: 6000, interval: 138, lead: 132, drift: 1200, shards: 3, mult: 3 },
  { name: "GEGENLAUF", gapHalf: 5400, interval: 130, lead: 126, drift: 1600, shards: 4, mult: 3 },
  { name: "DRIFT", gapHalf: 4900, interval: 122, lead: 120, drift: 2000, shards: 4, mult: 4 },
  { name: "DRIFT", gapHalf: 4400, interval: 116, lead: 114, drift: 2400, shards: 4, mult: 4 },
  { name: "KOMBI", gapHalf: 4000, interval: 110, lead: 110, drift: 2800, shards: 5, mult: 5 },
  { name: "KOMBI", gapHalf: 3600, interval: 102, lead: 106, drift: 3200, shards: 5, mult: 6 },
  { name: "MEISTERSCHAFT", gapHalf: 3200, interval: 96, lead: 102, drift: 3600, shards: 5, mult: 7 },
  { name: "MEISTERSCHAFT", gapHalf: 2900, interval: 90, lead: 98, drift: 4000, shards: 6, mult: 8 },
] as const;

/** splitter value weights per phase band, sum 100 */
const WEIGHTS: readonly { p10: number; p25: number; p50: number; p100: number }[] = [
  { p10: 70, p25: 30, p50: 0, p100: 0 },
  { p10: 40, p25: 40, p50: 20, p100: 0 },
  { p10: 0, p25: 45, p50: 45, p100: 10 },
  { p10: 0, p25: 30, p50: 50, p100: 20 },
] as const;

export type DeathReason = "none" | "wave";

export interface SimEvent {
  type: "shard" | "cleancut" | "death" | "phase";
  angle: number;
  value: number;
  tier: number;
  combo: number;
}

export interface Run {
  seed: number;
  rulesVersion: number;
  /** mulberry32 state, always uint32 */
  prngState: number;
  tick: number;
  alive: number;
  deathReason: DeathReason;
  endTick: number;
  shipAngle: number;
  dir: number;
  score: number;
  combo: number;
  bestCombo: number;
  cleanCuts: number;
  shardsCollected: number;
  shardsSpawned: number;
  shardsExpired: number;
  clampedWaves: number;
  nextArrive: number;
  nextSpawn: number;
  nextWaveId: number;
  nextShardId: number;
  /** arrival centre of the most recent wave, needed by the next draw */
  prevArrivalCenter: number;
  prevGapHalf: number;
  pendingSpacing: number;
  waves: Int32Array;
  shards: Int32Array;
  hashBuffer: Int32Array;
  hashes: number[];
  hashTicks: number[];
  inputs: number[];
  events: SimEvent[];
}

// ---------------------------------------------------------------- math

/** angle into [0, TURN). Explicit normalisation, no reliance on negative modulo. */
export function wrapAngle(a: number): number {
  // `| 0` also normalises -0, which is not equal to 0 under Object.is
  if (a >= 0 && a < TURN) return a | 0;
  let r = a % TURN;
  if (r < 0) r += TURN;
  if (r === TURN) r = 0;
  return r | 0;
}

/** shortest signed distance from `from` to `to`, range [-TURN/2, TURN/2). */
export function signedAngleDelta(from: number, to: number): number {
  let d = wrapAngle(to - from);
  if (d >= TURN / 2) d -= TURN;
  return d;
}

export function absoluteAngleDistance(a: number, b: number): number {
  const d = signedAngleDelta(a, b);
  return d < 0 ? -d : d;
}

/** integer division rounding toward zero, b > 0 */
export function truncDiv(a: number, b: number): number {
  const r = a >= 0 ? Math.floor(a / b) : -Math.floor(-a / b);
  // -0 would break strict equality against 0 further down the line
  return r === 0 ? 0 : r;
}

/** integer drift interpolation; num in [0, den] */
export function interpolateDrift(delta: number, num: number, den: number): number {
  if (den <= 0) return 0;
  return truncDiv(delta * num, den);
}

export function phaseAtTick(t: number): number {
  return Math.floor(t / PHASE_TICKS) + 1;
}

export function mult(phase: number): number {
  if (phase <= 12) return (PHASES[phase - 1] as PhaseParams).mult;
  return 8 + (phase - 12);
}

/** clamped table lookup */
export function paramsForPhase(phase: number): PhaseParams {
  const i = phase < 1 ? 0 : phase > 12 ? 11 : phase - 1;
  return PHASES[i] as PhaseParams;
}

export function waveCenterAt(
  startCenter: number,
  driftDelta: number,
  spawnTick: number,
  arriveTick: number,
  t: number,
): number {
  const den = arriveTick - spawnTick;
  return wrapAngle(startCenter + interpolateDrift(driftDelta, t - spawnTick, den));
}

// ---------------------------------------------------------------- prng

export function prngNext(state: number): { value: number; state: number } {
  const s = (state + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = (t ^ (t >>> 14)) >>> 0;
  return { value, state: s >>> 0 };
}

/** uniform integer in [0, n), rejection sampled, no modulo bias */
function nextInt(run: Run, n: number): number {
  const limit = Math.floor(4294967296 / n) * n;
  for (;;) {
    const r = prngNext(run.prngState);
    run.prngState = r.state;
    if (r.value < limit) return r.value % n;
  }
}

// ---------------------------------------------------------------- hashing

export function fnv1aBytes(bytes: Int32Array, count: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < count; i++) {
    const v = bytes[i] as number;
    for (let b = 0; b < 4; b++) {
      h ^= (v >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/**
 * DECISION: the spec's hash field list omits prevArrivalCenter / prevGapHalf /
 * pendingSpacing, but §6 requires them to generate the next wave. Without them
 * two states could hash equal and still diverge. They are appended at the end.
 */
export function serializeState(run: Run): Int32Array {
  const buf = run.hashBuffer;
  let i = 0;
  const put = (v: number): void => {
    buf[i] = v | 0;
    i++;
  };
  put(run.tick);
  put(run.shipAngle);
  put(run.dir);
  put(run.alive);
  put(run.score);
  put(run.combo);
  put(run.bestCombo);
  put(phaseAtTick(run.tick));
  put(run.cleanCuts);
  put(run.shardsCollected);
  put(run.shardsSpawned);
  put(run.shardsExpired);
  put(run.clampedWaves);
  put(run.prngState);
  put(run.nextArrive);
  put(run.nextSpawn);
  put(run.nextWaveId);
  put(run.nextShardId);
  for (let s = 0; s < WAVE_SLOTS; s++) {
    const o = s * WAVE_STRIDE;
    put(s);
    for (let f = 0; f < WAVE_STRIDE - 1; f++) put(run.waves[o + f] as number);
  }
  for (let s = 0; s < SHARD_SLOTS; s++) {
    const o = s * SHARD_STRIDE;
    put(s);
    for (let f = 0; f < SHARD_STRIDE - 1; f++) put(run.shards[o + f] as number);
  }
  put(run.prevArrivalCenter);
  put(run.prevGapHalf);
  put(run.pendingSpacing);
  return buf;
}

export function hashRun(run: Run): number {
  return fnv1aBytes(serializeState(run), 18 + WAVE_SLOTS * WAVE_STRIDE + SHARD_SLOTS * SHARD_STRIDE + 3);
}

// ---------------------------------------------------------------- validator

export interface ShiftCheck {
  spacing: number;
  gapHalfPrev: number;
  gapHalfNext: number;
  drift: number;
  lead: number;
}

/**
 * Exported and directly testable. (a)-(g) from the spec. The reach rule is a
 * conservative design condition, not a proof that every combination is playable.
 */
export function validateShift(d: number, c: ShiftCheck): boolean {
  const travel = c.spacing * SHIP_SPEED;
  const reach = truncDiv(travel * REACH_PERCENT, 100);
  const ad = d < 0 ? -d : d;
  if (ad > reach) return false; // (a)
  if (c.drift > truncDiv(travel * DRIFT_PERCENT_MAX, 100)) return false; // (b)
  if (c.lead <= 0 || (c.drift > 0 && c.drift > c.lead * SHIP_SPEED)) return false; // (c)
  if (c.gapHalfNext < MIN_GAP_HALF || c.lead < MIN_LEAD) return false; // (d)
  if (c.spacing < MIN_INTERVAL) return false; // (d/e)
  if (ad < MIN_SHIFT) return false; // (f)
  if (ad + c.gapHalfPrev - c.gapHalfNext > travel) return false; // (g)
  return true;
}

// ---------------------------------------------------------------- run

export function createRun(seed: number): Run {
  const run: Run = {
    seed: seed >>> 0,
    rulesVersion: RULES_VERSION,
    prngState: seed >>> 0,
    tick: 0,
    alive: 1,
    deathReason: "none",
    endTick: 0,
    shipAngle: START_ANGLE,
    dir: START_DIR,
    score: 0,
    combo: 0,
    bestCombo: 0,
    cleanCuts: 0,
    shardsCollected: 0,
    shardsSpawned: 0,
    shardsExpired: 0,
    clampedWaves: 0,
    nextArrive: 0,
    nextSpawn: 0,
    nextWaveId: 1,
    nextShardId: 1,
    prevArrivalCenter: START_ANGLE,
    prevGapHalf: (PHASES[0] as PhaseParams).gapHalf,
    pendingSpacing: 0,
    waves: new Int32Array(WAVE_SLOTS * WAVE_STRIDE),
    shards: new Int32Array(SHARD_SLOTS * SHARD_STRIDE),
    hashBuffer: new Int32Array(18 + WAVE_SLOTS * WAVE_STRIDE + SHARD_SLOTS * SHARD_STRIDE + 3),
    hashes: [],
    hashTicks: [],
    inputs: [],
    events: [],
  };
  // spawn plan: arrive(0) = lead(phaseAtTick(0)), spawn(0) = arrive(0) - lead(...)
  const a0 = paramsForPhase(phaseAtTick(0)).lead;
  run.nextArrive = a0;
  run.nextSpawn = a0 - paramsForPhase(phaseAtTick(a0)).lead;
  run.pendingSpacing = a0;
  return run;
}

function freeSlot(stride: number, slots: number, base: Int32Array): number {
  for (let s = 0; s < slots; s++) {
    if ((base[s * stride] as number) === 0) return s;
  }
  return -1;
}

function weightFor(phase: number): { p10: number; p25: number; p50: number; p100: number } {
  if (phase <= 2) return WEIGHTS[0] as { p10: number; p25: number; p50: number; p100: number };
  if (phase <= 6) return WEIGHTS[1] as { p10: number; p25: number; p50: number; p100: number };
  if (phase <= 10) return WEIGHTS[2] as { p10: number; p25: number; p50: number; p100: number };
  return WEIGHTS[3] as { p10: number; p25: number; p50: number; p100: number };
}

function drawValue(run: Run, phase: number): number {
  const w = weightFor(phase);
  const roll = nextInt(run, 100);
  if (roll < w.p10) return 10;
  if (roll < w.p10 + w.p25) return 25;
  if (roll < w.p10 + w.p25 + w.p50) return 50;
  return 100;
}

function tierOf(value: number): number {
  if (value <= 10) return 0;
  if (value <= 25) return 1;
  if (value <= 50) return 2;
  return 3;
}

function addScore(run: Run, amount: number): void {
  const next = run.score + amount;
  run.score = next > SCORE_CAP ? SCORE_CAP : next;
}

function spawnWave(run: Run, t: number): void {
  const arrive = run.nextArrive;
  const spacing = run.pendingSpacing;
  const phase = Math.min(12, phaseAtTick(arrive));
  const p = paramsForPhase(phase);
  const check: ShiftCheck = {
    spacing,
    gapHalfPrev: run.prevGapHalf,
    gapHalfNext: p.gapHalf,
    drift: p.drift,
    lead: arrive - run.nextSpawn,
  };

  let d = 0;
  let accepted = false;
  for (let attempt = 0; attempt < MAX_WAVE_ATTEMPTS; attempt++) {
    d = nextInt(run, TURN) - TURN / 2;
    if (validateShift(d, check)) {
      accepted = true;
      break;
    }
  }
  if (!accepted) {
    const reach = truncDiv(spacing * SHIP_SPEED * REACH_PERCENT, 100);
    let mag = d < 0 ? -d : d;
    if (mag < MIN_SHIFT) mag = MIN_SHIFT;
    if (mag > reach) mag = reach;
    d = d < 0 ? -mag : mag;
    run.clampedWaves++;
  }

  const arrivalCenter = wrapAngle(run.prevArrivalCenter + d);
  const driftDelta = (nextInt(run, 2) === 0 ? 1 : -1) * p.drift;
  const startCenter = wrapAngle(arrivalCenter - driftDelta);

  const slot = freeSlot(WAVE_STRIDE, WAVE_SLOTS, run.waves);
  if (slot < 0) return; // spec: blocker. Guarded, should never happen.
  const o = slot * WAVE_STRIDE;
  run.waves[o + W_ACTIVE] = 1;
  run.waves[o + W_SPAWN] = t;
  run.waves[o + W_ARRIVE] = arrive;
  run.waves[o + W_START] = startCenter;
  run.waves[o + W_DRIFT] = driftDelta;
  run.waves[o + W_GAPHALF] = p.gapHalf;
  run.waves[o + W_PHASE] = phase;
  run.waves[o + W_ID] = run.nextWaveId;

  // shards: one draw of jitter, then one weighted draw of value, per shard
  const n = p.shards;
  const jitterScale = truncDiv(d < 0 ? -d : d, 4 * (n + 1));
  for (let i = 1; i <= n; i++) {
    const base = truncDiv(i * d, n + 1);
    const jitter = nextInt(run, 2 * jitterScale + 1) - jitterScale;
    const angle = wrapAngle(run.prevArrivalCenter + base + jitter);
    const value = drawValue(run, phase);
    const sSlot = freeSlot(SHARD_STRIDE, SHARD_SLOTS, run.shards);
    if (sSlot < 0) continue; // spec: blocker. Guarded, should never happen.
    const so = sSlot * SHARD_STRIDE;
    run.shards[so + S_ACTIVE] = 1;
    run.shards[so + S_ANGLE] = angle;
    run.shards[so + S_SPAWN] = t;
    run.shards[so + S_EXPIRE] = arrive;
    run.shards[so + S_VALUE] = value;
    run.shards[so + S_COLLECTED] = 0;
    run.shards[so + S_MISSED] = 0;
    run.shards[so + S_REACHABLE] = absoluteAngleDistance(run.shipAngle, angle) <= COMBO_BREAK_DISTANCE ? 1 : 0;
    run.shards[so + S_ID] = run.nextShardId;
    run.nextShardId++;
    run.shardsSpawned++;
  }

  run.prevArrivalCenter = arrivalCenter;
  run.prevGapHalf = p.gapHalf;
  run.nextWaveId++;

  // schedule the next wave from this arrival
  const nextSpacing = paramsForPhase(phaseAtTick(arrive)).interval;
  const nextArrive = arrive + nextSpacing;
  run.nextArrive = nextArrive;
  run.nextSpawn = nextArrive - paramsForPhase(phaseAtTick(nextArrive)).lead;
  run.pendingSpacing = nextSpacing;
}

// freeing zeroes every field; the slot index itself is not stored in the slot
function clearSlot(base: Int32Array, stride: number, slot: number): void {
  const o = slot * stride;
  for (let f = 0; f < stride; f++) base[o + f] = 0;
}

function pushHash(run: Run): void {
  run.hashes.push(hashRun(run));
  run.hashTicks.push(run.tick);
}

/** Advance exactly one tick. `tap` is the only input channel. */
export function step(run: Run, tap: boolean): void {
  if (run.alive === 0) return;
  const t = run.tick;
  const m = mult(phaseAtTick(t));

  // 0. pending tap
  if (tap) {
    run.dir = run.dir === 1 ? -1 : 1;
    run.inputs.push(t);
  }

  // 1. due spawn
  if (run.nextSpawn === t) spawnWave(run, t);

  // 2. move
  run.shipAngle = wrapAngle(run.shipAngle + run.dir * SHIP_SPEED);

  // 3. arrivals
  for (let s = 0; s < WAVE_SLOTS; s++) {
    const o = s * WAVE_STRIDE;
    if ((run.waves[o + W_ACTIVE] as number) === 0) continue;
    if ((run.waves[o + W_ARRIVE] as number) !== t) continue;
    const gapHalf = run.waves[o + W_GAPHALF] as number;
    const center = waveCenterAt(
      run.waves[o + W_START] as number,
      run.waves[o + W_DRIFT] as number,
      run.waves[o + W_SPAWN] as number,
      run.waves[o + W_ARRIVE] as number,
      t,
    );
    const dist = absoluteAngleDistance(run.shipAngle, center);
    if (dist > gapHalf) {
      run.alive = 0;
      run.deathReason = "wave";
      run.endTick = t + 1;
      run.events.push({ type: "death", angle: run.shipAngle, value: 0, tier: 0, combo: run.combo });
      run.tick = t + 1;
      if (run.tick % HASH_EVERY_TICKS !== 0) pushHash(run);
      return;
    }
    if (dist <= truncDiv(gapHalf * CLEAN_CUT_PERCENT, 100)) {
      run.cleanCuts++;
      run.combo++;
      addScore(run, 25 * m);
      run.events.push({ type: "cleancut", angle: center, value: 25 * m, tier: 3, combo: run.combo });
    }
    clearSlot(run.waves, WAVE_STRIDE, s);
  }

  // 4. shards: collect first, then expire in the same tick
  for (let s = 0; s < SHARD_SLOTS; s++) {
    const o = s * SHARD_STRIDE;
    if ((run.shards[o + S_ACTIVE] as number) === 0) continue;
    if ((run.shards[o + S_COLLECTED] as number) === 1) continue;
    if ((run.shards[o + S_SPAWN] as number) > t) continue;
    const angle = run.shards[o + S_ANGLE] as number;
    if (absoluteAngleDistance(run.shipAngle, angle) <= SHARD_RADIUS) {
      const value = run.shards[o + S_VALUE] as number;
      const chainBonus = Math.floor(run.combo / 6);
      addScore(run, value * (m + chainBonus));
      run.events.push({ type: "shard", angle, value, tier: tierOf(value), combo: run.combo + 1 });
      run.shards[o + S_COLLECTED] = 1;
      run.shardsCollected++;
      run.combo++;
      clearSlot(run.shards, SHARD_STRIDE, s);
    }
  }
  for (let s = 0; s < SHARD_SLOTS; s++) {
    const o = s * SHARD_STRIDE;
    if ((run.shards[o + S_ACTIVE] as number) === 0) continue;
    if ((run.shards[o + S_EXPIRE] as number) !== t) continue;
    run.shardsExpired++;
    if ((run.shards[o + S_REACHABLE] as number) === 1) run.combo = 0;
    clearSlot(run.shards, SHARD_STRIDE, s);
  }

  // 5. counters
  if (run.combo > run.bestCombo) run.bestCombo = run.combo;

  // 6. advance
  run.tick = t + 1;
  const nextPhase = phaseAtTick(run.tick);
  if (nextPhase !== phaseAtTick(t)) {
    run.events.push({ type: "phase", angle: 0, value: nextPhase, tier: 0, combo: run.combo });
  }

  // 7. periodic hash
  if (run.tick % HASH_EVERY_TICKS === 0) pushHash(run);
}

/** Pure replay: no rendering, no audio. Used by tests and later by a server. */
export function replay(seed: number, inputs: readonly number[], endTick: number): Run {
  const run = createRun(seed);
  let i = 0;
  while (run.alive === 1 && run.tick < endTick) {
    let tap = false;
    while (i < inputs.length && (inputs[i] as number) === run.tick) {
      tap = true;
      i++;
    }
    step(run, tap);
  }
  return run;
}

/**
 * The one seed format: base36 text. `seedTag` writes it, `seedValue` reads it, so
 * the label on screen and `?seed=` can never drift apart.
 */
export function seedValue(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9a-z]+$/i.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 36);
  return Number.isFinite(value) ? value >>> 0 : null;
}

export function seedTag(seed: number): string {
  return (seed >>> 0).toString(36).toUpperCase();
}

export interface RunMetadata {
  /** the seed alone identifies a run: the simulation is deterministic */
  seed: number;
  rulesVersion: number;
  replayFormatVersion: number;
  endTick: number;
  inputCount: number;
  score: number;
  phase: number;
  bestCombo: number;
  cleanCuts: number;
  shardsCollected: number;
  shardsSpawned: number;
  shardsExpired: number;
  deathReason: DeathReason;
  clampedWaves: number;
  lastHash: number;
  hashes: number[];
  hashTicks: number[];
}

export function metadata(run: Run): RunMetadata {
  return {
    seed: run.seed,
    rulesVersion: run.rulesVersion,
    replayFormatVersion: REPLAY_FORMAT_VERSION,
    endTick: run.tick,
    inputCount: run.inputs.length,
    score: run.score,
    phase: phaseAtTick(run.tick),
    bestCombo: run.bestCombo,
    cleanCuts: run.cleanCuts,
    shardsCollected: run.shardsCollected,
    shardsSpawned: run.shardsSpawned,
    shardsExpired: run.shardsExpired,
    deathReason: run.deathReason,
    clampedWaves: run.clampedWaves,
    lastHash: run.hashes.length ? (run.hashes[run.hashes.length - 1] as number) : 0,
    hashes: run.hashes.slice(),
    hashTicks: run.hashTicks.slice(),
  };
}
