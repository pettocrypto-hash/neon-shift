import { Application } from "pixi.js";
import {
  MAX_CATCHUP_TICKS,
  SHARD_SLOTS,
  S_ACTIVE,
  SHARD_STRIDE,
  TICK_HZ,
  WAVE_SLOTS,
  WAVE_STRIDE,
  W_ACTIVE,
  createRun,
  metadata,
  paramsForPhase,
  seedTag,
  seedValue,
  phaseAtTick,
  step,
  type Run,
} from "./sim/sim";
import { comboHeat, DEATH_FLARE_MS, Scene, VALUE_COLOR } from "./render";
import { AudioEngine } from "./audio";

// ------------------------------------------------------------------ dom

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const stage = $("stage");
const panel = $("panel");
const overlay = $("overlay");
const elScore = $("score");
const elChain = $("chain");
const elPhase = $("phase");
const elBest = $("best");
const elHint = $("hint");
const elDebug = $("debug");
const btnPause = $("pauseBtn");

// ------------------------------------------------------------------ storage

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: never break the game over a missing best score */
  }
}

const settings = {
  sound: getItem("ns.sound") !== "0",
  vibration: getItem("ns.bit") !== "0",
  reduceFlash: getItem("ns.flash") === "1",
  reduceMotion: getItem("ns.motion") === "1",
};
if (getItem("ns.motion") === null) {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      settings.reduceMotion = true;
      settings.reduceFlash = true;
    }
  } catch {
    /* matchMedia unavailable */
  }
}

// ------------------------------------------------------------------ app

/** device pixel ceiling: ultra-crisp on phones, bounded on huge desktop windows */
const RES_CAP = Math.min(window.devicePixelRatio || 1, window.innerWidth * window.innerHeight > 1_200_000 ? 2 : 3);

const app = new Application();
await app.init({
  background: 0x04060d,
  antialias: true,
  resolution: RES_CAP,
  autoDensity: true,
  resizeTo: window,
});
stage.appendChild(app.canvas);

const scene = new Scene(app.stage);
const audio = new AudioEngine();
audio.muted = !settings.sound;

function syncSize(): void {
  // app.screen can still hold the previous size while the resize event runs,
  // which left the scene centred on the old layout. The window is the truth.
  scene.resize(window.innerWidth, window.innerHeight);
  scene.setAccessibility(settings.reduceFlash, settings.reduceMotion);
}
syncSize();
window.addEventListener("resize", () => {
  syncSize();
  placeDebug();
});
window.addEventListener("orientationchange", () =>
  window.setTimeout(() => {
    syncSize();
    placeDebug();
  }, 120),
);

/**
 * The debug panel has to sit above the hint pill. The pill wraps to one, two or
 * three lines depending on the phone width, so its height is measured here
 * instead of being hard-coded. Wide screens keep the stylesheet placement.
 */
function placeDebug(): void {
  if (!debugOn || window.innerWidth > 520) {
    elDebug.style.bottom = "";
    return;
  }
  const top = elHint.getBoundingClientRect().top;
  if (top <= 0) return;
  elDebug.style.bottom = `${Math.round(window.innerHeight - top + 10)}px`;
}

// ------------------------------------------------------------------ state

type Screen = "start" | "playing" | "paused" | "dead" | "settings";
let screen: Screen = "start";
let settingsReturn: "start" | "paused" | "dead" = "start";
let run: Run | null = null;
let pendingTap = false;
/** the game-over screen waits exactly as long as the flare itself lives */
let deathHoldMs = 0;
let lastBeat = 0;
/** the run is created but the clock does not advance until the start tap */
let armed = true;
let acc = 0;
let best = Number(getItem("ns.best") ?? "0") || 0;
let tutorialDone = getItem("ns.tutorial") === "1";
let tutorialActive = false;
let lastRunWasTutorial = false;
let tutorialStep = 0;
let tutorialTimer = 0;
/**
 * performance.now() is quantised to ~100 us in Chromium while one tick costs
 * about 1 us, so timing a single frame always yields 0. A burst of 4000 ticks
 * on throwaway runs resolves the clock, but it is a tight-loop figure and not
 * the live per-tick average (bench.mjs reports ~1 us under Node) — the overlay
 * marks it as such.
 */
let simUsPerTick = 0;
let simBenchAt = 0;
let fps = 60;
/** our own per-frame cost, averaged over 30 frames: sim + scene rebuild */
let jsFrameMs = 0;
let jsFrameSum = 0;
let jsFrameCount = 0;
/** tap latency: pointer timestamp -> simulation tick -> frame that draws it */
let tapAt = 0;
let tapSimMs = 0;
let tapDrawMs = 0;
let tapMaxMs = 0;
let tapPendingFrame = false;
let debugOn = false;
let skipButton: HTMLButtonElement | null = null;

/**
 * Picked automatically by `npm run golden` (tests/find-tutorial-seed.mjs): an
 * idle player must survive 4.5-6.8 s, so all three hints land before the first
 * death. Never edit by hand after a table change.
 */
const TUTORIAL_SEED = 6;
const HINT_TEXT = [
  "Das Schiff kreist. Tippe, um zu starten.",
  "Tippe: Richtung wechseln.",
  "Gold sammeln = Punkte. Lücke halten = Leben.",
];

function newSeed(): number {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0] as number;
  } catch {
    /* no crypto available: time based fallback, never used by the simulation */
  }
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
}

function seedFromUrl(): number | null {
  // the URL only splits the parameter; the format itself lives in seedValue()
  const m = /[?&]seed=([^&]*)/.exec(window.location.search);
  return m && m[1] ? seedValue(m[1]) : null;
}

function fmt(value: number): string {
  return value.toLocaleString("de-DE");
}

// ------------------------------------------------------------------ audio fx

function vibrate(pattern: number | number[]): void {
  if (!settings.vibration) return;
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch {
    /* unsupported: ignore */
  }
}

function drainEvents(): void {
  if (!run) return;
  const events = run.events;
  run.events = [];
  for (const ev of events) {
    if (ev.type === "shard") {
      audio.shard(ev.combo, ev.value);
      vibrate(7);
      if (!settings.reduceMotion) {
        elScore.animate([{ transform: "scale(1.1)" }, { transform: "scale(1)" }], { duration: 170, easing: "ease-out" });
      }
      scene.burst(ev.angle, VALUE_COLOR[ev.value] ?? 0x37e8ff, ev.value >= 50 ? 12 : 7, ev.value >= 100 ? 1.4 : 1);
      scene.streak(ev.angle, VALUE_COLOR[ev.value] ?? 0x37e8ff);
    } else if (ev.type === "cleancut") {
      audio.cleanCut();
      vibrate(16);
      // gold belongs to the 100-shard only, so a clean cut flashes white
      scene.burst(ev.angle, 0xffffff, 14, 1.2);
      scene.streak(ev.angle, 0xffffff);
      // gold stays reserved for the 100-shard and the edge slip, so the number is
      // white like the burst — violet marks a bullseye landing
      scene.addFloat(ev.angle, ev.value, scene.landMargin <= 0.15 ? 0x9d7bff : 0xffffff);
    } else if (ev.type === "death") {
      audio.death();
      vibrate([24, 40, 80]);
      scene.addShake(1);
      scene.screenFlash(1);
    } else if (ev.type === "phase") {
      audio.phase();
    }
  }
}

// ------------------------------------------------------------------ hud

function updateHud(): void {
  if (!run) return;
  elScore.textContent = fmt(run.score);
  const phase = phaseAtTick(run.tick);
  const p = paramsForPhase(phase);
  const m = p.mult + Math.floor(run.combo / 6);
  elChain.textContent = run.combo > 1 ? `CHAIN ${run.combo} · ×${m}` : "";
  elPhase.textContent = `PHASE ${String(Math.min(phase, 99)).padStart(2, "0")} · ${p.name}`;
  elBest.textContent = `BEST ${fmt(best)}`;
}

function updateTutorial(dtMs: number): void {
  if (!tutorialActive || !run) return;
  tutorialTimer += dtMs;
  // fixed timeline instead of waiting for optional player behaviour: an idle
  // player must still see all three hints before the first death.
  if (tutorialStep === 0 && !armed) {
    tutorialStep = 1;
    tutorialTimer = 0;
  } else if (tutorialStep === 1 && tutorialTimer > 1400) {
    tutorialStep = 2;
    tutorialTimer = 0;
  } else if (tutorialStep === 2 && tutorialTimer > 2800) {
    tutorialStep = 3;
    tutorialTimer = 0;
  }
  if (tutorialStep >= 3) {
    elHint.classList.remove("on");
    return;
  }
  const text = HINT_TEXT[Math.min(tutorialStep, 2)] ?? "";
  if (text && elHint.textContent !== text) {
    elHint.textContent = text;
    placeDebug();
  }
  elHint.classList.add("on");
}

// ------------------------------------------------------------------ overlay

function showOverlay(html: string): void {
  panel.innerHTML = html;
  overlay.hidden = false;
}
function hideOverlay(): void {
  overlay.hidden = true;
  panel.innerHTML = "";
}

function bind(id: string, fn: () => void): void {
  document.getElementById(id)?.addEventListener("click", fn);
}

function showStart(): void {
  screen = "start";
  showOverlay(`
    <h1>NEON SHIFT</h1>
    <h2>M0 · KERNTEST</h2>
    <p>Ein Kern. Eine Bahn. Ein Tap.</p>
    <p>Tippe, um die Richtung zu wechseln. Sei in der Lücke, wenn die Welle deine Bahn erreicht.</p>
    <div class="actions">
      <button class="primary" id="btn-play">Tippen zum Start</button>
      ${tutorialDone ? "" : '<button class="ghost" id="btn-tutorial">Tutorial (3 Schritte)</button>'}
      <button class="ghost" id="btn-settings">Einstellungen</button>
    </div>
    <div class="hintline">Leertaste · Klick · Tippen</div>
  `);
  bind("btn-play", () => startRun(newSeed()));
  bind("btn-tutorial", () => startRun(TUTORIAL_SEED, true));
  bind("btn-settings", () => openSettings("start"));
}

function showPause(): void {
  screen = "paused";
  const pausePhase = phaseAtTick(run?.tick ?? 0);
  showOverlay(`
    <h2>Pause</h2>
    <div class="big">${fmt(run?.score ?? 0)}</div>
    <p>Phase ${Math.min(pausePhase, 99)} · ${paramsForPhase(pausePhase).name}</p>
    <div class="actions">
      <button class="primary" id="btn-resume">Weiter</button>
      <button class="ghost" id="btn-settings">Einstellungen</button>
      <button class="ghost" id="btn-quit">Aufgeben</button>
    </div>
  `);
  bind("btn-resume", () => resume());
  bind("btn-settings", () => openSettings("paused"));
  bind("btn-quit", () => {
    if (run) endRun(true);
  });
}

function showDead(): void {
  screen = "dead";
  if (!run) return;
  const m = metadata(run);
  // same value as ?seed= accepts, so the number on screen can be typed back
  const tag = seedTag(m.seed);
  showOverlay(`
    <h2>Run beendet</h2>
    <div class="big">${fmt(m.score)}</div>
    <div class="sub">SEED ${tag}</div>
    <div class="stats">
      <div>Phase</div><div><b>${Math.min(m.phase, 99)}</b></div>
      <div>Splitter</div><div><b>${m.shardsCollected} / ${m.shardsSpawned}</b></div>
      <div>Clean Cuts</div><div><b>${m.cleanCuts}</b></div>
      <div>Beste Kette</div><div><b>×${m.bestCombo}</b></div>
      <div>Ticks</div><div><b>${m.endTick}</b></div>
    </div>
    <div class="actions">
      <button class="primary" id="btn-again">Nochmal</button>
      <button class="ghost" id="btn-same">Gleicher Seed</button>
      <button class="ghost" id="btn-settings">Einstellungen</button>
    </div>
    <div class="hintline">?seed=${tag} in der Adresse startet genau diesen Lauf.</div>
    ${lastRunWasTutorial ? '<div class="hintline">Tutorial-Run · zählt nicht für den Bestwert</div>' : ""}
  `);
  bind("btn-again", () => startRun(newSeed()));
  bind("btn-same", () => startRun(run?.seed ?? newSeed()));
  bind("btn-settings", () => openSettings("dead"));
}

type SettingKind = "sound" | "vibration" | "reduceFlash" | "reduceMotion";

/** kind, element id, label and storage key stay together, so one handler serves all four */
const TOGGLES: { kind: SettingKind; id: string; label: string; store: string }[] = [
  { kind: "sound", id: "set-sound", label: "Sound", store: "ns.sound" },
  { kind: "vibration", id: "set-vib", label: "Vibration", store: "ns.bit" },
  { kind: "reduceFlash", id: "set-flash", label: "Blitz-Effekte reduzieren", store: "ns.flash" },
  { kind: "reduceMotion", id: "set-motion", label: "Bewegung reduzieren", store: "ns.motion" },
];

function toggleRow(label: string, on: boolean, id: string): string {
  return `<button class="toggle" id="${id}" data-on="${on}"><span>${label}</span><span class="sw"></span></button>`;
}

function toggleSetting(kind: SettingKind, store: string): void {
  settings[kind] = !settings[kind];
  setItem(store, settings[kind] ? "1" : "0");
  if (kind === "sound") audio.muted = !settings.sound;
  if (kind === "reduceFlash" || kind === "reduceMotion") {
    scene.setAccessibility(settings.reduceFlash, settings.reduceMotion);
  }
  openSettings(settingsReturn);
}

function openSettings(from: "start" | "paused" | "dead"): void {
  settingsReturn = from;
  screen = "settings";
  showOverlay(`
    <h2>Einstellungen</h2>
    ${TOGGLES.map((t) => toggleRow(t.label, settings[t.kind], t.id)).join("")}
    <div class="actions"><button class="ghost" id="btn-back">Zurück</button></div>
    <div class="hintline">Blitz-Limit: max. 3 pro Sekunde, nie vollflächig</div>
  `);
  for (const t of TOGGLES) bind(t.id, () => toggleSetting(t.kind, t.store));
  bind("btn-back", () => {
    if (settingsReturn === "paused") showPause();
    else if (settingsReturn === "dead") showDead();
    else showStart();
  });
}

// ------------------------------------------------------------------ run flow

function startRun(seed: number, tutorial = false): void {
  audio.unlock();
  run = createRun(seed);
  deathHoldMs = 0;
  pendingTap = false;
  armed = true;
  acc = 0;
  tutorialActive = tutorial;
  tutorialStep = 0;
  tutorialTimer = 0;
  scene.reset();
  hideOverlay();
  screen = "playing";
  updateHud();
  elHint.textContent = HINT_TEXT[0] ?? "";
  elHint.classList.add("on");
  placeDebug();
  if (tutorialActive) ensureSkipButton();
}

function ensureSkipButton(): void {
  if (skipButton) return;
  const b = document.createElement("button");
  b.className = "ghost";
  b.textContent = "Tutorial überspringen";
  b.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);bottom:max(20px,env(safe-area-inset-bottom));" +
    "font:inherit;font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:9px 14px;" +
    "border-radius:999px;border:1px solid rgba(120,190,230,.22);background:rgba(10,18,30,.8);color:#9dbdd2;z-index:4;";
  b.addEventListener("click", () => {
    tutorialDone = true;
    setItem("ns.tutorial", "1");
    removeSkipButton();
    startRun(newSeed());
  });
  document.body.appendChild(b);
  skipButton = b;
}

function removeSkipButton(): void {
  if (skipButton) {
    skipButton.remove();
    skipButton = null;
  }
}

function pause(): void {
  if (screen !== "playing") return;
  showPause();
}

function resume(): void {
  if (screen !== "paused") return;
  hideOverlay();
  screen = "playing";
  acc = 0;
  pendingTap = false;
}

function endRun(abandoned = false): void {
  deathHoldMs = 0;
  removeSkipButton();
  elHint.classList.remove("on");
  if (!run) return;
  lastRunWasTutorial = tutorialActive;
  if (abandoned) {
    run.alive = 0;
    run.endTick = run.tick;
  }
  if (!tutorialActive && run.score > best) {
    best = run.score;
    setItem("ns.best", String(best));
  }
  elBest.textContent = `BEST ${fmt(best)}`;
  if (tutorialActive) {
    tutorialActive = false;
    tutorialDone = true;
    setItem("ns.tutorial", "1");
  }
  showDead();
}

// ------------------------------------------------------------------ loop

const STEP_MS = 1000 / TICK_HZ;

// --------------------------------------------------------- resolution brake
/**
 * Sharpness may never cost playability: below ~50 fps the render scaling drops
 * one notch, and it only climbs back after four seconds of a steady 60. Steps
 * are fractions of the device cap, so a dpr-3 phone walks 3.0 -> 2.34 -> 1.86 -> 1.5.
 */
const RES_STEPS = [1, 0.78, 0.62, 0.5];
let resStep = 0;
let slowMs = 0;
let fastMs = 0;
let resWarmMs = 0;

/**
 * The one place the effective backing resolution is computed. The brake may go
 * below one device pixel per CSS pixel (floor 0.5), which is what makes it bite
 * on dpr-1 screens too; resize and the overlay both read this value.
 */
function effectiveResolution(): number {
  return Math.max(0.5, RES_CAP * (RES_STEPS[resStep] ?? 1));
}

function applyResolution(): void {
  app.renderer.resize(app.screen.width, app.screen.height, effectiveResolution());
}

function autoResolution(dt: number): void {
  // a hidden tab or a stalled frame says nothing about the device's headroom
  if (document.hidden || dt > 200) {
    slowMs = 0;
    fastMs = 0;
    return;
  }
  if (resWarmMs < 2500) {
    resWarmMs += dt;
    return;
  }
  if (fps < 50) {
    fastMs = 0;
    slowMs += dt;
  } else {
    slowMs = Math.max(0, slowMs - dt * 0.5);
    if (fps > 58) fastMs += dt;
    else fastMs = 0;
  }
  if (slowMs > 1500 && resStep < RES_STEPS.length - 1) {
    resStep++;
    slowMs = 0;
    fastMs = 0;
    applyResolution();
  } else if (fastMs > 4000 && resStep > 0) {
    resStep--;
    slowMs = 0;
    fastMs = 0;
    applyResolution();
  }
}

function frame(dtMs: number): void {
  const frameStart = performance.now();
  const dt = Math.min(dtMs, 80);
  fps = fps * 0.9 + (1000 / Math.max(1, dt)) * 0.1;
  autoResolution(dt);

  if (screen === "playing" && run && !armed) {
    acc += dt;
    let n = 0;
    while (acc >= STEP_MS && n < MAX_CATCHUP_TICKS) {
      const tap = pendingTap;
      pendingTap = false;
      step(run, tap);
      acc -= STEP_MS;
      n++;
      if (tap) {
        tapSimMs = performance.now() - tapAt;
        tapPendingFrame = true;
      }
      if (run.alive === 0) break;
    }
    if (n >= MAX_CATCHUP_TICKS) acc = 0; // drop the backlog instead of spiralling
    if (n > 0) drainEvents();
    if (run.alive === 0) {
      // the death flare gets the frame to itself before the overlay covers it
      deathHoldMs += dt;
      if (deathHoldMs >= DEATH_FLARE_MS) endRun();
    } else {
      updateHud();
      updateTutorial(dt);
    }
  }

  // while the sim is not running the effect timers freeze too, so the paused
  // frame keeps the moment you stopped on instead of decaying behind the overlay
  scene.update(run, dt, screen !== "playing");

  // background bed follows the chain, and the bass pulse sits on every landing
  const beat = scene.beat;
  if (screen === "playing" && run && run.alive === 1) {
    audio.setIntensity(comboHeat(run.combo));
    if (beat > 0.9 && lastBeat <= 0.9) audio.beatPulse();
  } else {
    audio.setIntensity(0);
  }
  lastBeat = beat;

  if (tapPendingFrame) {
    tapDrawMs = performance.now() - tapAt;
    tapMaxMs = Math.max(tapMaxMs, tapDrawMs);
    tapPendingFrame = false;
  }

  jsFrameSum += performance.now() - frameStart;
  if (++jsFrameCount >= 30) {
    jsFrameMs = jsFrameSum / jsFrameCount;
    jsFrameSum = 0;
    jsFrameCount = 0;
  }
  if (debugOn) updateDebug();
}

function measureSimTickUs(): number {
  let scratch = createRun(1);
  const t0 = performance.now();
  for (let i = 0; i < 4000; i++) {
    if (scratch.alive === 0) scratch = createRun(1);
    step(scratch, false);
  }
  return ((performance.now() - t0) / 4000) * 1000;
}

function updateDebug(): void {
  const now = performance.now();
  if (now - simBenchAt > 1000) {
    simBenchAt = now;
    simUsPerTick = measureSimTickUs();
  }
  if (!run) {
    elDebug.textContent = `kein aktiver Run\nseed —   tick —`;
    return;
  }
  let waves = 0;
  for (let s = 0; s < WAVE_SLOTS; s++) if (run.waves[s * WAVE_STRIDE + W_ACTIVE] === 1) waves++;
  let shards = 0;
  for (let s = 0; s < SHARD_SLOTS; s++) if (run.shards[s * SHARD_STRIDE + S_ACTIVE] === 1) shards++;
  const phase = phaseAtTick(run.tick);
  const mult = paramsForPhase(phase).mult + Math.floor(run.combo / 6);
  elDebug.textContent = [
    `fps      ${fps.toFixed(0)}`,
    `js/frame ${jsFrameMs.toFixed(2)}ms`,
    `res      ${effectiveResolution().toFixed(2)}/${RES_CAP.toFixed(2)}x`,
    `cache    ${scene.rebuilds}`,
    `tap->sim ${tapSimMs > 0 ? tapSimMs.toFixed(1) : "—"}ms`,
    `tap->drw ${tapDrawMs > 0 ? tapDrawMs.toFixed(1) : "—"}ms`,
    `tap max  ${tapMaxMs > 0 ? tapMaxMs.toFixed(1) : "—"}ms`,
    `sim/tick ${simUsPerTick.toFixed(2)}us*`,
    `tick     ${run.tick}`,
    `phase    ${phase}`,
    `score    ${run.score}`,
    `combo    ${run.combo} x${mult}`,
    `waves    ${waves}/${WAVE_SLOTS}`,
    `shards   ${shards}/${SHARD_SLOTS}`,
    `hashes   ${run.hashes.length}`,
    `clamped  ${run.clampedWaves}`,
    `land     ${scene.landMargin >= 0 ? scene.landMargin.toFixed(2) : "—"}`,
    `seed     ${seedTag(run.seed)}`,
    "",
    "* Burst, 4000 Ticks,",
    "  nicht Live-Mittel",
  ].join("\n");
}

app.ticker.add(() => frame(app.ticker.deltaMS));

// ------------------------------------------------------------------ input

function tapAction(when = performance.now()): void {
  if (screen !== "playing" || !run || run.alive === 0) return;
  // The start tap only starts the clock. It must never be a game action.
  if (armed) {
    armed = false;
    pendingTap = false;
    acc = 0;
    audio.unlock();
    // the tutorial keeps its hints on its own timeline
    if (!tutorialActive) elHint.classList.remove("on");
    return;
  }
  // exactly one pending tap between two simulation ticks; the rest are dropped
  pendingTap = true;
  tapAt = when > 0 && when <= performance.now() ? when : performance.now();
}

window.addEventListener(
  "pointerdown",
  (e) => {
    // e.target can be window/document, which have no closest()
    const target = e.target;
    if (target instanceof Element && target.closest("button")) return;
    tapAction(e.timeStamp);
  },
  { passive: true },
);

window.addEventListener("keydown", (e) => {
  const target = e.target;
  if (target instanceof HTMLElement && target.closest("button") && (e.code === "Enter" || e.code === "Space")) {
    target.blur();
  }
  if (e.code === "Space" || e.code === "Enter") {
    if (e.repeat) return;
    e.preventDefault();
    if (screen === "start") {
      startRun(newSeed());
      return;
    }
    if (screen === "paused") {
      resume();
      return;
    }
    if (screen === "dead") {
      startRun(newSeed());
      return;
    }
    tapAction(e.timeStamp);
    return;
  }
  if (e.code === "Escape" || e.code === "KeyP") {
    e.preventDefault();
    if (screen === "playing") pause();
    else if (screen === "paused") resume();
    return;
  }
  if (e.code === "KeyD" && !e.ctrlKey && !e.metaKey) {
    debugOn = !debugOn;
    elDebug.hidden = !debugOn;
    placeDebug();
  }
});

btnPause.addEventListener("click", () => {
  if (screen === "playing") pause();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && screen === "playing") pause();
});
window.addEventListener("blur", () => {
  if (screen === "playing") pause();
});

// ------------------------------------------------------------------ boot

// no keyboard on a phone: ?debug=1 opens the overlay for the device test
if (/[?&]debug=1/.test(window.location.search)) {
  debugOn = true;
  elDebug.hidden = false;
  placeDebug();
}

const urlSeed = seedFromUrl();
if (urlSeed !== null) {
  startRun(urlSeed);
} else {
  showStart();
}
elBest.textContent = `BEST ${fmt(best)}`;
