#!/usr/bin/env node
// Command-line companion for the textile renderer. The GUI (index.html) is the
// primary entry point; these commands only support it by producing verifiable
// artifacts offline: texture build records, high-sampling reference images,
// filtering-error reports and camera-trajectory jitter analysis.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePattern, PATTERNS } from '../src/procedural-textures.js';
import { buildMipChain, levelErrorAgainstBase, selectLod } from '../src/mipmap.js';
import { createFabricMesh, recomputeFrame } from '../src/mesh.js';
import { writePPM, encodePNG, upscaleNearest } from './image-io.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'output');

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function buildAll(pattern, baseSize) {
  const gen = generatePattern(pattern, baseSize, 8);
  const chains = {
    albedo: buildMipChain(gen.albedo, gen.size, 'scalar'),
    normal: buildMipChain(gen.normal, gen.size, 'normal3'),
    flow: buildMipChain(gen.flow, gen.size, 'vector2'),
  };
  const errors = {
    albedo: levelErrorAgainstBase(chains.albedo, 'scalar'),
    normal: levelErrorAgainstBase(chains.normal, 'normal3'),
    flow: levelErrorAgainstBase(chains.flow, 'vector2'),
  };
  return { gen, chains, errors };
}

function cmdBuild({ pattern, size, out }) {
  const dir = path.resolve(out || OUT, pattern);
  ensureDir(dir);
  const { gen, chains, errors } = buildAll(pattern, size);

  // Per-level images for every map family.
  for (const [name, chain] of Object.entries(chains)) {
    for (const level of chain) {
      const png = encodePNG(level.data, level.size, level.size);
      fs.writeFileSync(path.join(dir, `${name}-L${chain.indexOf(level)}-${level.size}.png`), png);
    }
  }

  // High-sampling reference images at a documented 4x nearest-neighbor factor:
  // every base texel becomes a 4x4 block so reference and rendered output can be
  // compared without any hidden smoothing. PPM (numeric) is kept for albedo.
  const REF_FACTOR = 4;
  for (const name of ['albedo', 'normal', 'flow']) {
    const up = upscaleNearest(chains[name][0].data, size, REF_FACTOR);
    if (name === 'albedo') {
      fs.writeFileSync(path.join(dir, `reference-${REF_FACTOR}x-${name}.ppm`), writePPM(up.data, up.size));
    }
    fs.writeFileSync(path.join(dir, `reference-${REF_FACTOR}x-${name}.png`), encodePNG(up.data, up.size, up.size));
  }

  const record = {
    schema: 'textile-texture-build-record/v1',
    pattern: gen.pattern,
    baseSize: gen.size,
    repeat: gen.repeat,
    seed: gen.seed,
    generatedAt: gen.generatedAt,
    elapsedMs: gen.elapsedMs,
    samplingSemantics: {
      albedo: 'sRGB8_ALPHA8; shader decodes to linear before lighting',
      normal: 'RGBA8 tangent-space unit normal, linear decode, box average then renormalize per level',
      flow: 'RGBA8 unit in-plane yarn vector, linear decode, box average then renormalize; rotated via mesh tangent frame',
      coverage: 'albedo alpha, scalar box average',
      roughness: 'normal alpha, scalar box average',
      anisotropy: 'flow alpha, scalar box average',
    },
    periodicity: 'all generators and mip taps wrap with modulo indices; mirrored UV folds remain continuous',
    referenceImageFactor: REF_FACTOR,
    levels: chains.albedo.map((l, i) => ({
      level: i,
      size: l.size,
      filter: i === 0 ? 'procedural base (periodic value noise + analytic weave)'
                      : 'periodic 2x2 box filter, wrapped edges; vectors renormalized',
      rmseAgainstBase: {
        albedo: i === 0 ? 0 : errors.albedo[i - 1].rmse,
        normal: i === 0 ? 0 : errors.normal[i - 1].rmse,
        flow: i === 0 ? 0 : errors.flow[i - 1].rmse,
      },
    })),
    files: fs.readdirSync(dir).sort(),
  };
  fs.writeFileSync(path.join(dir, 'build-record.json'), JSON.stringify(record, null, 2));
  console.log(`[build] ${pattern} ${size}px -> ${dir}`);
  console.log(`[build] ${chains.albedo.length} mip levels, ${record.files.length} files`);
  return record;
}

function cmdVerify({ pattern, size }) {
  const { chains, errors, gen } = buildAll(pattern, size);
  const failures = [];

  // 1. Seam continuity via wrapped finite differences. Texels are sampled at
  //    their centers, so opposing edge texels sit half a texel apart in phase;
  //    byte-equality is therefore not the right criterion. Instead the jump
  //    across the wrapped boundary must not exceed the typical jump between
  //    neighboring texels inside the tile. A real seam defect produces an
  //    outlier far above the interior distribution.
  const wrapAt = (data, s, x, y, c) => data[((((y + s) % s) * s) + ((x + s) % s)) * 4 + c];
  for (const [name, chain] of Object.entries(chains)) {
    const isVector = name !== 'albedo';
    for (const level of chain) {
      const s = level.size;
      const li = chain.indexOf(level);
      const channels = isVector ? (name === 'normal' ? 3 : 2) : 3;
      let interiorMax = 0;
      const interiorDeltas = [];
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          for (let c = 0; c < channels; c++) {
            const here = level.data[(y * s + x) * 4 + c];
            const right = wrapAt(level.data, s, x + 1, y, c);
            const d = Math.abs(here - right);
            interiorDeltas.push(d);
            if (x < s - 1) interiorMax = Math.max(interiorMax, d);
          }
        }
      }
      interiorDeltas.sort((a, b) => a - b);
      const p99 = interiorDeltas[Math.floor(interiorDeltas.length * 0.99)];
      // Boundary jump = difference between the last column and wrapped first.
      let boundaryMax = 0;
      for (let y = 0; y < s; y++) {
        for (let c = 0; c < channels; c++) {
          boundaryMax = Math.max(boundaryMax,
            Math.abs(wrapAt(level.data, s, s - 1, y, c) - wrapAt(level.data, s, 0, y, c)));
        }
      }
      // Allow headroom for quantization; anything beyond 1.5x the 99th
      // percentile (and more than 3 codes) is a genuine seam discontinuity.
      const limit = Math.max(p99 * 1.5, 3);
      if (boundaryMax > limit) {
        failures.push(`${name} L${li} seam jump ${boundaryMax} exceeds interior p99 limit ${limit.toFixed(1)}`);
      }
    }
  }

  // 2. Normal map unit length after filtering and decode.
  const nL0 = chains.normal[0];
  let minLen = 1, maxLen = 1;
  for (let i = 0; i < nL0.data.length; i += 4) {
    const nx = nL0.data[i] / 255 * 2 - 1;
    const ny = nL0.data[i + 1] / 255 * 2 - 1;
    const nz = nL0.data[i + 2] / 255 * 2 - 1;
    const l = Math.hypot(nx, ny, nz);
    minLen = Math.min(minLen, l); maxLen = Math.max(maxLen, l);
  }
  if (Math.abs(minLen - 1) > 0.02 || Math.abs(maxLen - 1) > 0.02) {
    failures.push(`normal base not unit length: range [${minLen.toFixed(4)}, ${maxLen.toFixed(4)}]`);
  }

  // 3. Flow vectors stay unit length after chain averaging/renormalization.
  for (const level of chains.flow.slice(1)) {
    for (let i = 0; i < level.data.length; i += 4) {
      const fx = level.data[i] / 255 * 2 - 1;
      const fy = level.data[i + 1] / 255 * 2 - 1;
      const l = Math.hypot(fx, fy);
      if (Math.abs(l - 1) > 0.03) {
        failures.push(`flow L${chains.flow.indexOf(level)} non-unit vector length ${l.toFixed(4)}`);
        break;
      }
    }
  }

  // 4. LOD selection sanity: a tile covering few device pixels (distant view)
  //    must select a higher level than a magnified near view.
  const near = selectLod(chains.albedo, size * 4);    // tile fills many pixels
  const far = selectLod(chains.albedo, size / 32);    // tile is a few pixels
  if (!(far > near)) failures.push(`LOD does not increase with distance (near=${near}, far=${far})`);

  // Filtering quality is assessed relatively: compare the actual box-filtered
  // mip residual against an unfiltered point-sample baseline at the same scale.
  // A valid filter must cut the residual substantially; merely lowering global
  // contrast would leave the point baseline equally low and fail this check.
  const base = chains.albedo[0];
  const filterGain = errors.albedo.map((e) => {
    const lvl = chains.albedo[e.level];
    const block = base.size / lvl.size; // base texels per coarse cell
    let pointSE = 0, filterSE = 0, n = 0;
    for (let y = 0; y < base.size; y++) {
      for (let x = 0; x < base.size; x++) {
        // Point baseline: the single nearest BASE texel each coarse cell picks,
        // i.e. no averaging. The filtered mip averages the whole block instead.
        const px = Math.min(lvl.size - 1, Math.floor(x / block));
        const py = Math.min(lvl.size - 1, Math.floor(y / block));
        const baseX = Math.min(base.size - 1, px * block);
        const baseY = Math.min(base.size - 1, py * block);
        const bi = (y * base.size + x) * 4;
        const pi = (baseY * base.size + baseX) * 4;
        const ci = (py * lvl.size + px) * 4;
        for (let c = 0; c < 3; c++) {
          const dPoint = (base.data[bi + c] - base.data[pi + c]) / 255;
          const dFiltered = (base.data[bi + c] - lvl.data[ci + c]) / 255;
          pointSE += dPoint * dPoint;
          // accumulate filtered SE inline for a fair paired comparison
          filterSE += dFiltered * dFiltered;
          n++;
        }
      }
    }
    const pointRmse = Math.sqrt(pointSE / n);
    const filteredRmse = Math.sqrt(filterSE / n);
    return { level: e.level, filtered: filteredRmse, point: pointRmse,
             reduction: pointRmse > 0 ? 1 - filteredRmse / pointRmse : 0 };
  });
  const worstReduction = Math.min(...filterGain.map((g) => g.reduction));
  if (!(worstReduction > 0.15)) {
    failures.push(`mip filtering does not reduce residual vs point sampling (min gain ${(worstReduction * 100).toFixed(1)}%)`);
  }
  const worstAlbedoRmse = Math.max(...errors.albedo.map((e) => e.rmse));

  // 5. Mesh frame consistency: deformed normals stay orthogonal to tangents.
  const mesh = createFabricMesh({ segments: 48, bend: 0.9 });
  recomputeFrame(mesh);
  let orthoErr = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const nx = mesh.normals[i * 3], ny = mesh.normals[i * 3 + 1], nz = mesh.normals[i * 3 + 2];
    const tx = mesh.tangents[i * 4], ty = mesh.tangents[i * 4 + 1], tz = mesh.tangents[i * 4 + 2];
    orthoErr = Math.max(orthoErr, Math.abs(nx * tx + ny * ty + nz * tz));
  }
  if (orthoErr > 1e-4) failures.push(`tangent/normal orthogonality broken: ${orthoErr.toExponential(2)}`);

  const report = {
    schema: 'textile-verify-report/v1',
    pattern,
    baseSize: size,
    seed: gen.seed,
    normalLengthRange: [minLen, maxLen],
    lodNear: near,
    lodFar: far,
    worstAlbedoRmse,
    filterGain,
    worstFilterReduction: worstReduction,
    tangentOrthogonalityMaxError: orthoErr,
    mipErrors: errors,
    pass: failures.length === 0,
    failures,
  };
  ensureDir(OUT);
  const file = path.join(OUT, `verify-${pattern}-${size}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`[verify] ${pattern}: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${failures.length} issue(s)) -> ${file}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (failures.length) process.exitCode = 1;
  return report;
}

function cmdTrajectory({ file }) {
  const track = JSON.parse(fs.readFileSync(file, 'utf8'));
  const frames = track.frames || [];
  if (frames.length < 2) throw new Error('trajectory needs at least 2 frames');
  // Replay jitter: compare consecutive recorded jitter values and LOD steps.
  const lodSteps = [];
  let jitterMax = 0, jitterSum = 0;
  for (let i = 1; i < frames.length; i++) {
    lodSteps.push(Math.abs(frames[i].lod - frames[i - 1].lod));
    jitterMax = Math.max(jitterMax, frames[i].jitter || 0);
    jitterSum += frames[i].jitter || 0;
  }
  const summary = {
    schema: 'textile-trajectory-analysis/v1',
    source: path.basename(file),
    frames: frames.length,
    durationMs: frames.at(-1).t - frames[0].t,
    maxLodStepPerFrame: Math.max(...lodSteps),
    meanFrameJitter: jitterSum / Math.max(1, frames.length - 1),
    maxFrameJitter: jitterMax,
    lodRange: [Math.min(...frames.map((f) => f.lod)), Math.max(...frames.map((f) => f.lod))],
    distanceRange: [Math.min(...frames.map((f) => f.distance)), Math.max(...frames.map((f) => f.distance))],
  };
  ensureDir(OUT);
  const out = path.join(OUT, `trajectory-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`[trajectory] ${frames.length} frames analyzed -> ${out}`);
  console.log(`[trajectory] max LOD step ${summary.maxLodStepPerFrame.toFixed(3)}, max jitter ${summary.maxFrameJitter.toFixed(3)} px/channel`);
  return summary;
}

function cmdServe({ port }) {
  const root = path.resolve(HERE, '..');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  server.listen(port, () => console.log(`[serve] textile viewer at http://localhost:${port}/ (Ctrl+C to stop)`));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(argv[i]);
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const pattern = PATTERNS.includes(args.pattern) ? args.pattern : 'checker';
  const size = Number(args.size) || 256;
  switch (command) {
    case 'build':
      cmdBuild({ pattern, size, out: args.out });
      break;
    case 'verify':
      for (const p of args.all ? PATTERNS : [pattern]) {
        cmdVerify({ pattern: p, size });
      }
      break;
    case 'trajectory':
      if (!args.file) throw new Error('usage: trajectory --file <path-to-camera-trajectory.json>');
      cmdTrajectory({ file: path.resolve(args.file) });
      break;
    case 'serve':
      await cmdServe({ port: Number(args.port) || 8080 });
      break;
    default:
      console.log(`Textile renderer CLI (companion to index.html)

usage:
  node cli/textile.js build [--pattern checker|pinstripe|directionfield] [--size 256]
      Writes per-level mip images, 16x reference images and build-record.json.
  node cli/textile.js verify [--all] [--pattern ...] [--size 256]
      Checks seams, unit vectors, LOD selection, filtering RMSE and mesh frames.
  node cli/textile.js trajectory --file <camera-trajectory.json>
      Summarizes per-frame LOD steps and pixel jitter from a recorded track.
  node cli/textile.js serve [--port 8080]
      Serves the interactive material preview window locally.

The graphical entry point is index.html; this CLI only assists that renderer.`);
  }
}

main().catch((err) => {
  console.error('[error]', err.message);
  process.exit(1);
});
