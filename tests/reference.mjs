/**
 * Independent reference, written from the algorithm descriptions — never
 * imported by src/. Deliberately a different style (floats, explicit loops)
 * so the tests cannot merely confirm the integer implementation.
 */

/** angle normalised into [0, 65536), float-based */
export function refWrap(a) {
  const T = 65536;
  let r = a - Math.floor(a / T) * T;
  if (r < 0) r += T;
  if (r >= T) r -= T;
  return r;
}

/** shortest signed delta from `from` to `to`, range [-32768, 32768) */
export function refDelta(from, to) {
  const T = 65536;
  let d = refWrap(to - from);
  if (d >= T / 2) d -= T;
  return d;
}

export function refTruncDiv(a, b) {
  const q = a / b;
  const r = q < 0 ? Math.ceil(q) : Math.floor(q);
  // the reference had the same -0 defect as the implementation; 0 is correct
  return r === 0 ? 0 : r;
}

export function refInterp(delta, num, den) {
  if (den <= 0) return 0;
  return refTruncDiv(delta * num, den);
}

/** mulberry32 exactly as published, state kept unsigned */
export function refMulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** independent FNV-1a over int32 values, 4 bytes little endian each */
export function refFnv1a(values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    const u = v >>> 0;
    for (let b = 0; b < 4; b++) {
      h ^= (u >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}
