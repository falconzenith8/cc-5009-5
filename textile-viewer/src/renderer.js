// WebGL2 renderer for the textile viewer. Owns capability detection, texture
// upload (with explicit mip chains), camera orbit and per-frame telemetry that
// the UI displays (actual LOD, footprint, sampling mode, degradation flags).

import { VERT, FRAG, BLIT_VERT, BLIT_FRAG } from './shaders.js';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + log);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

export class OrbitCamera {
  constructor(target = [0, 0, 0]) {
    this.target = target;
    this.distance = 6;
    this.yaw = 0.6;
    this.pitch = 0.5;
    this.fov = (45 * Math.PI) / 180;
  }
  position() {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * cp * Math.cos(this.yaw),
      this.target[2] + this.distance * Math.sin(this.pitch),
    ];
  }
  viewMatrix() {
    return m4LookAt(this.position(), this.target, [0, 0, 1]);
  }
  projMatrix(aspect) {
    return m4Perspective(this.fov, aspect, 0.05, 100);
  }
}

// Minimal column-major mat4 helpers (no gl-matrix dependency).
export function m4Perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
export function m4LookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}
function m4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export class TextileRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      preserveDrawingBuffer: true, // needed for screenshot/trajectory export
    });
    if (!gl) {
      throw new Error('WebGL2 unavailable');
    }
    this.gl = gl;
    this.program = program(gl, VERT, FRAG);
    this.blitProgram = program(gl, BLIT_VERT, BLIT_FRAG);
    this.loc = {
      viewProj: gl.getUniformLocation(this.program, 'uViewProj'),
      model: gl.getUniformLocation(this.program, 'uModel'),
      albedo: gl.getUniformLocation(this.program, 'uAlbedo'),
      normal: gl.getUniformLocation(this.program, 'uNormal'),
      flow: gl.getUniformLocation(this.program, 'uFlow'),
      cameraPos: gl.getUniformLocation(this.program, 'uCameraPos'),
      lightDir: gl.getUniformLocation(this.program, 'uLightDir'),
      filterMode: gl.getUniformLocation(this.program, 'uFilterMode'),
      textureScale: gl.getUniformLocation(this.program, 'uTextureScale'),
      mipBias: gl.getUniformLocation(this.program, 'uMipBias'),
      baseSize: gl.getUniformLocation(this.program, 'uBaseSize'),
      levelCount: gl.getUniformLocation(this.program, 'uLevelCount'),
      anisoMax: gl.getUniformLocation(this.program, 'uAnisoMax'),
      pass: gl.getUniformLocation(this.program, 'uPass'),
    };
    this.capabilities = this.detectCapabilities();
    this.filterMode = this.capabilities.anisotropic ? 2 : 0;
    this.mipBias = 0;
    this.textureScale = 1;
    this.vao = null;
    this.indexCount = 0;
    this.lastTelemetry = null;
    this.lightDir = new Float32Array([0.4, -0.5, 0.75]);
    this.debugFbo = null;
  }

  ensureDebugTarget(width, height) {
    this.ensureTarget('debug', width, height);
  }
  ensureSnapshot(width, height) {
    this.ensureTarget('snapshot', width, height);
  }

  // Allocate (or resize) an RGBA8 + depth16 offscreen target used for either
  // telemetry readback or a persistent snapshot of the visible color pass.
  ensureTarget(kind, width, height) {
    const gl = this.gl;
    const fboKey = kind + 'Fbo';
    const texKey = kind + 'Tex';
    const wKey = kind + 'W';
    const hKey = kind + 'H';
    if (this[fboKey] && this[wKey] === width && this[hKey] === height) return;
    if (this[fboKey]) {
      gl.deleteTexture(this[texKey]);
      gl.deleteFramebuffer(this[fboKey]);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`${kind} framebuffer incomplete: 0x${status.toString(16)}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this[texKey] = tex;
    this[fboKey] = fbo;
    this[wKey] = width;
    this[hKey] = height;
  }

  detectCapabilities() {
    const gl = this.gl;
    const extAniso = gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    const anisoMax = extAniso ? gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    const extColor = gl.getExtension('EXT_color_buffer_float');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const degradation = [];
    if (!extAniso) degradation.push('anisotropic filtering unsupported: emulated elliptical taps used');
    if (!extColor) degradation.push('float color buffers unsupported: LDR pipeline only');
    return {
      webgl2: true,
      anisotropic: !!extAniso,
      anisoMax,
      floatBuffer: !!extColor,
      renderer,
      degradation,
    };
  }

  uploadMipTexture(chain, isSrgb) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const internal = isSrgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    for (const level of chain) {
      gl.texImage2D(
        gl.TEXTURE_2D, chain.indexOf(level), internal,
        level.size, level.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, level.data,
      );
    }
    const extAniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (extAniso && this.filterMode === 2) {
      gl.texParameterf(gl.TEXTURE_2D, extAniso.TEXTURE_MAX_ANISOTROPY_EXT, this.capabilities.anisoMax);
    }
    return tex;
  }

  setTextures(chains) {
    const gl = this.gl;
    if (this.textures) {
      for (const t of Object.values(this.textures)) gl.deleteTexture(t);
    }
    this.textures = {
      albedo: this.uploadMipTexture(chains.albedo, true),
      normal: this.uploadMipTexture(chains.normal, false),
      flow: this.uploadMipTexture(chains.flow, false),
    };
    this.levelCount = chains.albedo.length;
    this.baseSize = chains.albedo[0].size;
  }

  setMesh(mesh) {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const upload = (loc, data, size) => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    upload(0, mesh.positions, 3);
    upload(1, mesh.normals, 3);
    upload(2, mesh.tangents, 4);
    upload(3, mesh.uvs, 2);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.vao = vao;
    this.indexCount = mesh.indexCount;
    this.mesh = mesh;
  }

  render(camera, modelMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) {
    const gl = this.gl;
    const aspect = this.canvas.width / this.canvas.height;
    const vp = m4Mul(camera.projMatrix(aspect), camera.viewMatrix());
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.07, 0.075, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.loc.viewProj, false, vp);
    gl.uniformMatrix4fv(this.loc.model, false, modelMatrix);
    const eye = camera.position();
    gl.uniform3fv(this.loc.cameraPos, eye);
    gl.uniform3fv(this.loc.lightDir, this.lightDir);
    gl.uniform1i(this.loc.filterMode, this.filterMode);
    gl.uniform1f(this.loc.textureScale, this.textureScale);
    gl.uniform1f(this.loc.mipBias, this.mipBias);
    gl.uniform1i(this.loc.baseSize, this.baseSize);
    gl.uniform1i(this.loc.levelCount, this.levelCount);
    gl.uniform1f(this.loc.anisoMax, this.capabilities.anisotropic ? this.capabilities.anisoMax : 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.albedo);
    gl.uniform1i(this.loc.albedo, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.normal);
    gl.uniform1i(this.loc.normal, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.flow);
    gl.uniform1i(this.loc.flow, 2);

    gl.bindVertexArray(this.vao);

    // Pass 0: visible color.
    gl.uniform1i(this.loc.pass, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    // Pass 1: telemetry metrics rendered into a small RGBA target, then read
    // back from its center pixel. This keeps the HUD numbers identical to the
    // shader's own LOD/footprint computation rather than a JS approximation.
    this.ensureDebugTarget(this.canvas.width, this.canvas.height);
    gl.uniform1i(this.loc.pass, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.debugFbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    // Snapshot the visible color buffer immediately while it is still valid
    // (after compositing the default framebuffer may be cleared even with
    // preserveDrawingBuffer). Re-render pass 0 into the snapshot target.
    this.ensureSnapshot(this.canvas.width, this.canvas.height);
    gl.uniform1i(this.loc.pass, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.snapshotFbo);
    gl.clearColor(0.07, 0.075, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const px = Math.floor(this.canvas.width / 2);
    const py = Math.floor(this.canvas.height / 2);
    const dbg = new Uint8Array(4);
    // The FBO is right-side-up (no swap), unlike the default framebuffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.debugFbo);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, dbg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lastTelemetry = {
      lodNorm: dbg[0] / 255,
      footprintNorm: dbg[1] / 255,
      anisoNorm: dbg[2] / 255,
      modeNorm: dbg[3] / 255,
      lod: (dbg[0] / 255) * (this.levelCount - 1),
      footprintTexels: Math.pow(2, (dbg[1] / 255) * 10),
      aniso: (dbg[2] / 255) * 16,
      mode: Math.round((dbg[3] / 255) * 3),
      camera: { distance: camera.distance, yaw: camera.yaw, pitch: camera.pitch },
    };
    return this.lastTelemetry;
  }

  screenshot() {
    // Copy the persistent snapshot (same content as the on-screen color pass)
    // into a 2D canvas so PNG export works regardless of buffer compositing.
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.snapshotFbo);
    const w = this.canvas.width, h = this.canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    // FBO origin is bottom-left; flip rows for the top-left 2D canvas.
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      img.data.set(pixels.subarray(src, src + w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  // Read a region of the visible color pass via the persistent snapshot, which
  // survives compositing unlike the default framebuffer.
  readCanvasPixels(x, y, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.snapshotFbo);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return buf;
  }
}
