/**
 * Keeps TUTORIAL_SEED in sync with the difficulty table.
 *
 * The tutorial needs an idle player to survive long enough to read all three
 * hints (last one at 2.8 s) and short enough that the first death still teaches
 * the lesson. Any change to the phase table shifts the whole spawn plan, so the
 * seed is re-searched automatically as part of `npm run golden`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, step } from "../build/sim/sim.js";

const here = dirname(fileURLToPath(import.meta.url));
const mainPath = join(here, "..", "src", "main.ts");

const MIN_TICKS = 540; // 4.5 s — after the last hint (2.8 s) with room to read it
const MAX_TICKS = 660; // 5.5 s — the entry stays short; longer idle runs feel sluggish
const TARGET_TICKS = 600; // pick the seed closest to 5.0 s, not the one that scores most
const SEARCH_LIMIT = 8000;

function idle(seed) {
  const run = createRun(seed);
  let t = 0;
  while (run.alive === 1 && t < 4000) {
    step(run, false);
    t++;
  }
  return { ticks: t, score: run.score };
}

const source = readFileSync(mainPath, "utf8");
const match = /const TUTORIAL_SEED = (\d+);/.exec(source);
if (!match) {
  console.error("TUTORIAL_SEED not found in src/main.ts");
  process.exit(1);
}
const current = Number(match[1]);
const now = idle(current);

if (now.ticks >= MIN_TICKS && now.ticks <= MAX_TICKS) {
  console.log(
    `tutorial seed ${current} still valid: idle ${(now.ticks / 120).toFixed(2)} s, ${now.score} points`,
  );
  process.exit(0);
}

let best = null;
for (let seed = 1; seed <= SEARCH_LIMIT; seed++) {
  const r = idle(seed);
  if (r.ticks < MIN_TICKS || r.ticks > MAX_TICKS) continue;
  if (!best || Math.abs(r.ticks - TARGET_TICKS) < Math.abs(best.ticks - TARGET_TICKS)) {
    best = { seed, ...r };
  }
}

if (!best) {
  console.error(`no tutorial seed in 1..${SEARCH_LIMIT} survives ${MIN_TICKS}-${MAX_TICKS} ticks`);
  process.exit(1);
}

writeFileSync(mainPath, source.replace(/const TUTORIAL_SEED = \d+;/, `const TUTORIAL_SEED = ${best.seed};`));
console.log(
  `tutorial seed ${current} -> ${best.seed} (idle ${(best.ticks / 120).toFixed(2)} s, ${best.score} points)`,
);
