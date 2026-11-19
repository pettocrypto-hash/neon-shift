import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  RULES_VERSION,
  createRun,
  step,
  replay,
  phaseAtTick,
  waveCenterAt,
  signedAngleDelta,
  WAVE_SLOTS,
  WAVE_STRIDE,
  W_ACTIVE,
  W_ARRIVE,
  W_START,
  W_DRIFT,
  W_SPAWN,
  SHIP_SPEED,
} from "../build/sim/sim.js";

const here = dirname(fileURLToPath(import.meta.url));

function botTap(run, last, minGap) {
  if (run.tick - last < minGap) return false;
  let slot = -1;
  let best = Infinity;
  for (let s = 0; s < WAVE_SLOTS; s++) {
    const o = s * WAVE_STRIDE;
    if (run.waves[o + W_ACTIVE] === 0) continue;
    const a = run.waves[o + W_ARRIVE];
    if (a <= run.tick || a >= best) continue;
    best = a;
    slot = s;
  }
  if (slot < 0) return false;
  const o = slot * WAVE_STRIDE;
  const c = waveCenterAt(run.waves[o + W_START], run.waves[o + W_DRIFT], run.waves[o + W_SPAWN], run.waves[o + W_ARRIVE], best);
  const d = signedAngleDelta(run.shipAngle, c);
  return Math.abs(d) > SHIP_SPEED * 2 && Math.sign(d) !== run.dir;
}

function play(seed, maxTicks) {
  const run = createRun(seed);
  let last = -999;
  while (run.alive === 1 && run.tick < maxTicks) {
    const tap = botTap(run, last, 10);
    if (tap) last = run.tick;
    step(run, tap);
  }
  return run;
}

const seeds = [1, 2, 3, 2024, 99991];
const entries = seeds.map((seed) => {
  const run = play(seed, 3600);
  return {
    seed,
    inputs: run.inputs.slice(),
    endTick: run.tick,
    tick: run.tick,
    score: run.score,
    phase: phaseAtTick(run.tick),
    lastHash: run.hashes.at(-1) ?? 0,
  };
});

// self-check before freezing: replay must reproduce exactly
for (const e of entries) {
  const again = replay(e.seed, e.inputs, e.endTick);
  if (again.score !== e.score || (again.hashes.at(-1) ?? 0) !== e.lastHash) {
    throw new Error(`golden self-check failed for seed ${e.seed}`);
  }
}

writeFileSync(join(here, "golden.json"), JSON.stringify({ rulesVersion: RULES_VERSION, entries }, null, 2) + "\n");
console.log(`wrote tests/golden.json with ${entries.length} entries (rules v${RULES_VERSION})`);
