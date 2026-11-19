/**
 * Fairness under human timing error — two independent instruments.
 *
 * 1) reachability(): bot-free. For one wave, how much of the orbit can you be
 *    standing on at spawn and still be inside the gap at arrival, when you may
 *    only reverse? This is pure geometry: the two arrival points are p+d and
 *    p-d, so the survivable set is G shifted by ±d. It is monotone in both the
 *    gap width and the travel distance d, and it cannot "collapse".
 *
 * 2) bot(): closed loop. The decision is made from the *current* state and then
 *    executed `delay` ticks later, which is what reaction time actually costs.
 *    (The earlier version fed the bot stale positions instead, which made its
 *    controller oscillate and invalidated the comparison.)
 */

import { PHASES, SHIP_SPEED, TURN, createRun, phaseAtTick, step } from "../build/sim/sim.js";

const TAU = Math.PI * 2;
const TICKS = 7200;
const SEEDS = 40;
const SPEED = (SHIP_SPEED / TURN) * TAU; // radians per tick

const V4 = [
  { lead: 156, gapHalf: 9000, interval: 168 },
  { lead: 150, gapHalf: 8200, interval: 158 },
];
const V5 = [
  { lead: 210, gapHalf: 10500, interval: 190 },
  { lead: 196, gapHalf: 9600, interval: 176 },
];
const V6 = [
  { lead: 120, gapHalf: 12000, interval: 190 },
  { lead: 116, gapHalf: 11200, interval: 176 },
];
/** v5 with the wider gap only — the question asked: does 12000 alone help? */
const V7 = [
  { lead: 210, gapHalf: 12000, interval: 190 },
  { lead: 196, gapHalf: 11200, interval: 176 },
];
/** half-lap lead with the wide gap */
const V8 = [
  { lead: 109, gapHalf: 12000, interval: 190 },
  { lead: 105, gapHalf: 11200, interval: 176 },
];

function setTable(table) {
  for (let p = 0; p < 2; p++) {
    PHASES[p].lead = table[p].lead;
    PHASES[p].gapHalf = table[p].gapHalf;
    PHASES[p].interval = table[p].interval;
  }
}

const wrap = (x) => {
  let r = x % TAU;
  if (r > Math.PI) r -= TAU;
  if (r < -Math.PI) r += TAU;
  return r;
};

/**
 * Fraction of the orbit from which a single reversal still reaches the gap.
 * G = [-h, h] around the gap centre; you survive from p if p+d or p-d lands in G.
 */
function reachability(leadTicks, gapHalf) {
  const h = (gapHalf / TURN) * TAU;
  const d = SPEED * leadTicks;
  const N = 4096;
  let ok = 0;
  for (let i = 0; i < N; i++) {
    const p = (i / N) * TAU;
    const a = Math.abs(wrap(p + d));
    const b = Math.abs(wrap(p - d));
    if (a <= h || b <= h) ok++;
  }
  return ok / N;
}

function play(seed, delayMs, maxTaps = Infinity) {
  const run = createRun(seed);
  const delay = Math.round((delayMs / 1000) * 120);
  const queue = [];
  let best = 1;
  let lastTap = -99;
  let waveId = null;
  let tapsUsed = 0;
  while (run.tick < TICKS && run.alive === 1) {
    let next = null;
    for (let s = 0; s < 4; s++) {
      const o = s * 8;
      if (run.waves[o] !== 1) continue;
      const arr = run.waves[o + 2];
      if (arr < run.tick || (next && arr >= next.arr)) continue;
      next = { arr, center: run.waves[o + 3], half: run.waves[o + 5] };
    }
    if (next && next.arr !== waveId) {
      waveId = next.arr;
      tapsUsed = 0;
    }
    // decide on what is visible right now
    let decide = false;
    if (next) {
      const left = next.arr - run.tick;
      if (left > 3) {
        const base = (run.shipAngle / TURN) * TAU;
        const travel = SPEED * left;
        const center = (next.center / TURN) * TAU;
        const half = (next.half / TURN) * TAU;
        const errSame = Math.abs(wrap(base + run.dir * travel - center));
        const errFlip = Math.abs(wrap(base - run.dir * travel - center));
        // flip only when the other direction is clearly better; no time guard
        if (errFlip + half * 0.2 < errSame && run.tick - lastTap > 2 && tapsUsed < maxTaps) {
          tapsUsed++;
          decide = true;
          lastTap = run.tick + delay;
        }
      }
    }
    // the hand acts late
    queue.push(decide);
    const act = delay > 0 ? queue.length > delay && queue.shift() === true : decide;
    step(run, act);
    best = Math.max(best, phaseAtTick(run.tick));
  }
  return { phase: best, alive: run.alive, ticks: run.tick };
}

function botTable(table, delayMs, maxTaps = Infinity) {
  setTable(table);
  const out = [];
  for (let s = 1; s <= SEEDS; s++) out.push(play(s * 7919, delayMs, maxTaps));
  out.sort((a, b) => a.phase - b.phase);
  const phases = out.map((r) => r.phase);
  const deaths = out.filter((r) => r.alive === 0).map((r) => r.ticks / 120).sort((a, b) => a - b);
  return {
    median: phases[Math.floor(phases.length / 2)],
    min: phases[0],
    max: phases[phases.length - 1],
    death: deaths.length ? deaths[Math.floor(deaths.length / 2)].toFixed(1) + "s" : "—",
  };
}

console.log("== reachability in phase 1: share of the orbit that survives one decision ==");
for (const [name, table] of [["v4", V4], ["v5", V5], ["v7 (gap 12000, lead 210)", V7], ["v8 (gap 12000, lead 109)", V8], ["v6 (gap 12000, lead 120)", V6]]) {
  const r1 = reachability(table[0].lead, table[0].gapHalf);
  const r2 = reachability(table[1].lead, table[1].gapHalf);
  console.log(`${name.padEnd(26)} phase1 ${(r1 * 100).toFixed(1)}%   phase2 ${(r2 * 100).toFixed(1)}%`);
}

console.log("\n== closed loop, delayed action ==");
console.log("delay |     v4      |     v5      |  v7 (12000) |  v8 (12000,109) | v6 (12000,120)");
for (const delay of [0, 33, 67, 100]) {
  const cells = [V4, V5, V7, V8, V6].map((t) => {
    const r = botTable(t, delay);
    return `${String(r.median).padStart(2)} / ${r.death.padStart(6)}`;
  });
  console.log(`${String(delay).padStart(5)} | ${cells.join(" | ")}`);
}

console.log("\n== where the two instruments disagree: taps allowed per wave (100 ms delay) ==");
console.log("taps |     v4      |     v5      | v6 (12000,120)");
for (const taps of [1, 2, 4, 99]) {
  const cells = [V4, V5, V6].map((t) => {
    const r = botTable(t, 100, taps);
    return `${String(r.median).padStart(2)} / ${r.death.padStart(6)}`;
  });
  console.log(`${String(taps).padStart(4)} | ${cells.join(" | ")}`);
}
