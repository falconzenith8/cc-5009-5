// Shared math helpers. Pure functions, no DOM, works in Node and browser.

export const TAU = Math.PI * 2;

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function fract(x) {
  return x - Math.floor(x);
}

// Wrap a texel index into [0, size) with periodic boundary.
export function wrap(i, size) {
  return ((i % size) + size) % size;
}

// Signed angular difference in (-PI, PI].
export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= TAU;
  while (d <= -Math.PI) d += TAU;
  return d;
}

// Encode an in-plane 2D vector (any length) into 2 signed byte channels [0,255].
export function encodeVec2(x, y) {
  return [
    Math.round(clamp(x * 0.5 + 0.5, 0, 1) * 255),
    Math.round(clamp(y * 0.5 + 0.5, 0, 1) * 255),
  ];
}

export function decodeVec2(r, g) {
  return [(r / 255) * 2 - 1, (g / 255) * 2 - 1];
}

// Encode a unit tangent-space normal (nx, ny, nz) into 3 unsigned bytes.
export function encodeNormal(nx, ny, nz) {
  return [
    Math.round(clamp(nx * 0.5 + 0.5, 0, 1) * 255),
    Math.round(clamp(ny * 0.5 + 0.5, 0, 1) * 255),
    Math.round(clamp(nz * 0.5 + 0.5, 0, 1) * 255),
  ];
}

// Value hash in [0,1), deterministic, periodic-friendly when coords are integers.
export function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Periodic value noise on a period-sized integer lattice; u,v are in [0,1).
// Interpolation uses wrapped neighbor weights, so the result is C0-continuous
// across the u=0/1 and v=0/1 seam (required for tileable textures).
export function periodicNoise(u, v, period, seed = 0) {
  const x = u * period;
  const y = v * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const p = period;
  const h = (ix, iy) => hash2(wrap(ix, p), wrap(iy, p), seed);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}
