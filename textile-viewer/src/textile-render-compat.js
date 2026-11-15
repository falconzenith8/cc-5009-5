// Compatibility adapter for the pre-refactor textile-render entry point.
//
// Before the sampling responsibilities were split, callers passed one flat
// object with `textureScale`/`baseSize`/`mipBias`/`filterMode` directly to the
// renderer and sampled through that same flat shape. Those call sites are kept
// working here: this module accepts the old field names, performs the same
// single strict conversion as the UI path, and hands back either kernel
// parameters or a CPU sampler.
//
// It deliberately has no defaults. A legacy caller that forgot a field gets a
// loud MaterialParamError, exactly like a new caller, so the compatibility
// path cannot mask a misconfiguration.

import { toKernelParams, MaterialParamError } from './material-params.js';
import { createWeaveSampler } from './weave-sampler.js';

// Old field -> new field. Both spellings are accepted because some older
// scripts used the UI labels (`pitch`, `lodBias`) rather than the uniform
// names. Exactly one spelling must be present; if both are given they must
// agree, otherwise the conversion is ambiguous and throws.
const LEGACY_FIELDS = {
  pitch: ['textureScale', 'pitch'],
  baseSize: ['baseSize'],
  lodBias: ['mipBias', 'lodBias'],
  filterMode: ['filterMode'],
};

function pick(flat, field) {
  const names = LEGACY_FIELDS[field];
  const present = names.filter((n) => flat[n] !== undefined && flat[n] !== null);
  if (present.length === 0) {
    throw new MaterialParamError(field, `legacy textile-render entry is missing ${names.join(' or ')}`);
  }
  const values = present.map((n) => Number(flat[n]));
  if (values.some((v) => !Number.isFinite(v)) || values.some((v) => v !== values[0])) {
    throw new MaterialParamError(field, `ambiguous legacy values: ${present.map((n) => `${n}=${flat[n]}`).join(', ')}`);
  }
  return values[0];
}

export function legacyToUiParams(flat) {
  if (!flat || typeof flat !== 'object') {
    throw new MaterialParamError('params', 'legacy textile-render entry needs an object');
  }
  return {
    pitch: pick(flat, 'pitch'),
    baseSize: pick(flat, 'baseSize'),
    lodBias: pick(flat, 'lodBias'),
    filterMode: pick(flat, 'filterMode'),
  };
}

export function legacyToKernelParams(flat) {
  return toKernelParams(legacyToUiParams(flat));
}

// Old sampler entry: `{ chains, textureScale, baseSize, mipBias, filterMode }`
// in, a CPU sampler out. `deviceAnisoMax` is required because the old renderer
// had no way to express "no anisotropic hardware" to its sampler.
export function legacyCreateSampler(flat, chains, deviceAnisoMax) {
  const kernel = legacyToKernelParams(flat);
  if (deviceAnisoMax === undefined || deviceAnisoMax === null) {
    throw new MaterialParamError('deviceAnisoMax', 'legacy sampler entry requires the device anisotropy limit');
  }
  return createWeaveSampler({
    chains,
    params: {
      textureRepeatPerUv: kernel.textureRepeatPerUv,
      baseTexelsPerTile: kernel.baseTexelsPerTile,
      lodBiasLevels: kernel.lodBiasLevels,
      filterMode: kernel.filterMode,
      deviceAnisoMax,
    },
  });
}

// Apply legacy flat parameters to a renderer that implements
// applyKernelParams(). Returns the converted kernel parameters.
export function applyLegacyTextileRenderParams(renderer, flat) {
  if (!renderer || typeof renderer.applyKernelParams !== 'function') {
    throw new MaterialParamError('renderer', 'renderer does not implement applyKernelParams()');
  }
  const kernel = legacyToKernelParams(flat);
  renderer.applyKernelParams(kernel);
  return kernel;
}
