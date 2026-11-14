// Procedural, tileable textile texture generation.
// Produces three RGBA arrays:
//   albedo  : RGB color per texel, A = coverage mask (1 inside weave cells)
//   normal  : RGB tangent-space unit normal (encoded 0..255), A = roughness
//   flow    : RGB encoded in-plane yarn direction (unit vector), A = anisotropy
// Every pattern is periodic so mirrored UVs and texture seams sample continuously.

import { TAU, clamp, fract, smoothstep, periodicNoise, encodeNormal, encodeVec2 } from './math-util.js';

export const SEED = 20261114;

export const PATTERNS = ['checker', 'pinstripe', 'directionfield'];

// Palette (linear-ish sRGB values kept in 0..255 for upload; shader does sRGB decode).
const PALETTE = {
  warp: [176, 96, 74],     // terracotta warp yarn
  weft: [72, 96, 132],     // slate blue weft yarn
  light: [228, 220, 204],  // undyed highlight
  dark: [40, 38, 42],      // deep shadow
  stripe: [150, 44, 52],   // pinstripe red
  fieldA: [92, 122, 104],  // sage
  fieldB: [196, 168, 110], // sand
};

function makeRGBA(size) {
  return new Uint8ClampedArray(size * size * 4);
}

// Gaussian-ish bump from yarn center; accepts a continuous (un-wrapped) phase
// and is itself periodic via the triangular wave below.
function yarnProfile(phase, width) {
  const d = 1 - triangleWave(phase); // 0 at center, 1 at edge
  return Math.cos(clamp(d / width, 0, 1) * Math.PI * 0.5);
}

// Continuous triangular distance to the nearest yarn center on the real line.
// Unlike fract-based expressions this is C0 across cell boundaries, and its
// derivative (triangleWaveDeriv) flips sign smoothly through zero, so the
// analytic normal field never jumps at a seam.
function triangleWave(phase) {
  const f = phase - Math.floor(phase);
  return 1 - Math.abs(2 * f - 1); // 1 at center, 0 at cell edge
}
function triangleWaveDeriv(phase) {
  const f = phase - Math.floor(phase);
  return f < 0.5 ? 2 : -2;
}

// Analytic derivative of the yarn dome with respect to continuous phase.
function yarnProfileDeriv(phase, width) {
  const d = 1 - triangleWave(phase); // 0 at center, 1 at edge
  if (d >= width) return 0;
  return Math.sin((d / width) * Math.PI * 0.5) * (-Math.PI / (2 * width)) *
    (-triangleWaveDeriv(phase));
}

// Smoothly blend two unit vectors by scalar t in [0,1], renormalized. This
// removes the hard direction flip at checker-cell boundaries while keeping the
// warp/weft identity inside each cell.
function blendDir(a, b, t) {
  let x = a[0] * (1 - t) + b[0] * t;
  let y = a[1] * (1 - t) + b[1] * t;
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

// Analytic derivatives of weave height for tangent-space normals.
function buildWeave(size, opts) {
  const { pattern, repeat } = opts;
  const height = new Float32Array(size * size);
  const heightDu = new Float32Array(size * size);
  const heightDv = new Float32Array(size * size);
  const warpH = new Float32Array(size * size);
  const weftH = new Float32Array(size * size);
  const overWarp = new Uint8Array(size * size);
  const crossingArr = new Float32Array(size * size);
  const dir = new Float32Array(size * size * 2);
  const anis = new Float32Array(size * size);

  const cells = repeat; // yarn crossings per tile side
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      const v = (y + 0.5) * inv;
      const gx = u * cells;
      const gy = v * cells;
      const idx = y * size + x;

      // Plain-weave over/under as a continuous crossing weight, so height,
      // derivatives and normals stay continuous at cell and tile boundaries.
      const crossing = 0.5 + 0.5 * Math.cos(TAU * (gx + gy)); // 0..1, periodic
      const warpTop = 0.45 + 0.55 * crossing;
      const weftTop = 0.45 + 0.55 * (1 - crossing);
      overWarp[idx] = crossing > 0.5 ? 1 : 0;
      crossingArr[idx] = crossing;

      // Yarn cross-section heights from the continuous triangular wave.
      const wp = yarnProfile(gy, 0.9); // warp runs vertically -> varies in y
      const fp = yarnProfile(gx, 0.9); // weft runs horizontally -> varies in x
      const warp = wp * warpTop;
      const weft = fp * weftTop;
      warpH[idx] = warp;
      weftH[idx] = weft;
      height[idx] = warp + weft;

      // Analytic height derivatives in (u,v) space; periodic continuous terms.
      heightDu[idx] = yarnProfileDeriv(gx, 0.9) * cells * weftTop;
      heightDv[idx] = yarnProfileDeriv(gy, 0.9) * cells * warpTop;

      // Yarn direction: blend the warp and weft axes with the same continuous
      // crossing weight that drives the height field. The field is therefore
      // C0 everywhere, including mirrored UV folds and tile seams.
      const twist = (periodicNoise(u, v, 8, SEED) - 0.5) * 0.18;
      const warpDir = [Math.sin(twist), Math.cos(twist)];
      const weftDir = [Math.cos(twist), Math.sin(twist)];
      const [dx, dy] = blendDir(weftDir, warpDir, crossing);
      dir[idx * 2] = dx;
      dir[idx * 2 + 1] = dy;
      anis[idx] = 0.55 + 0.35 * Math.max(warp, weft);
    }
  }

  // Analytic height gradient -> tangent normal. No neighbor sampling, so the
  // normal field is identical at wrapped edges by construction.
  const albedo = makeRGBA(size);
  const normal = makeRGBA(size);
  const flow = makeRGBA(size);
  const strength = 2.2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      let nx = -heightDu[idx] * strength;
      let ny = -heightDv[idx] * strength;
      let nz = 1;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl; ny /= nl; nz /= nl;

      const n = encodeNormal(nx, ny, nz);
      normal[idx * 4] = n[0];
      normal[idx * 4 + 1] = n[1];
      normal[idx * 4 + 2] = n[2];
      // Roughness: smoother at yarn crowns, rougher in valleys.
      normal[idx * 4 + 3] = Math.round(clamp(210 - height[idx] * 120, 60, 235));

      const e = encodeVec2(dir[idx * 2], dir[idx * 2 + 1]);
      flow[idx * 4] = e[0];
      flow[idx * 4 + 1] = e[1];
      flow[idx * 4 + 2] = 0;
      flow[idx * 4 + 3] = Math.round(anis[idx] * 255);
    }
  }

  paintAlbedo(albedo, size, { pattern, overWarp, crossing: crossingArr, warpH, weftH, dir, anis });
  return { albedo, normal, flow, height, overWarp, dir };
}

function paintAlbedo(albedo, size, ctx) {
  const { pattern, overWarp, warpH, weftH } = ctx;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let base;
      let coverage = 1;

      if (pattern === 'checker') {
        // Continuous warp/weft color blend driven by the crossing weight so the
        // checker is readable without a hard seam discontinuity.
        const t = ctx.crossing[idx];
        base = [
          PALETTE.weft[0] * (1 - t) + PALETTE.warp[0] * t,
          PALETTE.weft[1] * (1 - t) + PALETTE.warp[1] * t,
          PALETTE.weft[2] * (1 - t) + PALETTE.warp[2] * t,
        ];
      } else if (pattern === 'pinstripe') {
        // Thin periodic vertical stripes with smoothstep edges: periodic and
        // free of a hard step that would alias at a tile boundary.
        const stripePhase = fract(u * 8);
        const stripe = 1 - smoothstep(0.04, 0.12, stripePhase);
        base = [
          PALETTE.light[0] * (1 - stripe) + PALETTE.stripe[0] * stripe,
          PALETTE.light[1] * (1 - stripe) + PALETTE.stripe[1] * stripe,
          PALETTE.light[2] * (1 - stripe) + PALETTE.stripe[2] * stripe,
        ];
      } else {
        // Known direction field: color bands follow a smooth swirling scalar field.
        const s = 0.5 + 0.5 * Math.sin(TAU * (u * 2 + 0.35 * Math.sin(TAU * v)));
        const t = smoothstep(0.42, 0.58, s);
        base = [
          PALETTE.fieldA[0] * (1 - t) + PALETTE.fieldB[0] * t,
          PALETTE.fieldA[1] * (1 - t) + PALETTE.fieldB[1] * t,
          PALETTE.fieldA[2] * (1 - t) + PALETTE.fieldB[2] * t,
        ];
      }

      // Shade by the local yarn height so the weave relief is visible in albedo too.
      const relief = 0.72 + 0.28 * clamp(warpH[idx] + weftH[idx], 0, 1);
      const jitter = 0.94 + 0.12 * periodicNoise(u, v, 16, SEED + 7);
      const k = relief * jitter;
      albedo[idx * 4] = clamp(base[0] * k, 0, 255);
      albedo[idx * 4 + 1] = clamp(base[1] * k, 0, 255);
      albedo[idx * 4 + 2] = clamp(base[2] * k, 0, 255);
      albedo[idx * 4 + 3] = Math.round(coverage * 255);
    }
  }
}

// Public entry: build all three maps plus per-texel metadata for a pattern.
export function generatePattern(pattern, size = 256, repeat = 8) {
  if (!PATTERNS.includes(pattern)) throw new Error(`unknown pattern: ${pattern}`);
  const t0 = Date.now();
  const { albedo, normal, flow, height, overWarp, dir } = buildWeave(size, { pattern, repeat });
  return {
    pattern,
    size,
    repeat,
    seed: SEED,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    albedo,
    normal,
    flow,
    height,
    overWarp,
    dir,
    channels: {
      albedo: 'RGBA8: sRGB color; A=coverage',
      normal: 'RGBA8: tangent-space unit normal octa-free encode (n*0.5+0.5); A=roughness',
      flow: 'RGBA8: unit yarn direction (dU,dV) encoded *0.5+0.5; A=anisotropy',
    },
  };
}
