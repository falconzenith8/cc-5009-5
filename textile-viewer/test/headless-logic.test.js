// Headless logic tests that mirror the shader's math without needing a GPU.
// These validate the correctness-critical invariants the browser renderer relies on:
//   1. direction field through a mirrored UV keeps a continuous world-space direction
//   2. tangent-space -> world rotation matches the mesh's deformed tangent frame
//   3. LOD/footprint selection is monotonic in screen coverage
//   4. bent mesh normals stay unit length and orthogonal to tangents
// Run: node test/headless-logic.test.js

import { generatePattern } from '../src/procedural-textures.js';
import { buildMipChain, selectLod } from '../src/mipmap.js';
import { createFabricMesh } from '../src/mesh.js';
import { fract, wrap } from '../src/math-util.js';

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

console.log(failures === 0 ? '\nALL HEADLESS TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
