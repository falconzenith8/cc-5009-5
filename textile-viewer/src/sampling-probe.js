// GPU sampling-alignment probe.
//
// Draws a full-screen triangle into a small target whose interpolated UV is
// constructed so that dFdx(uv) == the caller's duvdx and dFdy(uv) == duvdy
// exactly. That means hardware mip selection (mode 1) sees the same
// derivatives the explicit-chain modes use, and the real fragment shader's
// `texture()` path is exercised rather than approximated.
//
// The sampled functions come from src/sampling-spec.js — the same GLSL the
// cloth shader compiles. Values are written to RGBA32F attachments when the
// device supports them, so footprint/LOD/vector metrics are read back without
// 8-bit quantization. Read the center pixel, whose UV equals the requested
// sample point.

import { samplingGlsl } from './sampling-spec.js';

export const PROBE_TARGET_SIZE = 8;
// Pixel whose UV equals the requested sample point; the vertex UVs below are
// offset by half a pixel so this fragment sits exactly on the point.
export const PROBE_READ_PIXEL = 3;

export const PROBE_VERT = `#version 300 es
precision highp float;
uniform vec2 uPointUv;
uniform vec2 uPointDuvdx;
uniform vec2 uPointDuvdy;
out vec2 vUv;
// Full-screen triangle; NDC (-1,-1)..(3,3) maps to pixel (0,0)..(2S,2S).
// UV is affinely placed so the fragment at PROBE_READ_PIXEL has uPointUv.
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  // p = {0,1,2}; gl_Position = 2p-1 puts the vertices at screen pixel
  // p * PROBE_TARGET_SIZE, so UV can be placed in true device-pixel units.
  vec2 cornerPx = p * float(${PROBE_TARGET_SIZE});
  vec2 anchor = vec2(float(${PROBE_READ_PIXEL}) + 0.5);
  vec2 offsetPx = cornerPx - anchor;
  vUv = uPointUv + uPointDuvdx * offsetPx.x + uPointDuvdy * offsetPx.y;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const PROBE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uFlow;
uniform int uFilterMode;
uniform float uTextureScale;
uniform int uBaseSize;
uniform int uLevelCount;
uniform float uMipBias;
uniform float uAnisoMax;

in vec2 vUv;

layout(location = 0) out vec4 outA; // albedo.rgb (encoded sample), a = selected LOD
layout(location = 1) out vec4 outN; // normal.rgb (encoded sample), a = footprint (texels)
layout(location = 2) out vec4 outF; // flow.rgb   (encoded sample), a = anisotropy ratio
${samplingGlsl()}
void main() {
  // Same derivative expression the cloth shader uses; because vUv is affine in
  // screen position these are exactly the caller-supplied derivatives.
  vec2 duvdx = dFdx(vUv);
  vec2 duvdy = dFdy(vUv);
  float lod, foot, aniso;
  float lodOther, footOther, anisoOther;
  outA = txSampleMap(uAlbedo, vUv, duvdx, duvdy, uFilterMode,
    uTextureScale, float(uBaseSize), uMipBias, uLevelCount, uAnisoMax, lod, foot, aniso);
  outA.a = lod;
  outN = txSampleMap(uNormal, vUv, duvdx, duvdy, uFilterMode,
    uTextureScale, float(uBaseSize), uMipBias, uLevelCount, uAnisoMax,
    lodOther, footOther, anisoOther);
  outN.a = foot;
  outF = txSampleMap(uFlow, vUv, duvdx, duvdy, uFilterMode,
    uTextureScale, float(uBaseSize), uMipBias, uLevelCount, uAnisoMax,
    lodOther, footOther, anisoOther);
  outF.a = aniso;
}`;
