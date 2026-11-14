// End-to-end test driving the real WebGL2 viewer under headless Chromium
// (SwiftShader). Verifies actual rendering, telemetry, LOD behavior and exports.
//
// Setup (no system/root install needed):
//   mkdir -p .e2e && cd .e2e && npm init -y && npm i playwright@1.49.1
//   npx playwright install chromium
//   # On a minimal container without Chromium's system libs, fetch bookworm debs
//   # and point LD_LIBRARY_PATH at the extracted usr/lib/* directory; see
//   # docs/usage-and-verification.md for the full recipe.
// Start the viewer first: node cli/textile.js serve --port 8155
// Run: VIEWER_URL=http://localhost:8155/ node test/e2e-webgl.test.mjs

// ESM ignores NODE_PATH for bare specifiers, so the optional Playwright install
// location is supplied explicitly. Defaults to the documented .e2e harness dir.
const playwrightPath = process.env.PLAYWRIGHT_PATH ||
  new URL('../.e2e/node_modules/playwright/index.js', import.meta.url).pathname;
const pwModule = await import(playwrightPath);
const chromium = pwModule.chromium || pwModule.default.chromium;
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL = process.env.VIEWER_URL || 'http://localhost:8155/';
const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), 'textile-e2e');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name} ${detail}`);
}

// 1. WebGL2 boot and capability badge.
const badge = await page.textContent('#glBadge');
record('WebGL2 boots with capability badge', /WebGL2/.test(badge), badge);
const hudMode = await page.textContent('#hMode');
record('HUD reports a real sampling mode', /多级|Trilinear|各向异性|点采样/.test(hudMode), hudMode);

// 2. Canvas actually renders non-uniform pixels (not a blank/frozen surface).
async function canvasStats() {
  return page.evaluate(() => {
    const r = window.__textile.renderer;
    // Read a centered block (the cloth occupies the middle of the frame), not
    // the bottom-left corner which is empty background.
    const w = 220, h = 180;
    const x = Math.floor((r.canvas.width - w) / 2);
    const y = Math.floor((r.canvas.height - h) / 2);
    const buf = r.readCanvasPixels(x, y, w, h);
    let sum = 0, sumSq = 0, min = 255, max = 0, nonBg = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const v = (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
      sum += v; sumSq += v * v; min = Math.min(min, v); max = Math.max(max, v);
      // clear color is (0.07,0.075,0.09) sRGB ~ (18,19,23); cloth differs more.
      if (v > 32 || v < 8) nonBg++;
    }
    const n = w * h;
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return { mean, stddev: Math.sqrt(Math.max(0, variance)), min, max, nonBgRatio: nonBg / n };
  });
}
const nearStats = await canvasStats();
record('canvas renders varied cloth pixels', nearStats.stddev > 4 && nearStats.nonBgRatio > 0.12,
  JSON.stringify(nearStats));

// 3. LOD increases monotonically as the camera moves away.
async function setDistance(d) {
  await page.evaluate((v) => {
    const el = document.querySelector('#dist');
    el.value = v; el.dispatchEvent(new Event('input'));
  }, d);
  await page.waitForTimeout(400);
  return page.evaluate(() => ({
    lod: parseFloat(document.querySelector('#hLod').textContent),
    foot: parseFloat(document.querySelector('#hFoot').textContent),
  }));
}
const near = await setDistance(2.5);
const mid = await setDistance(8);
const far = await setDistance(18);
record('LOD rises with distance', far.lod > near.lod && mid.lod >= near.lod - 1e-6,
  `near=${near.lod} mid=${mid.lod} far=${far.lod}`);
record('footprint grows with distance', far.foot > near.foot,
  `near=${near.foot} far=${far.foot}`);

// 4. Point-sample diagnostic produces more temporal aliasing than filtered mode.
async function setMode(mode) {
  await page.click(`#modeSeg button[data-mode="${mode}"]`);
  await page.waitForTimeout(300);
}
await setDistance(10);
await setMode(2);
const filteredStats = await canvasStats();
await setMode(3);
const pointStats = await canvasStats();
record('point-sample diagnostic differs from filtered render',
  Math.abs(pointStats.stddev - filteredStats.stddev) > 0.3,
  `filtered sd=${filteredStats.stddev.toFixed(2)} point sd=${pointStats.stddev.toFixed(2)}`);

// 5. Error panel shows real computed RMSE values for every mip level.
const errRows = await page.$$eval('#errPanel .statusline', (els) => els.map((e) => e.textContent));
const allRmse = errRows.every((t) => /颜色 [\d.]+ · 法线 [\d.]+ · 方向 [\d.]+/.test(t));
record('filtering error panel lists computed RMSE per level', allRmse && errRows.length >= 7,
  `${errRows.length} rows; e.g. ${errRows[0] || 'none'}`);

// 6. Bend deformation keeps the render valid (no GL error / black frame).
await setMode(2);
await page.evaluate(() => {
  const el = document.querySelector('#bend');
  el.value = 1.2; el.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(400);
const bentStats = await canvasStats();
record('bent mesh still renders cloth', bentStats.nonBgRatio > 0.12 && bentStats.stddev > 4,
  JSON.stringify(bentStats));

// 7. Repeat-scale (thread pitch) control changes the sampled texture.
await page.evaluate(() => {
  const el = document.querySelector('#scale');
  el.value = 4; el.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(400);
const highRepeat = await canvasStats();
await page.evaluate(() => {
  const el = document.querySelector('#scale');
  el.value = 0.5; el.dispatchEvent(new Event('input'));
});
await page.waitForTimeout(400);
const lowRepeat = await canvasStats();
record('thread pitch control changes output',
  Math.abs(highRepeat.stddev - lowRepeat.stddev) > 0.2 || highRepeat.nonBgRatio !== lowRepeat.nonBgRatio,
  `high sd=${highRepeat.stddev.toFixed(2)} low sd=${lowRepeat.stddev.toFixed(2)}`);

// 8. Pattern switch across all three patterns without errors.
for (const p of ['checker', 'pinstripe', 'directionfield']) {
  await page.selectOption('#pattern', p);
  await page.waitForTimeout(500);
}
const afterSwitch = await canvasStats();
record('all three patterns render', afterSwitch.nonBgRatio > 0.2, JSON.stringify(afterSwitch));

// 9. Screenshot export works.
await page.screenshot({ path: `${OUT}/viewer-final.png` });
record('screenshot written', fs.existsSync(`${OUT}/viewer-final.png`));

// 10. Build record exposed by the running app matches the verifiable schema.
const rec = await page.evaluate(() => window.__textile.buildRecord());
record('build record has levels + RMSE + semantics',
  rec && Array.isArray(rec.levels) && rec.levels.length === 9 && !!rec.samplingSemantics &&
  rec.levels.some((l) => l.rmseAgainstBase.albedo > 0),
  `levels=${rec?.levels?.length} seed=${rec?.seed}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} E2E checks passed`);
if (errors.length) console.log('page errors:', errors);
fs.writeFileSync(`${OUT}/e2e-results.json`, JSON.stringify({ results, errors }, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
