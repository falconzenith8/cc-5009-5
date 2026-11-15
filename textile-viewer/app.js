// UI controller and textile-render kernel driver.
//
// Responsibilities kept here:
//   - read the material preview controls (pitch, base size, filter mode, bias)
//   - hand them to src/material-params.js for one strict UI -> kernel conversion
//   - drive the GPU execution boundary (src/renderer.js) and the CPU reference
//     (src/weave-sampler.js) from the same validated kernel parameters
//   - publish per-frame sampling evidence (GPU probe vs CPU reference) and the
//     filtering-error panel
//   - record camera trajectories and export reference/screenshot artifacts
//
// All numbers shown in the UI are computed from actual texture data or read
// back from the GPU; nothing is a decorative placeholder.

import { generatePattern, PATTERNS } from './src/procedural-textures.js';
import { buildMipChain, levelErrorAgainstBase } from './src/mipmap.js';
import { createFabricMesh, recomputeFrame } from './src/mesh.js';
import { TextileRenderer, OrbitCamera } from './src/renderer.js';
import {
  uiMaterialParams, toKernelParams, describeKernelParams,
  FILTER_MODES, MaterialParamError,
} from './src/material-params.js';
import { createWeaveSampler, WeaveSampleError } from './src/weave-sampler.js';
import { applyLegacyTextileRenderParams } from './src/textile-render-compat.js';

const $ = (id) => document.getElementById(id);

const state = {
  pattern: 'checker',
  baseSize: 256,
  pitch: 1,
  lodBias: 0,
  filterMode: 0,
  chains: null,
  errors: null,
  recording: false,
  track: [],
  prevFrame: null,
  jitter: 0,
  lastEvidence: null,
  frameErrors: [],
};

const canvas = $('view');
let renderer;

function toast(msg, ms = 4200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(2, Math.floor(rect.width * dpr));
  canvas.height = Math.max(2, Math.floor(rect.height * dpr));
}

// ---- material controls -> kernel parameters ---------------------------------

// Reads the live control values, converts once, and reports conversion
// failures in the UI instead of applying a fallback parameter.
function readUiParams() {
  return uiMaterialParams({
    pitch: $('scale').value,
    baseSize: $('baseSize').value,
    lodBias: $('bias').value,
    filterMode: state.filterMode,
  });
}

function applyKernelParams() {
  const ui = readUiParams();
  const kernel = toKernelParams(ui);
  renderer.applyKernelParams(kernel);
  state.kernel = kernel;
  state.pitch = kernel.textureRepeatPerUv;
  state.lodBias = kernel.lodBiasLevels;
  state.filterMode = kernel.filterMode;
  const d = describeKernelParams(kernel);
  $('vScale').textContent = d.pitch.toFixed(2) + '×';
  $('vBias').textContent = d.lodBias.toFixed(2);
  $('hMode').textContent = d.modeLabel;
  document.querySelectorAll('#modeSeg button').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.mode) === kernel.filterMode));
  return kernel;
}

// ---- texture pipeline -------------------------------------------------------

function rebuildTextures() {
  const gen = generatePattern(state.pattern, state.baseSize, 8);
  state.chains = {
    albedo: buildMipChain(gen.albedo, gen.size, 'scalar'),
    normal: buildMipChain(gen.normal, gen.size, 'normal3'),
    flow: buildMipChain(gen.flow, gen.size, 'vector2'),
  };
  state.errors = {
    albedo: levelErrorAgainstBase(state.chains.albedo, 'scalar'),
    normal: levelErrorAgainstBase(state.chains.normal, 'normal3'),
    flow: levelErrorAgainstBase(state.chains.flow, 'vector2'),
  };
  state.buildRecord = {
    schema: 'textile-texture-build-record/v1',
    pattern: gen.pattern,
    size: gen.size,
    repeat: gen.repeat,
    seed: gen.seed,
    generatedAt: gen.generatedAt,
    elapsedMs: gen.elapsedMs,
    channels: gen.channels,
    samplingSemantics: {
      albedo: 'sRGB8_ALPHA8; shader decodes to linear before lighting',
      normal: 'RGBA8 tangent-space unit normal, linear decode, box average then renormalize per level',
      flow: 'RGBA8 unit in-plane yarn vector, linear decode, box average then renormalize; rotated via mesh tangent frame',
      coverage: 'albedo alpha, scalar box average',
      roughness: 'normal alpha, scalar box average',
      anisotropy: 'flow alpha, scalar box average',
    },
    levels: state.chains.albedo.map((l, i) => ({
      level: i,
      size: l.size,
      filter: i === 0 ? 'procedural base' : 'periodic 2x2 box (wrapped), vectors renormalized',
      rmseAgainstBase: {
        albedo: i === 0 ? 0 : state.errors.albedo[i - 1].rmse,
        normal: i === 0 ? 0 : state.errors.normal[i - 1].rmse,
        flow: i === 0 ? 0 : state.errors.flow[i - 1].rmse,
      },
    })),
  };
  if (renderer) renderer.setTextures(state.chains);
  drawSwatches(gen);
  renderErrorPanel();
}

function drawSwatch(src, ctxCanvas) {
  const c = ctxCanvas;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(c.width, c.height);
  const size = Math.round(Math.sqrt(src.length / 4));
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const sx = Math.floor((x / c.width) * size) % size;
      const sy = Math.floor((y / c.height) * size) % size;
      const si = (sy * size + sx) * 4;
      const di = (y * c.width + x) * 4;
      img.data[di] = src[si];
      img.data[di + 1] = src[si + 1];
      img.data[di + 2] = src[si + 2];
      img.data[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawSwatches(gen) {
  drawSwatch(gen.albedo, $('swAlbedo'));
  drawSwatch(gen.normal, $('swNormal'));
  drawSwatch(gen.flow, $('swFlow'));
}

function renderErrorPanel() {
  const rows = state.errors.albedo.map((e, i) => {
    const rmseA = state.errors.albedo[i].rmse;
    const rmseN = state.errors.normal[i].rmse;
    const rmseF = state.errors.flow[i].rmse;
    const maxErr = Math.max(rmseA, rmseN, rmseF);
    const pct = Math.min(100, maxErr * 100 / 0.35);
    return `<div style="font-size:11px">层级 L${e.level} · ${e.size}px
      <div class="errbar"><i style="width:${pct}%"></i></div>
      <span class="statusline">颜色 ${rmseA.toFixed(4)} · 法线 ${rmseN.toFixed(4)} · 方向 ${rmseF.toFixed(4)}</span>
    </div>`;
  }).join('');
  $('errPanel').innerHTML = `<h2 style="margin:10px 0 6px">过滤误差 (RMSE / 基准级)</h2>${rows}`;
}

// ---- mesh -------------------------------------------------------------------

let mesh;
function rebuildMesh() {
  mesh = createFabricMesh({
    segments: Number($('seg').value),
    tiles: 3,
    bend: Number($('bend').value),
  });
  renderer.setMesh(mesh);
}
function updateBend() {
  mesh.bend = Number($('bend').value);
  recomputeFrame(mesh);
  renderer.setMesh(mesh);
}

// ---- camera + orbit ---------------------------------------------------------

const camera = new OrbitCamera();

function syncCameraUI() {
  $('dist').value = camera.distance;
  $('yaw').value = Math.round(camera.yaw * 180 / Math.PI);
  $('pitch').value = Math.round(camera.pitch * 180 / Math.PI);
  $('vDist').textContent = camera.distance.toFixed(1);
  $('vYaw').textContent = `${Math.round(camera.yaw * 180 / Math.PI)}°`;
  $('vPitch').textContent = `${Math.round(camera.pitch * 180 / Math.PI)}°`;
}

let dragging = false;
let dragButton = 0;
let lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragButton = e.button;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  if (dragButton === 2 || e.shiftKey) {
    const s = camera.distance * 0.0025;
    camera.target[0] -= dx * s * Math.cos(camera.yaw);
    camera.target[1] += dx * s * Math.sin(camera.yaw);
    camera.target[2] += dy * s;
  } else {
    camera.yaw -= dx * 0.006;
    camera.pitch = Math.max(-1.35, Math.min(1.35, camera.pitch + dy * 0.006));
  }
  syncCameraUI();
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.distance = Math.max(2.2, Math.min(20, camera.distance * Math.exp(e.deltaY * 0.001)));
  syncCameraUI();
}, { passive: false });

// ---- sampling evidence ------------------------------------------------------

// Screen-space derivatives at mesh vertex (gx,gy), in mirrored-uv units per
// device pixel. Built from the projected positions of that vertex and its two
// grid neighbors, which is the same local Jacobian dFdx/dFdy measures on the
// GPU. Returns null when the vertex is behind the camera.
function screenDerivativesAtVertex(gx, gy) {
  const m = mesh;
  if (!m) return null;
  const grid = m.segments;
  const row = grid + 1;
  const i = gy * row + gx;
  const j = gy * row + (gx + 1);
  const k = (gy + 1) * row + gx;
  if (gx >= grid || gy >= grid) return null;

  const vp = renderer.currentViewProj(camera);
  const project = (idx) => {
    const px = m.positions[idx * 3];
    const py = m.positions[idx * 3 + 1];
    const pz = m.positions[idx * 3 + 2];
    const cx = vp[0] * px + vp[4] * py + vp[8] * pz + vp[12];
    const cy = vp[1] * px + vp[5] * py + vp[9] * pz + vp[13];
    const cw = vp[3] * px + vp[7] * py + vp[11] * pz + vp[15];
    if (cw <= 1e-6) return null;
    const canvasW = renderer.canvas.width;
    const canvasH = renderer.canvas.height;
    return [(cx / cw + 1) * 0.5 * canvasW, (cy / cw + 1) * 0.5 * canvasH];
  };

  const s0 = project(i), s1 = project(j), s2 = project(k);
  if (!s0 || !s1 || !s2) return null;
  const u0 = [m.uvs[i * 2], m.uvs[i * 2 + 1]];
  const u1 = [m.uvs[j * 2], m.uvs[j * 2 + 1]];
  const u2 = [m.uvs[k * 2], m.uvs[k * 2 + 1]];

  // Screen-space basis vectors (device pixels) and their uv deltas. A
  // degenerate screen edge (sub-pixel mesh at this view) carries no uv
  // information; falling back to the other axis is what a fragment shader
  // would effectively do with a zero-length derivative.
  let e1 = [s1[0] - s0[0], s1[1] - s0[1]];
  const e2 = [s2[0] - s0[0], s2[1] - s0[1]];
  const w1 = [u1[0] - u0[0], u1[1] - u0[1]];
  const w2 = [u2[0] - u0[0], u2[1] - u0[1]];
  if (Math.hypot(e1[0], e1[1]) < 0.5) e1 = [1, 0];
  const det = e1[0] * e2[1] - e1[1] * e2[0];
  if (Math.abs(det) < 1e-9) return null;
  // M maps a screen delta -> uv delta: duvdx, duvdy are the columns.
  const inv = [e2[1] / det, -e2[0] / det, -e1[1] / det, e1[0] / det];
  const duvdx = [inv[0] * w1[0] + inv[1] * w2[0], inv[0] * w1[1] + inv[1] * w2[1]];
  const duvdy = [inv[2] * w1[0] + inv[3] * w2[0], inv[2] * w1[1] + inv[3] * w2[1]];
  return { uv: u0, duvdx, duvdy };
}

// Compare the GPU probe against the CPU reference at identical sampling
// points and report the largest deviations. This is the pixel-error evidence
// behind the HUD's GPU/CPU alignment row.
// Sampling points for the GPU/CPU alignment probe. Points that land on a tile
// seam (uv * pitch within SEAM_EPS of an integer) are skipped: `fract` is
// discontinuous there and a 1-ulp difference in interpolation picks the
// opposite side of the wrap, so "the same sampling point" is undefined. Every
// remaining point is interior to a tile where the coordinate map is smooth.
const SEAM_EPS = 1e-4;
function nearTileSeam(uv, pitch) {
  const isNearInteger = (x) => Math.abs(x - Math.round(x)) < SEAM_EPS;
  return isNearInteger(uv[0] * pitch) || isNearInteger(uv[1] * pitch);
}

function alignmentSamples() {
  const grid = mesh ? mesh.segments : 0;
  if (!grid) return [];
  const pitch = state.kernel ? state.kernel.textureRepeatPerUv : 1;
  const samples = [];
  const offsets = [0.35, 0.5, 0.65];
  for (const fy of offsets) {
    for (const fx of offsets) {
      const gx = Math.min(grid - 1, Math.round(fx * grid));
      const gy = Math.min(grid - 1, Math.round(fy * grid));
      const d = screenDerivativesAtVertex(gx, gy);
      if (d && !nearTileSeam(d.uv, pitch)) samples.push(d);
    }
  }
  return samples;
}

function measureSamplingAlignment() {
  const kernel = state.kernel;
  if (!kernel || !state.chains) return null;
  const deviceAniso = renderer.capabilities.anisotropic ? renderer.capabilities.anisoMax : 1;
  const samples = alignmentSamples();
  if (!samples.length) return null;
  const gpu = renderer.sampleProbe(samples);
  // Mode 1 (hardware mip) delegates level selection to the driver, so the CPU
  // reference is told the level the GPU actually used at each point. Every
  // other mode derives the level from the same formula on both sides.
  const params = {
    textureRepeatPerUv: kernel.textureRepeatPerUv,
    baseTexelsPerTile: kernel.baseTexelsPerTile,
    lodBiasLevels: kernel.lodBiasLevels,
    filterMode: kernel.filterMode,
    deviceAnisoMax: deviceAniso,
  };
  if (kernel.filterMode === 1) {
    samples.forEach((s, i) => { s.driverLod = gpu[i].lod; });
  }
  const sampler = createWeaveSampler({ chains: state.chains, params });
  let maxPix = 0;
  let sumPix = 0;
  let count = 0;
  let maxLod = 0;
  let maxFootRel = 0;
  for (let k = 0; k < samples.length; k++) {
    const cpu = sampler.sample(samples[k]);
    const g = gpu[k];
    for (const fam of ['albedo', 'normal', 'flow']) {
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(cpu[fam][c] * 255 - g[fam][c] * 255);
        maxPix = Math.max(maxPix, diff);
        sumPix += diff;
        count++;
      }
    }
    maxLod = Math.max(maxLod, Math.abs(cpu.lod - g.lod));
    maxFootRel = Math.max(maxFootRel, Math.abs(cpu.footprint.max - g.footprint) / Math.max(g.footprint, 1e-6));
  }
  return {
    points: samples.length,
    maxChannelError: maxPix,
    meanChannelError: sumPix / count,
    maxLodError: maxLod,
    maxFootprintRelativeError: maxFootRel,
    gpuExecuted: gpu.length,
  };
}

// ---- HUD --------------------------------------------------------------------

function updateHud(tel) {
  if (!tel) return;
  $('hLod').textContent = `${tel.lod.toFixed(2)} / ${state.chains.albedo.length - 1}`;
  $('hFoot').textContent = tel.footprintTexels.toFixed(2);
  $('hAniso').textContent = tel.aniso.toFixed(2) + '×';
  $('hDist').textContent = camera.distance.toFixed(2);
  $('hJitter').innerHTML = state.jitter > 0.6
    ? `<span class="badge err">${state.jitter.toFixed(2)}</span>`
    : `<span class="badge ok">${state.jitter.toFixed(2)}</span>`;
  const ev = state.lastEvidence;
  if (ev) {
    const ok = ev.maxChannelError <= 4 && ev.maxLodError <= 0.05 && ev.maxFootprintRelativeError <= 0.02;
    $('hAlign').innerHTML = ok
      ? `<span class="badge ok">${ev.maxChannelError.toFixed(1)}/255</span>`
      : `<span class="badge err">${ev.maxChannelError.toFixed(1)}/255</span>`;
  } else {
    $('hAlign').textContent = '–';
  }
}

// Frame-to-frame jitter: mean absolute pixel difference against the previous
// rendered frame while the camera is held still. Real measurement, not a guess.
function measureJitter() {
  const gl = renderer.gl;
  const w = Math.min(160, canvas.width);
  const h = Math.min(120, canvas.height);
  const buf = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  if (state.prevFrame && state.prevFrame.length === buf.length) {
    let sum = 0;
    for (let i = 0; i < buf.length; i += 4) {
      sum += Math.abs(buf[i] - state.prevFrame[i])
        + Math.abs(buf[i + 1] - state.prevFrame[i + 1])
        + Math.abs(buf[i + 2] - state.prevFrame[i + 2]);
    }
    state.jitter = sum / (w * h * 3);
  }
  state.prevFrame = buf;
}

// ---- main loop --------------------------------------------------------------

function frame() {
  fitCanvas();
  let tel = null;
  try {
    tel = renderer.render(camera);
  } catch (err) {
    reportRenderError(err);
  }
  measureJitter();
  if (tel) updateHud(tel);
  if (state.recording) {
    state.track.push({
      t: performance.now(),
      distance: camera.distance,
      yaw: camera.yaw,
      pitch: camera.pitch,
      target: [...camera.target],
      lod: tel ? tel.lod : null,
      footprint: tel ? tel.footprintTexels : null,
      jitter: state.jitter,
    });
  }
  requestAnimationFrame(frame);
}

let lastRenderError = '';
function reportRenderError(err) {
  const msg = err instanceof MaterialParamError || err instanceof WeaveSampleError
    ? err.message : `${err.name}: ${err.message}`;
  if (msg === lastRenderError) return;
  lastRenderError = msg;
  state.frameErrors.push(msg);
  $('glBadge').className = 'badge err';
  $('glBadge').textContent = '采样失败';
  toast('纺织渲染失败：' + msg, 10000);
}

// ---- controls ---------------------------------------------------------------

function bindControls() {
  $('pattern').addEventListener('change', (e) => {
    state.pattern = e.target.value;
    rebuildTextures();
    refreshEvidence();
  });
  $('baseSize').addEventListener('change', (e) => {
    state.baseSize = Number(e.target.value);
    rebuildTextures();
    applyKernelParams();
    refreshEvidence();
  });
  $('modeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const mode = Number(btn.dataset.mode);
    state.filterMode = mode;
    if (mode === 2 && !renderer.capabilities.anisotropic) {
      toast('设备不支持硬件各向异性：已切换为着色器内椭圆足迹模拟（降级模式）。');
    }
    if (mode === 3) {
      toast('点采样仅用于诊断：远处将出现真实混叠，而非对比度下降。', 6000);
    }
    applyKernelParams();
    refreshEvidence();
  });
  $('bias').addEventListener('input', () => {
    applyKernelParams();
    refreshEvidence();
  });
  $('dist').addEventListener('input', (e) => { camera.distance = Number(e.target.value); syncCameraUI(); });
  $('yaw').addEventListener('input', (e) => { camera.yaw = Number(e.target.value) * Math.PI / 180; syncCameraUI(); });
  $('pitch').addEventListener('input', (e) => {
    camera.pitch = Number(e.target.value) * Math.PI / 180;
    syncCameraUI();
  });
  $('scale').addEventListener('input', () => {
    applyKernelParams();
    refreshEvidence();
  });
  $('bend').addEventListener('input', (e) => {
    $('vBend').textContent = Number(e.target.value).toFixed(2);
    updateBend();
  });
  $('seg').addEventListener('input', (e) => {
    $('vSeg').textContent = e.target.value;
    rebuildMesh();
  });

  $('record').addEventListener('click', () => {
    state.recording = !state.recording;
    $('recDot').classList.toggle('on', state.recording);
    $('recordLabel').textContent = state.recording ? '停止并保存轨迹 (JSON)' : '开始录制相机轨迹';
    if (!state.recording && state.track.length) {
      const blob = new Blob([JSON.stringify({
        exportedAt: new Date().toISOString(),
        pattern: state.pattern,
        filterMode: renderer.filterMode,
        kernel: state.kernel,
        frames: state.track,
      }, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `camera-trajectory-${Date.now()}.json`);
      $('recStatus').textContent = `已保存 ${state.track.length} 帧轨迹`;
      state.track = [];
    } else if (state.recording) {
      state.track = [];
      $('recStatus').textContent = '录制中…';
    }
  });

  $('snap').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = renderer.screenshot();
    a.download = `textile-frame-${Date.now()}.png`;
    a.click();
  });

  $('ref').addEventListener('click', () => {
    // Reference high-sampling image: the level-0 procedural texture is exported
    // at 4x nearest-neighbor scale through an offscreen 2D canvas. This is a
    // real computed output of the same texture data sampled on the cloth, not a
    // smoothed stand-in, and matches the CLI's reference-4x artifacts.
    const REF_FACTOR = 4;
    const gen = generatePattern(state.pattern, state.baseSize, 8);
    const c = document.createElement('canvas');
    c.width = c.height = state.baseSize * REF_FACTOR;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(state.baseSize, state.baseSize);
    img.data.set(gen.albedo);
    const small = document.createElement('canvas');
    small.width = small.height = state.baseSize;
    small.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, c.width, c.height);
    c.toBlob((blob) => downloadBlob(blob, `reference-${REF_FACTOR}x-${state.pattern}-${Date.now()}.png`));
    toast(`参考图已导出（${state.baseSize}px 基准 × ${REF_FACTOR} 最近邻，无平滑）。`);
  });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- evidence refresh -------------------------------------------------------

// Runs the GPU probe + CPU reference comparison after a parameter change and
// updates the evidence readout. Errors surface in the UI, never swallowed.
function refreshEvidence() {
  if (!renderer || !state.chains || !renderer.textures) return;
  try {
    state.lastEvidence = measureSamplingAlignment();
    const ev = state.lastEvidence;
    $('alignStatus').innerHTML = ev
      ? `GPU 探针 ${ev.gpuExecuted} 点 · 通道误差 ≤ ${ev.maxChannelError.toFixed(1)}/255 · `
        + `LOD Δ ≤ ${ev.maxLodError.toFixed(3)} · 足迹相对误差 ≤ ${(ev.maxFootprintRelativeError * 100).toFixed(2)}%`
      : '尚无采样点（相机或网格未就绪）';
  } catch (err) {
    state.lastEvidence = null;
    $('alignStatus').innerHTML = `<span class="err-text">采样对齐失败：${err.message}</span>`;
  }
}

// ---- compatibility adapter (legacy textile-render entry) --------------------

// The pre-refactor external entry point. Callers that used the old flat set of
// fields keep working; the adapter in src/textile-render-compat.js performs
// the same strict conversion and fails loudly on missing fields. Kept so
// existing textile-render call sites (samples, scripts) do not need to know
// the new module boundaries yet.
export function legacyApplyTextileRenderParams(flat) {
  const kernel = applyLegacyTextileRenderParams(renderer, flat);
  state.kernel = kernel;
  state.baseSize = kernel.baseTexelsPerTile;
  state.pitch = kernel.textureRepeatPerUv;
  state.lodBias = kernel.lodBiasLevels;
  state.filterMode = kernel.filterMode;
  return kernel;
}

// ---- boot -------------------------------------------------------------------

function boot() {
  fitCanvas();
  try {
    renderer = new TextileRenderer(canvas);
  } catch (err) {
    $('glBadge').className = 'badge err';
    $('glBadge').textContent = 'WebGL2 不可用';
    toast('图形入口初始化失败：' + err.message + '。请使用支持 WebGL2 的浏览器打开 index.html。', 12000);
    return;
  }
  const cap = renderer.capabilities;
  $('glBadge').className = cap.degradation.length ? 'badge warn' : 'badge ok';
  $('glBadge').textContent = cap.degradation.length
    ? `WebGL2 · 降级 ${cap.degradation.length} 项`
    : 'WebGL2 · 全能力';
  const dd = $('degrade');
  dd.innerHTML = cap.degradation.length
    ? cap.degradation.map((d) => `<div class="item">⚠ ${d}</div>`).join('')
    : '<div class="item" style="color:var(--ok)">✓ 各向异性与浮点缓冲均可用</div>';
  dd.innerHTML += `<div class="item">GPU: ${cap.renderer}</div>`;

  // Default filter mode comes from the capability probe, but is itself a UI
  // material parameter converted through the same single path.
  state.filterMode = cap.anisotropic ? 2 : 0;
  $('modeSeg').dataset.defaultMode = String(state.filterMode);
  rebuildTextures();
  rebuildMesh();
  syncCameraUI();
  state.kernel = applyKernelParams();
  bindControls();
  fitCanvas();
  requestAnimationFrame(frame);

  // Expose handles for automated inspection and the documentation workflow.
  window.__textile = {
    renderer,
    buildRecord: () => structuredClone(state.buildRecord),
    kernel: () => structuredClone(state.kernel),
    evidence: () => structuredClone(state.lastEvidence),
    alignmentSamples: () => alignmentSamples(),
    probe: (points) => renderer.sampleProbe(points),
    kernelParams: () => structuredClone(state.kernel),
    frameErrors: () => state.frameErrors.slice(),
    // Direct sampling entry used by the GUI's own evidence path and by tests:
    sampleWeave: (params, points) => {
      const sampler = createWeaveSampler({ chains: state.chains, params });
      return sampler.sample(points);
    },
    legacyApplyTextileRenderParams,
  };
  window.__textileBuildRecord = window.__textile.buildRecord;
  // Delay the first evidence run until a frame has been rendered.
  setTimeout(refreshEvidence, 300);
}

boot();
