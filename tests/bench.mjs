import { createRun, step, replay, phaseAtTick } from "../build/sim/sim.js";

const SEEDS = 50;
const TICKS = 120 * 60;

const t0 = process.hrtime.bigint();
let ticks = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const run = createRun(seed);
  while (run.alive === 1 && run.tick < TICKS) {
    step(run, run.tick % 37 === 0);
    ticks++;
  }
}
const t1 = process.hrtime.bigint();
const us = Number(t1 - t0) / 1000 / Math.max(1, ticks);

const t2 = process.hrtime.bigint();
const run = createRun(1234);
while (run.alive === 1 && run.tick < 120 * 600) step(run, run.tick % 41 === 0);
const replayStart = process.hrtime.bigint();
const again = replay(1234, run.inputs, run.tick);
const replayMs = Number(process.hrtime.bigint() - replayStart) / 1e6;
void t2;

console.log(`sim: ${us.toFixed(3)} us/tick over ${ticks} ticks (${SEEDS} seeds)`);
console.log(`replay ${run.tick} ticks (phase ${phaseAtTick(run.tick)}, ${run.inputs.length} inputs): ${replayMs.toFixed(1)} ms`);
console.log(`hashes equal: ${JSON.stringify(run.hashes) === JSON.stringify(again.hashes)}`);
console.log(`budget at 120 Hz: ${(us * 120 / 1000).toFixed(3)} ms per second of gameplay`);
