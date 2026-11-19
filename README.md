# NEON SHIFT — M0

Kernmechanik-Test eines 2D-Arcade-Spiels. Ein Schiff kreist um einen Kern und
kann nur die Drehrichtung umkehren. Ringwellen laufen nach außen, ihre Lücke
driftet. Splitter sammeln kostet Sicherheit.

## Befehle

    npm install
    npm run dev      # http://127.0.0.1:5173
    npm test         # Sim-Typecheck + Node-Tests (Determinismus, Fairness, Bots)
    npm run build    # tsc --noEmit && vite build
    npm run bench    # Sim-Zeit pro Tick, kein Testkriterium
    npm run golden   # goldens + Tutorial-Seed neu erzeugen

## Steuerung

Tippen / Klick / Leertaste = Richtung wechseln, Esc oder P = Pause,
`D` = Debug-Overlay, `?seed=<base36>` erzwingt einen Seed.

## Regeln v7

v6 (Lücke 12000, Lead 120) wurde verworfen: belastbar besser erst ab vier Taps pro Welle.
v7 behält die v5-Tabelle (10500/9600, Lead 210/196), die v4 bei ein bis vier Taps dominiert.

## Aufbau

- `src/sim/sim.ts` — reine Simulation, deterministisch, RULES_VERSION 7
- `src/render.ts` / `src/audio.ts` / `src/main.ts` — Bild, Sound, UI
- `tests/` — Float-Referenz, Golden-Werte, Bots, Fairness-Validator
