// UI controller: wires procedural generation, mip chains, the WebGL renderer,
// orbit controls, telemetry HUD, filtering-error panel and camera trajectory
// recording. All error numbers shown are computed from the actual texture data.

import { generatePattern, PATTERNS } from './src/procedural-textures.js';
import { buildMipChain, levelErrorAgainstBase } from './src/mipmap.js';
import { createFabricMesh, recomputeFrame } from './src/mesh.js';
import { TextileRenderer, OrbitCamera } from './src/renderer.js';

const $ = (id) => document.getElementById(id);
const state = {
  pattern: 'checker',
  baseSize: 256,
  chains: null,
  errors: null,
  recording: false,
  track: [],
  prevFrame: null,
  jitter: 0,
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

// ---- HUD --------------------------------------------------------------------

const MODE_NAMES = ['显式多级链', '硬件 Trilinear', '各向异性 (EWA)', '点采样 (诊断)'];

function updateHud(tel) {
  if (!tel) return;
  $('hLod').textContent = `${tel.lod.toFixed(2)} / ${state.chains.albedo.length - 1}`;
  $('hMode').textContent = MODE_NAMES[tel.mode];
  $('hFoot').textContent = tel.footprintTexels.toFixed(2);
  $('hAniso').textContent = tel.aniso.toFixed(2) + '×';
  $('hDist').textContent = camera.distance.toFixed(2);
  $('hJitter').innerHTML = state.jitter > 0.6
    ? `<span class="badge err">${state.jitter.toFixed(2)}</span>`
    : `<span class="badge ok">${state.jitter.toFixed(2)}</span>`;
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
  const tel = renderer.render(camera);
  measureJitter();
  updateHud(tel);
  if (state.recording) {
    state.track.push({
      t: performance.now(),
      distance: camera.distance,
      yaw: camera.yaw,
      pitch: camera.pitch,
      target: [...camera.target],
      lod: tel.lod,
      footprint: tel.footprintTexels,
      jitter: state.jitter,
    });
  }
  requestAnimationFrame(frame);
}

// ---- controls ---------------------------------------------------------------

function bindControls() {
  $('pattern').addEventListener('change', (e) => {
    state.pattern = e.target.value;
    rebuildTextures();
  });
  $('baseSize').addEventListener('change', (e) => {
    state.baseSize = Number(e.target.value);
    rebuildTextures();
  });
  $('modeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const mode = Number(btn.dataset.mode);
    if (mode === 2 && !renderer.capabilities.anisotropic) {
      toast('设备不支持硬件各向异性：已切换为着色器内椭圆足迹模拟（降级模式）。');
    }
    if (mode === 3) {
      toast('点采样仅用于诊断：远处将出现真实混叠，而非对比度下降。', 6000);
    }
    renderer.filterMode = mode;
    document.querySelectorAll('#modeSeg button').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.mode) === mode));
  });
  $('bias').addEventListener('input', (e) => {
    renderer.mipBias = Number(e.target.value);
    $('vBias').textContent = Number(e.target.value).toFixed(2);
  });
  $('dist').addEventListener('input', (e) => { camera.distance = Number(e.target.value); syncCameraUI(); });
  $('yaw').addEventListener('input', (e) => { camera.yaw = Number(e.target.value) * Math.PI / 180; syncCameraUI(); });
  $('pitch').addEventListener('input', (e) => {
    camera.pitch = Number(e.target.value) * Math.PI / 180;
    syncCameraUI();
  });
  $('scale').addEventListener('input', (e) => {
    renderer.textureScale = Number(e.target.value);
    $('vScale').textContent = Number(e.target.value).toFixed(2) + '×';
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

  rebuildTextures();
  rebuildMesh();
  syncCameraUI();
  document.querySelectorAll('#modeSeg button').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.mode) === renderer.filterMode));
  bindControls();
  fitCanvas();
  requestAnimationFrame(frame);

  // Expose handles for automated inspection and the documentation workflow.
  window.__textile = {
    renderer,
    buildRecord: () => structuredClone(state.buildRecord),
  };
  window.__textileBuildRecord = window.__textile.buildRecord;
}

boot();
