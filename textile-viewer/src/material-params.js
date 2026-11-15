// Interface material parameters -> sampling kernel parameters.
//
// This is the only place UI units turn into kernel units. The renderer
// (src/renderer.js) is the GPU execution boundary and only ever sees the
// validated object produced here; it performs no unit conversion of its own.
//
// Unit contract
//   pitch      UI slider value = texture tile repeats across one UV unit
//              (dimensionless multiplier). Kernel name: textureRepeatPerUv.
//   baseSize   texels per tile side at level 0. Kernel name: baseTexelsPerTile.
//   lodBias    mip levels added to the footprint-derived LOD.
//   filterMode 0 chain | 1 hardware | 2 anisotropic | 3 point diagnostic.
//
// Conversion is deliberately strict: a missing or out-of-range field throws
// instead of falling back to a default, so a caller cannot appear to succeed
// with parameters the UI never produced.

export const FILTER_MODES = [
  { id: 0, key: 'chain', label: '显式多级链' },
  { id: 1, key: 'hardware', label: '硬件 Trilinear' },
  { id: 2, key: 'anisotropic', label: '各向异性 (EWA)' },
  { id: 3, key: 'point', label: '点采样 (诊断)' },
];

export const PITCH_RANGE = Object.freeze({ min: 0.25, max: 6, step: 0.05 });
export const LOD_BIAS_RANGE = Object.freeze({ min: -2, max: 3, step: 0.05 });
export const BASE_SIZES = Object.freeze([64, 256, 512]);

export class MaterialParamError extends Error {
  constructor(field, message) {
    super(`material parameter "${field}": ${message}`);
    this.name = 'MaterialParamError';
    this.field = field;
  }
}

function requireNumber(field, value, range) {
  if (value === undefined || value === null || value === '') {
    throw new MaterialParamError(field, 'missing (no default is applied)');
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new MaterialParamError(field, `not a finite number (${value})`);
  if (range && (n < range.min || n > range.max)) {
    throw new MaterialParamError(field, `${n} outside [${range.min}, ${range.max}]`);
  }
  return n;
}

export function parseFilterMode(value) {
  const n = requireNumber('filterMode', value);
  if (!Number.isInteger(n) || !FILTER_MODES.some((m) => m.id === n)) {
    throw new MaterialParamError('filterMode', `${value} is not one of 0..3`);
  }
  return n;
}

export function parseBaseSize(value) {
  const n = requireNumber('baseSize', value);
  if (!BASE_SIZES.includes(n)) {
    throw new MaterialParamError('baseSize', `${value} not in {${BASE_SIZES.join(', ')}}`);
  }
  return n;
}

// Raw UI readings (strings from DOM inputs are accepted and converted once).
export function uiMaterialParams({ pitch, baseSize, lodBias, filterMode }) {
  return {
    pitch: requireNumber('pitch', pitch, PITCH_RANGE),
    baseSize: parseBaseSize(baseSize),
    lodBias: requireNumber('lodBias', lodBias, LOD_BIAS_RANGE),
    filterMode: parseFilterMode(filterMode),
  };
}

// Since the UI pitch is already the tile-repeat multiplier, this is an explicit
// identity mapping rather than a hidden scale factor. It is kept as a named
// step so downstream code never multiplies by a stray `8` or `baseSize`.
export function pitchToTextureRepeat(pitch) {
  return pitch;
}

// Kernel parameter object handed to the GPU execution boundary.
export function toKernelParams(ui) {
  const p = uiMaterialParams(ui);
  return {
    textureRepeatPerUv: pitchToTextureRepeat(p.pitch),
    baseTexelsPerTile: p.baseSize,
    lodBiasLevels: p.lodBias,
    filterMode: p.filterMode,
    filterKey: FILTER_MODES.find((m) => m.id === p.filterMode).key,
    // Renderer uniform names are derived here and nowhere else.
    uniforms: {
      textureScale: pitchToTextureRepeat(p.pitch),
      baseSize: p.baseSize,
      mipBias: p.lodBias,
      filterMode: p.filterMode,
    },
  };
}

// Reverse mapping for UI readback (HUD / status text).
export function describeKernelParams(kernel) {
  const mode = FILTER_MODES.find((m) => m.id === kernel.filterMode);
  return {
    pitch: kernel.textureRepeatPerUv,
    baseSize: kernel.baseTexelsPerTile,
    lodBias: kernel.lodBiasLevels,
    modeLabel: mode ? mode.label : `未知模式 ${kernel.filterMode}`,
  };
}
