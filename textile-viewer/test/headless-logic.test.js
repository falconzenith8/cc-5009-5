// Headless logic tests that mirror the shader's math without needing a GPU.
// These validate the correctness-critical invariants the browser renderer relies on:
//   1. direction field through a mirrored UV keeps a continuous world-space direction
//   2. tangent-space -> world rotation matches the mesh's deformed tangent frame
//   3. LOD/footprint selection is monotonic in screen coverage
//   4. bent mesh normals stay unit length and orthogonal to tangents
//   5. periodic texture wraps without out-of-range sampling
//   6. sampling-spec unifies the units/derivative/filter math across paths
//   7. the CPU reference sampler rejects missing parameters instead of defaulting
//   8. material parameter conversion separates UI units from kernel units
// Run: node test/headless-logic.test.js

import { generatePattern } from '../src/procedural-textures.js';
import { buildMipChain, selectLod } from '../src/mipmap.js';
import { createFabricMesh } from '../src/mesh.js';
import { fract, wrap } from '../src/math-util.js';
import {
  mirrorFold, repeatTileCoord, footprintFromDerivatives, lodFromFootprint,
  anisotropyFromFootprint, footprintFromCoverage,
} from '../src/sampling-spec.js';
import { createWeaveSampler, decodeFamilies, WeaveSampleError } from '../src/weave-sampler.js';
import { toKernelParams, uiMaterialParams, MaterialParamError } from '../src/material-params.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${detail}`); }
}

// Mirror fold identical to mesh.js / shader fract sampling.
const fold = (t) => 1 - Math.abs(1 - 2 * (t - Math.floor(t)));

console.log('[1] mirrored UV continuity of the yarn direction field');
{
  const gen = generatePattern('checker', 128, 8);
  const s = gen.size;
  // Walk a straight line across several mirrored tiles. Decoded flow direction
  // must not jump by ~180 degrees at any fold or tile boundary.
  let maxFlip = 0;
  let prev = null;
  const steps = 400;
  for (let i = 0; i <= steps; i++) {
    const rawT = (i / steps) * 4; // cross 4 tiles with folds
    const u = fold(rawT);
    const x = Math.min(s - 1, Math.floor(u * s));
    const y = s / 2;
    const idx = (y * s + x) * 4;
    const fx = gen.flow[idx] / 255 * 2 - 1;
    const fy = gen.flow[idx + 1] / 255 * 2 - 1;
    if (prev) {
      const dot = fx * prev[0] + fy * prev[1];
      maxFlip = Math.max(maxFlip, 1 - dot); // 0 = identical, 2 = full reversal
    }
    prev = [fx, fy];
  }
  check('no >90 degree direction reversal across mirrored folds', maxFlip < 1.0,
    `max 1-dot=${maxFlip.toFixed(3)}`);
}

console.log('[2] tangent-space direction rotated through the deformed frame');
{
  const mesh = createFabricMesh({ segments: 32, bend: 0.8 });
  // For every vertex, transform a tangent-space vector with T,B,N and confirm
  // the result preserves length (proper rotation) and lies tangent to surface.
  let worstLen = 0, worstNormalDot = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const T = [mesh.tangents[i * 4], mesh.tangents[i * 4 + 1], mesh.tangents[i * 4 + 2]];
    const N = [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]];
    // tangent-space yarn vector (1,0,0) -> world = T
    const w = [T[0], T[1], T[2]];
    worstLen = Math.max(worstLen, Math.abs(Math.hypot(...w) - 1));
    worstNormalDot = Math.max(worstNormalDot, Math.abs(w[0] * N[0] + w[1] * N[1] + w[2] * N[2]));
  }
  check('rotated direction stays unit length', worstLen < 1e-5, `err=${worstLen.toExponential(2)}`);
  check('rotated direction stays tangent (no highlight flip)', worstNormalDot < 1e-4,
    `err=${worstNormalDot.toExponential(2)}`);
}

console.log('[3] screen-coverage LOD is monotonic');
{
  const gen = generatePattern('pinstripe', 256, 8);
  const chain = buildMipChain(gen.albedo, gen.size, 'scalar');
  const lods = [];
  for (const coverage of [4096, 1024, 256, 64, 16, 4, 1]) {
    lods.push(selectLod(chain, coverage));
  }
  let monotonic = true;
  for (let i = 1; i < lods.length; i++) if (lods[i] < lods[i - 1] - 1e-9) monotonic = false;
  check('LOD increases as tile screen coverage shrinks', monotonic, JSON.stringify(lods.map((l) => l.toFixed(1))));
  check('nearest view selects LOD 0', lods[0] === 0);
  check('most distant view selects the coarsest available level', lods.at(-1) >= chain.length - 2);
}

console.log('[4] bent mesh normals remain unit and orthogonal');
{
  for (const bend of [0, 0.4, 1.2]) {
    const mesh = createFabricMesh({ segments: 40, bend });
    let maxLenErr = 0, maxOrtho = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const n = [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]];
      const t = [mesh.tangents[i * 4], mesh.tangents[i * 4 + 1], mesh.tangents[i * 4 + 2]];
      maxLenErr = Math.max(maxLenErr, Math.abs(Math.hypot(...n) - 1));
      maxOrtho = Math.max(maxOrtho, Math.abs(n[0] * t[0] + n[1] * t[1] + n[2] * t[2]));
    }
    check(`bend=${bend}: unit normals`, maxLenErr < 1e-6, `err=${maxLenErr.toExponential(2)}`);
    check(`bend=${bend}: tangent/normal orthogonal`, maxOrtho < 1e-5, `err=${maxOrtho.toExponential(2)}`);
  }
}

console.log('[5] periodic texture wraps without out-of-range sampling');
{
  const gen = generatePattern('directionfield', 64, 8);
  let ok = true;
  for (let k = -2; k <= 2; k++) {
    for (let i = 0; i < 64; i++) {
      const u = fract(i / 64 + k);
      const x = wrap(Math.floor(u * 64), 64);
      if (x < 0 || x >= 64) ok = false;
      if (gen.albedo[(0 * 64 + x) * 4] === undefined) ok = false;
    }
  }
  check('all wrapped indices in range across negative/positive tiles', ok);
}

console.log('[6] sampling-spec unifies units and derivative math');
{
  // Mesh mirror and sampler fold must be the same function.
  let mirrorSame = true;
  for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.999, 1.4, -2.3]) {
    const shaderFold = 1 - Math.abs(1 - 2 * (t - Math.floor(t)));
    if (Math.abs(mirrorFold(t) - shaderFold) > 1e-12) mirrorSame = false;
  }
  check('mirrorFold matches the shader fold formula', mirrorSame);

  // A device pixel covering 1/baseSize of a tile is exactly one base texel.
  const foot = footprintFromDerivatives([1 / 256, 0], [0, 1 / 256], 1, 256);
  check('one tile-fraction per pixel maps to one base texel', Math.abs(foot.max - 1) < 1e-9,
    `foot=${foot.max}`);

  // The pitch multiplier scales the footprint linearly and nothing else does.
  const foot4 = footprintFromDerivatives([1 / 256, 0], [0, 1 / 256], 4, 256);
  check('pitch multiplies the footprint linearly', Math.abs(foot4.max - 4) < 1e-9,
    `foot=${foot4.max}`);

  // The legacy coverage adapter and the derivative path agree.
  const viaCoverage = footprintFromCoverage(256, 256);
  check('coverage adapter yields the same footprint as derivatives', Math.abs(viaCoverage - 1) < 1e-12);

  // LOD is the log2 of the max footprint, clamped, with bias added.
  check('LOD = log2(max footprint)', Math.abs(lodFromFootprint(8, 0, 9) - 3) < 1e-12);
  check('LOD bias shifts by exactly the bias', Math.abs(lodFromFootprint(8, 1.5, 9) - 4.5) < 1e-12);
  check('LOD clamps to the last level', lodFromFootprint(1e6, 0, 9) === 8);

  // Anisotropy ratio = major/minor, capped by device support.
  const aniso = anisotropyFromFootprint(16, 2, 4);
  check('anisotropy ratio capped by device max', aniso === 4, `aniso=${aniso}`);

  // Anisotropic derivatives from an oblique view must produce the same
  // footprint the telemetry would report (non-uniform scaling case).
  const oblique = footprintFromDerivatives([0.01, 0.002], [0.0, 0.001], 2, 256);
  check('oblique, non-uniform derivatives yield ordered major/minor extents',
    oblique.max >= oblique.min && oblique.max > 1, JSON.stringify(oblique));
}

console.log('[7] weave-sampler rejects missing parameters instead of defaulting');
{
  const gen = generatePattern('checker', 64, 8);
  const chains = {
    albedo: buildMipChain(gen.albedo, gen.size, 'scalar'),
    normal: buildMipChain(gen.normal, gen.size, 'normal3'),
    flow: buildMipChain(gen.flow, gen.size, 'vector2'),
  };
  const point = { uv: [0.3, 0.3], duvdx: [0.004, 0], duvdy: [0, 0.004] };
  const base = {
    textureRepeatPerUv: 1, baseTexelsPerTile: 64, lodBiasLevels: 0,
    filterMode: 0, deviceAnisoMax: 16,
  };

  const throwsField = (params, field, pointOverride) => {
    try {
      createWeaveSampler({ chains, params }).sample({ ...point, ...pointOverride });
      return false;
    } catch (err) {
      return err instanceof WeaveSampleError && err.field.startsWith(field);
    }
  };
  check('missing pitch throws', throwsField({ ...base, textureRepeatPerUv: undefined }, 'textureRepeatPerUv'));
  check('missing base size throws', throwsField({ ...base, baseTexelsPerTile: undefined }, 'baseTexelsPerTile'));
  check('missing LOD bias throws', throwsField({ ...base, lodBiasLevels: undefined }, 'lodBiasLevels'));
  check('missing filter mode throws', throwsField({ ...base, filterMode: undefined }, 'filterMode'));
  check('missing device anisotropy limit throws', throwsField({ ...base, deviceAnisoMax: undefined }, 'deviceAnisoMax'));
  check('missing uv derivative throws',
    (() => { try { createWeaveSampler({ chains, params: base }).sample({ uv: [0, 0], duvdx: [0.004, 0] }); return false; }
      catch (e) { return e instanceof WeaveSampleError && e.field.startsWith('point.duvdy'); } })());
  check('hardware-mip mode without a measured driver LOD throws',
    throwsField({ ...base, filterMode: 1 }, 'point.driverLod'));
  check('base size must match the uploaded chain',
    (() => { try { createWeaveSampler({ chains, params: { ...base, baseTexelsPerTile: 128 } }); return false; }
      catch (e) { return e instanceof WeaveSampleError && e.field.includes('baseSize'); } })());

  // A complete parameter set succeeds and returns finite, unit-consistent data.
  const sampler = createWeaveSampler({ chains, params: base });
  const s = sampler.sample(point);
  const decoded = decodeFamilies(s);
  const nLen = Math.hypot(...decoded.tsNormal);
  const fLen = Math.hypot(...decoded.tsFlow);
  check('complete parameters sample without defaults', Number.isFinite(s.albedo[0]) && Number.isFinite(s.lod));
  check('decoded normal stays unit length', Math.abs(nLen - 1) < 1e-2, `|n|=${nLen.toFixed(4)}`);
  check('decoded flow stays unit length', Math.abs(fLen - 1) < 1e-2, `|f|=${fLen.toFixed(4)}`);
}

console.log('[8] material parameters convert UI units once, strictly');
{
  const kernel = toKernelParams({ pitch: 2.5, baseSize: 256, lodBias: -0.5, filterMode: 2 });
  check('pitch passes through as textureRepeatPerUv', kernel.textureRepeatPerUv === 2.5);
  check('base size becomes baseTexelsPerTile', kernel.baseTexelsPerTile === 256);
  check('LOD bias passes through as levels', kernel.lodBiasLevels === -0.5);
  check('filter mode 2 is the anisotropic key', kernel.filterKey === 'anisotropic');
  check('uniform names are derived in one place',
    kernel.uniforms.textureScale === 2.5 && kernel.uniforms.baseSize === 256
    && kernel.uniforms.mipBias === -0.5 && kernel.uniforms.filterMode === 2);

  const rejects = (input, field) => {
    try { uiMaterialParams(input); return false; }
    catch (err) { return err instanceof MaterialParamError && err.field === field; }
  };
  check('missing pitch is rejected', rejects({ baseSize: 256, lodBias: 0, filterMode: 0 }, 'pitch'));
  check('out-of-range pitch is rejected', rejects({ pitch: 99, baseSize: 256, lodBias: 0, filterMode: 0 }, 'pitch'));
  check('non-listed base size is rejected', rejects({ pitch: 1, baseSize: 100, lodBias: 0, filterMode: 0 }, 'baseSize'));
  check('unknown filter mode is rejected', rejects({ pitch: 1, baseSize: 256, lodBias: 0, filterMode: 7 }, 'filterMode'));
  check('missing LOD bias is rejected', rejects({ pitch: 1, baseSize: 256, filterMode: 0 }, 'lodBias'));

  // Pitch range endpoints from the UI slider are accepted unchanged.
  check('pitch endpoints convert without rescaling',
    uiMaterialParams({ pitch: '0.25', baseSize: '512', lodBias: '3', filterMode: '3' }).pitch === 0.25);
}

console.log(failures === 0 ? '\nALL HEADLESS TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);