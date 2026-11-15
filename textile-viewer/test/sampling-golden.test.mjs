// Compare rendered frames against the frozen sampling golden fixture.
// Fails if a frame's pixels exceed the manifest's equivalence boundary or if
// the executed GPU sampling telemetry moved beyond its tolerance.
//
// Setup mirrors test/e2e-webgl.test.mjs (Playwright + SwiftShader).
// Start the viewer, then:
//   VIEWER_URL=http://localhost:8155/ PLAYWRIGHT_PATH=... node test/sampling-golden.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'sampling-golden');
const manifest = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'manifest.json'), 'utf8'));
const playwrightPath = process.env.PLAYWRIGHT_PATH ||
  new URL('../.e2e/node_modules/playwright/index.js', import.meta.url).pathname;
const URL = process.env.VIEWER_URL || 'http://localhost:8155/';

const pwModule = await import(playwrightPath);
const chromium = pwModule.chromium || pwModule.default.chromium;
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const b = manifest.equivalenceBoundary;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name} ${detail}`);
}

const cpuErrors = await page.evaluate(() => window.__textile.frameErrors());
record('no textile-render kernel errors during run', cpuErrors.length === 0, JSON.stringify(cpuErrors));

for (const f of manifest.frames) {
  await page.setViewportSize({ width: f.vw, height: f.vh });
  await page.waitForTimeout(200);
  await page.selectOption('#pattern', f.pattern);
  await page.selectOption('#baseSize', String(f.size));
  await page.waitForTimeout(300);
  await page.evaluate((s) => {
    const set = (id, v) => {
      const el = document.querySelector(id);
      el.value = String(v);
      el.dispatchEvent(new Event('input'));
    };
    set('#scale', s.scale); set('#dist', s.dist);
    set('#yaw', s.yaw); set('#pitch', s.pitch);
    document.querySelector(`#modeSeg button[data-mode="${s.mode}"]`).click();
  }, f);
  await page.waitForTimeout(600);
  const actual = await page.evaluate(({ width, height }) => {
    const r = window.__textile.renderer;
    const x = Math.floor((r.canvas.width - width) / 2);
    const y = Math.floor((r.canvas.height - height) / 2);
    const buf = r.readCanvasPixels(x, y, width, height);
    let bin = '';
    for (let i = 0; i < buf.length; i += 4096) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 4096));
    }
    const tel = r.lastTelemetry;
    const ev = window.__textile.evidence();
    return {
      base64: btoa(bin),
      lod: tel.lod, footprint: tel.footprintTexels, aniso: tel.aniso, mode: tel.mode,
      evidence: ev,
    };
  }, manifest.crop);
  const expected = zlib.inflateSync(fs.readFileSync(path.join(GOLDEN, `${f.name}.pixels.z`)));
  const got = Buffer.from(actual.base64, 'base64');
  let sum = 0, max = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(expected[i] - got[i]);
    sum += d;
    if (d > max) max = d;
  }
  const mean = sum / expected.length;
  const pixelOk = mean <= b.meanAbsPixelErrorMax && max <= b.maxChannelPixelErrorMax;
  record(`${f.name}: pixels within equivalence boundary`, pixelOk,
    `mean=${mean.toFixed(3)} max=${max} (limit mean<=${b.meanAbsPixelErrorMax}, max<=${b.maxChannelPixelErrorMax})`);

  const footRel = Math.abs(actual.footprint - f.footprint) / Math.max(f.footprint, 1e-6);
  const lodAbs = Math.abs(actual.lod - f.lod);
  record(`${f.name}: executed footprint/LOD unchanged`, footRel <= b.footprintRelativeTolerance && lodAbs <= b.lodAbsoluteTolerance,
    `footprint ${f.footprint.toFixed(4)}->${actual.footprint.toFixed(4)} (Δrel ${footRel.toExponential(2)}), lod ${f.lod.toFixed(4)}->${actual.lod.toFixed(4)}`);

  // The CPU reference must agree with the GPU execution at the same points.
  if (actual.evidence) {
    const e = actual.evidence;
    const alignOk = e.maxChannelError <= b.maxChannelPixelErrorMax && e.maxLodError <= 0.05
      && e.maxFootprintRelativeError <= 0.02;
    record(`${f.name}: GPU probe matches CPU reference`, alignOk,
      `points=${e.gpuExecuted} channel<=${e.maxChannelError.toFixed(1)}/255 lodΔ<=${e.maxLodError.toFixed(4)} footΔrel<=${(e.maxFootprintRelativeError * 100).toFixed(3)}%`);
  } else {
    record(`${f.name}: GPU probe matches CPU reference`, false, 'no evidence produced');
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sampling-golden checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
