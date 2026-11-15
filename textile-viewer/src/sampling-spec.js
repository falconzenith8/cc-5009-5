// Single source of truth for textile sampling: coordinate construction (tile
// repeat + mirrored UV folding), screen-derivative footprint estimation, unit
// conversion, and the LOD / anisotropy filter decisions.
//
// Every consumer goes through these definitions:
//   - src/mesh.js              mirrorFold() for the geometry-side UV layout
//   - src/shaders.js           samplingGlsl() injected into the real fragment shader
//   - src/sampling-probe.js    the same GLSL functions in the GPU probe program
//   - src/weave-sampler.js     the CPU reference sampler (JS mirrors below)
//   - src/mipmap.js            selectLod() compatibility adapter
//   - test/headless-logic.test.js
//
// Unit contract: one "footprint" value is the number of BASE-LEVEL texels a
// single device pixel covers along a screen axis. Scale conversion
// (device px / texture tile -> texels / device px) happens exactly here and
// nowhere else.

import { fract } from './math-util.js';

export const FOOTPRINT_FLOOR_TEXELS = 1.0;
export const ANISO_FLOOR = 1e-4;

// Geometry-side UV mirror, applied once when the cloth mesh is built.
// Mirrored tiles sample the same periodic tile with a sign flip, which is why
// yarn direction must travel through the mesh tangent frame (see shaders.js).
export function mirrorFold(t) {
  return 1 - Math.abs(1 - 2 * fract(t));
}

// Sampler-side wrap. `uv` is the mirrored mesh coordinate in [0,1); `scale`
// is the UI thread-pitch multiplier. The result is the in-tile coordinate.
export function repeatTileCoord(uv, scale) {
  return [fract(uv[0] * scale), fract(uv[1] * scale)];
}

// Screen-space UV derivatives -> footprint in base-level texels per device
// pixel. Mirrors txFootprint() in samplingGlsl().
export function footprintFromDerivatives(duvdx, duvdy, scale, baseSize) {
  const sx = duvdx[0] * scale * baseSize;
  const sy = duvdx[1] * scale * baseSize;
  const tx = duvdy[0] * scale * baseSize;
  const ty = duvdy[1] * scale * baseSize;
  const x = Math.hypot(sx, sy);
  const y = Math.hypot(tx, ty);
  return { x, y, max: Math.max(x, y), min: Math.min(x, y) };
}

// Footprint -> implemented mip level. Same rule the shader telemetry reports.
export function lodFromFootprint(footMax, mipBias, levelCount) {
  const last = Math.max(levelCount - 1, 0);
  return Math.min(last, Math.max(0, Math.log2(Math.max(footMax, FOOTPRINT_FLOOR_TEXELS)) + mipBias));
}

// Footprint aspect -> anisotropy ratio requested from the filter.
export function anisotropyFromFootprint(footMax, footMin, anisoMax) {
  return Math.min(Math.max(anisoMax, 1), Math.max(1, footMax / Math.max(footMin, ANISO_FLOOR)));
}

// Fractional blend between two adjacent explicit-chain levels.
export function chainLodBlend(lod) {
  const l0 = Math.floor(lod);
  return { level0: l0, weight: lod - l0 };
}

// Unit adapter for callers that still speak "device pixels covered by one full
// texture tile". Kept so the legacy selectLod entry can route through the
// same footprint definition instead of maintaining a second reciprocal formula.
export function footprintFromCoverage(tileTexels, baseSize) {
  return baseSize / Math.max(tileTexels, 1e-6);
}

// GLSL mirror of every function above. The main fragment shader and the GPU
// alignment probe both include this exact chunk, so a change can only move the
// CPU reference and the real shader together.
export function samplingGlsl() {
  return `
// ---- shared textile sampling spec (see src/sampling-spec.js) ----
vec2 txTileCoord(vec2 uv, float scale) {
  return fract(uv * scale);
}

vec2 txFootprint(vec2 duvdx, vec2 duvdy, float scale, float baseSize) {
  vec2 dudx = duvdx * scale * baseSize;
  vec2 dudy = duvdy * scale * baseSize;
  return vec2(length(dudx), length(dudy));
}

float txLod(float footMax, float mipBias, float levelCount) {
  return clamp(log2(max(footMax, 1.0)) + mipBias, 0.0, max(levelCount - 1.0, 0.0));
}

float txAniso(float footMax, float footMin, float anisoMax) {
  return clamp(footMax / max(footMin, 1e-4), 1.0, max(anisoMax, 1.0));
}

vec4 txSampleChain(sampler2D s, vec2 uv, float lod, float scale, int levelCount) {
  vec2 st = txTileCoord(uv, scale);
  float l0 = floor(lod);
  float f = lod - l0;
  vec4 a = textureLod(s, st, l0);
  vec4 b = textureLod(s, st, min(l0 + 1.0, float(levelCount) - 1.0));
  return mix(a, b, f);
}

// Filter decision + sampling for one texture family. Returns the encoded
// sample and publishes the footprint/LOD/anisotropy actually used, so the
// telemetry pass and the CPU reference describe the same decision.
vec4 txSampleMap(sampler2D s, vec2 uv, vec2 duvdx, vec2 duvdy,
                 int mode, float scale, float baseSize, float mipBias,
                 int levelCount, float anisoMax,
                 out float lodOut, out float footMaxOut, out float anisoOut) {
  vec2 foot = txFootprint(duvdx, duvdy, scale, baseSize);
  float footMax = max(foot.x, foot.y);
  float footMin = min(foot.x, foot.y);
  float lod = txLod(footMax, mipBias, float(levelCount));
  float aniso = txAniso(footMax, footMin, anisoMax);
  lodOut = lod;
  footMaxOut = footMax;
  anisoOut = aniso;

  vec4 sampleValue;
  if (mode == 3) {
    // Diagnostic: single base-level point sample, no filtering.
    vec2 st = txTileCoord(uv, scale);
    ivec2 ipx = ivec2(st * baseSize);
    ipx = ivec2(clamp(ipx, ivec2(0), ivec2(int(baseSize) - 1)));
    sampleValue = texelFetch(s, ipx, 0);
  } else if (mode == 1) {
    // Hardware trilinear; GL computes the LOD internally from derivatives.
    vec2 st = txTileCoord(uv, scale);
    sampleValue = texture(s, st);
  } else {
    sampleValue = txSampleChain(s, uv, lod, scale, levelCount);
    if (mode == 2 && anisoMax <= 1.0 && aniso > 1.5) {
      // Emulated anisotropic filter: spread extra taps along the MAJOR
      // footprint axis while keeping the minor axis at its own LOD.
      vec2 major = length(duvdx) >= length(duvdy) ? duvdx : duvdy;
      vec2 duv = major * 0.5;
      float taps = 3.0;
      for (int i = -1; i <= 1; i++) {
        vec2 uv2 = uv + duv * float(i);
        sampleValue += txSampleChain(s, uv2, lod, scale, levelCount);
      }
      sampleValue /= taps;
    }
  }
  return sampleValue;
}
`;
}
