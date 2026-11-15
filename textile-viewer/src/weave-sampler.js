// CPU reference for the weave sampling kernel.
//
// This module is the "weave sampling interface" the rest of the code talks to
// on the CPU side. It mirrors the GPU path operation for operation:
//   coordinate construction  -> txTileCoord / repeatTileCoord
//   derivative estimation    -> footprintFromDerivatives (the GPU uses dFdx/dFdy)
//   filter decision          -> lodFromFootprint / anisotropyFromFootprint
//   sampling                 -> GL-bilinear in-level + linear across levels
//
// Every parameter is required. Nothing here supplies defaults: a missing
// pitch, base size, LOD bias, filter mode or device anisotropy limit throws,
// so a caller cannot quietly appear to succeed with parameters it never set.
//
// Returned samples are in the same space the shader receives them in:
//   albedo.rgb  hardware sRGB-decoded then linearly filtered (the shader's
//               `albEnc.rgb`; note the shader applies its own transfer on top)
//   normal.rgb  filtered encoded bytes / 255 (shader decodes *2-1)
//   flow.rgb    filtered encoded bytes / 255 (shader decodes *2-1)
//   *.a         linear coverage / roughness / anisotropy, [0,1]

import { wrap, fract } from './math-util.js';
import {
  repeatTileCoord,
  footprintFromDerivatives,
  lodFromFootprint,
  anisotropyFromFootprint,
  chainLodBlend,
} from './sampling-spec.js';

export class WeaveSampleError extends Error {
  constructor(field, message) {
    super(`weave sampling "${field}": ${message}`);
    this.name = 'WeaveSampleError';
    this.field = field;
  }
}

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function requireFinite(field, value, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null || value === '') {
    throw new WeaveSampleError(field, 'missing (this interface applies no defaults)');
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new WeaveSampleError(field, `not a finite number (${value})`);
  if (integer && !Number.isInteger(n)) throw new WeaveSampleError(field, `expected an integer (${value})`);
  if (n < min || n > max) throw new WeaveSampleError(field, `${n} outside [${min}, ${max}]`);
  return n;
}

function requireVec2(field, value) {
  if (!value || value.length !== 2) {
    throw new WeaveSampleError(field, 'expected a [x, y] pair');
  }
  return [requireFinite(`${field}[0]`, value[0]), requireFinite(`${field}[1]`, value[1])];
}

function validateChains(chains, baseTexelsPerTile) {
  for (const name of ['albedo', 'normal', 'flow']) {
    const chain = chains && chains[name];
    if (!Array.isArray(chain) || chain.length === 0) {
      throw new WeaveSampleError(`chains.${name}`, 'missing or empty level chain');
    }
    for (let i = 0; i < chain.length; i++) {
      const level = chain[i];
      if (!level || !Number.isInteger(level.size) || !level.data) {
        throw new WeaveSampleError(`chains.${name}`, `level ${i} is missing size/data`);
      }
      if (level.data.length !== level.size * level.size * 4) {
        throw new WeaveSampleError(`chains.${name}`, `L${i} byte length does not match ${level.size}px RGBA`);
      }
    }
    if (chain[0].size !== baseTexelsPerTile) {
      throw new WeaveSampleError(`chains.${name}.baseSize`,
        `${chain[0].size} does not match kernel baseTexelsPerTile ${baseTexelsPerTile}`);
    }
  }
}

function createParams(params) {
  if (!params || typeof params !== 'object') {
    throw new WeaveSampleError('params', 'missing kernel parameter object');
  }
  return {
    textureRepeatPerUv: requireFinite('textureRepeatPerUv', params.textureRepeatPerUv, { min: 1e-6 }),
    baseTexelsPerTile: requireFinite('baseTexelsPerTile', params.baseTexelsPerTile, { min: 1, integer: true }),
    lodBiasLevels: requireFinite('lodBiasLevels', params.lodBiasLevels),
    filterMode: requireFinite('filterMode', params.filterMode, { min: 0, max: 3, integer: true }),
    deviceAnisoMax: requireFinite('deviceAnisoMax', params.deviceAnisoMax, { min: 1 }),
  };
}

function texel(level, ix, iy, srgbDecode) {
  const s = level.size;
  const o = (wrap(iy, s) * s + wrap(ix, s)) * 4;
  const d = level.data;
  const rgb = srgbDecode
    ? [SRGB_TO_LINEAR[d[o]], SRGB_TO_LINEAR[d[o + 1]], SRGB_TO_LINEAR[d[o + 2]]]
    : [d[o] / 255, d[o + 1] / 255, d[o + 2] / 255];
  return [rgb[0], rgb[1], rgb[2], d[o + 3] / 255];
}

// Bilinear sample of one periodic level; matches GL LINEAR + REPEAT.
function sampleLevel(level, u, v, srgbDecode) {
  const size = level.size;
  const x = u * size - 0.5;
  const y = v * size - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const c00 = texel(level, x0, y0, srgbDecode);
  const c10 = texel(level, x0 + 1, y0, srgbDecode);
  const c01 = texel(level, x0, y0 + 1, srgbDecode);
  const c11 = texel(level, x0 + 1, y0 + 1, srgbDecode);
  const out = new Array(4);
  for (let c = 0; c < 4; c++) {
    const a = c00[c] + (c10[c] - c00[c]) * fx;
    const b = c01[c] + (c11[c] - c01[c]) * fx;
    out[c] = a + (b - a) * fy;
  }
  return out;
}

// Mirrors txSampleChain(): takes the MIRRORED uv plus the pitch, performs the
// same repeatTileCoord step internally.
function sampleChain(chain, lod, uv, scale, srgbDecode) {
  const [u, v] = repeatTileCoord(uv, scale);
  const { level0, weight } = chainLodBlend(Math.min(lod, chain.length - 1));
  const l1 = Math.min(level0 + 1, chain.length - 1);
  const a = sampleLevel(chain[level0], u, v, srgbDecode);
  const b = sampleLevel(chain[l1], u, v, srgbDecode);
  const out = new Array(4);
  for (let c = 0; c < 4; c++) out[c] = a[c] + (b[c] - a[c]) * weight;
  return out;
}

function pointSample(level, uv, scale, srgbDecode) {
  const [u, v] = repeatTileCoord(uv, scale);
  const s = level.size;
  const ix = Math.min(s - 1, Math.max(0, Math.floor(u * s)));
  const iy = Math.min(s - 1, Math.max(0, Math.floor(v * s)));
  return texel(level, ix, iy, srgbDecode);
}

function sampleMap(chain, uv, duvdx, duvdy, params, srgbDecode, driverLod) {
  const scale = params.textureRepeatPerUv;
  const foot = footprintFromDerivatives(duvdx, duvdy, scale, params.baseTexelsPerTile);
  const lod = lodFromFootprint(foot.max, params.lodBiasLevels, chain.length);
  const aniso = anisotropyFromFootprint(foot.max, foot.min, params.deviceAnisoMax);
  let value;
  let lodSource = 'footprint';

  if (params.filterMode === 3) {
    value = pointSample(chain[0], uv, scale, srgbDecode);
    lodSource = 'point-diagnostic';
  } else if (params.filterMode === 1) {
    // Hardware mip: the driver selects the level from the derivative footprint
    // (and applies its own trilinear blend). The CPU cannot know that level
    // a priori, so the caller must pass it per point as `driverLod`; a missing
    // value throws rather than inventing one.
    const hwLod = requireFinite('point.driverLod', driverLod, { min: 0 });
    value = sampleChain(chain, hwLod, uv, scale, srgbDecode);
    lodSource = 'driver-measured';
  } else {
    value = sampleChain(chain, lod, uv, scale, srgbDecode);
    if (params.filterMode === 2 && params.deviceAnisoMax <= 1 && aniso > 1.5) {
      // Emulated anisotropic filter: extra taps along the major footprint axis.
      const major = Math.hypot(duvdx[0], duvdx[1]) >= Math.hypot(duvdy[0], duvdy[1]) ? duvdx : duvdy;
      const tap = [major[0] * 0.5, major[1] * 0.5];
      const acc = [0, 0, 0, 0];
      for (let i = -1; i <= 1; i++) {
        const uv2 = [uv[0] + tap[0] * i, uv[1] + tap[1] * i];
        const s = sampleChain(chain, lod, uv2, scale, srgbDecode);
        for (let c = 0; c < 4; c++) acc[c] += s[c];
      }
      for (let c = 0; c < 4; c++) value[c] = acc[c] / 3;
      lodSource = 'footprint+emulated-aniso';
    }
  }

  return { value, lod, lodSource, footprint: foot, aniso };
}

export function createWeaveSampler({ chains, params }) {
  const p = createParams(params);
  validateChains(chains, p.baseTexelsPerTile);

  return {
    params: p,
    // `point` must carry the mirrored uv and the two screen derivatives of
    // that uv (on GPU these are dFdx/dFdy). Derivatives are explicit inputs,
    // never inferred, so the CPU and GPU estimate footprints from the same
    // numbers. In hardware-mip mode (filterMode 1) `point.driverLod` is also
    // required: the level the driver actually selected for that fragment.
    sample(point) {
      if (!point || typeof point !== 'object') {
        throw new WeaveSampleError('point', 'missing sampling point');
      }
      const uv = requireVec2('point.uv', point.uv);
      const duvdx = requireVec2('point.duvdx', point.duvdx);
      const duvdy = requireVec2('point.duvdy', point.duvdy);

      const albedo = sampleMap(chains.albedo, uv, duvdx, duvdy, p, true, point.driverLod);
      const normal = sampleMap(chains.normal, uv, duvdx, duvdy, p, false, point.driverLod);
      const flow = sampleMap(chains.flow, uv, duvdx, duvdy, p, false, point.driverLod);

      return {
        albedo: albedo.value,
        normal: normal.value,
        flow: flow.value,
        lod: albedo.lod,
        lodSource: albedo.lodSource,
        footprint: albedo.footprint,
        aniso: albedo.aniso,
        filterMode: p.filterMode,
      };
    },
  };
}

// Decode the sampled vectors the way the shader does. Filtering happens on
// encoded values, so both vectors are renormalized exactly as the shader does
// (`normalize(tsNormal)` and the yarn vector before entering the tangent frame).
// `albedoLinear` applies the shader's own srgbToLinear on top of the
// hardware-decoded sample, so it reproduces the lighting input rather than an
// "intended" value.
export function decodeFamilies(sample) {
  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const n = [sample.normal[0] * 2 - 1, sample.normal[1] * 2 - 1, sample.normal[2] * 2 - 1];
  const f = [sample.flow[0] * 2 - 1, sample.flow[1] * 2 - 1];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const fl = Math.hypot(f[0], f[1]) || 1;
  return {
    albedoLinear: sample.albedo.slice(0, 3).map(srgbToLinear),
    tsNormal: [n[0] / nl, n[1] / nl, n[2] / nl],
    tsFlow: [f[0] / fl, f[1] / fl],
    roughness: sample.normal[3],
    anisotropy: sample.flow[3],
  };
}

// Utility shared with fixtures/tests: mirrored uv from a raw repeat coordinate.
export function mirroredUv(rawU, rawV, tiles) {
  const fold = (t) => 1 - Math.abs(1 - 2 * fract(t));
  return [fold(rawU * tiles), fold(rawV * tiles)];
}
