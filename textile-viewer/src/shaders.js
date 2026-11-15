// GLSL ES 3.00 shaders. The fragment shader treats each texture family with its
// own sampling semantics: sRGB albedo is decoded, vector maps are decoded in
// linear space, and the yarn direction is rotated from texture tangent space
// into world space before lighting.
//
// Coordinate construction, footprint estimation and the LOD/anisotropy filter
// decision are NOT written here; they are emitted from ./sampling-spec.js so
// the real shader and the CPU reference share one definition.

import { samplingGlsl } from './sampling-spec.js';

export const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aTangent;
layout(location=3) in vec2 aUV;

uniform mat4 uViewProj;
uniform mat4 uModel;

out vec3 vWorldPos;
out vec3 vNormal;
out vec4 vTangent;
out vec2 vUV;
// Screen-space UV derivatives are computed in the fragment shader; we also pass
// the world position for the anisotropic footprint estimate.
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  mat3 model3 = mat3(uModel);
  vNormal = normalize(model3 * aNormal);
  vTangent = vec4(normalize(model3 * aTangent.xyz), aTangent.w);
  vUV = aUV;
  gl_Position = uViewProj * world;
}`;

export const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uFlow;
uniform vec3 uCameraPos;
uniform vec3 uLightDir;
uniform int uFilterMode;   // 0 = explicit LOD chain, 1 = hardware mip, 2 = anisotropic (if available), 3 = point (diagnostic)
uniform float uTextureScale; // repeat scale multiplier from the UI
uniform float uMipBias;
uniform int uBaseSize;
uniform int uLevelCount;
uniform float uAnisoMax;   // device capability, 1.0 if unsupported
uniform int uPass;         // 0 = color to screen, 1 = telemetry to debug target

in vec3 vWorldPos;
in vec3 vNormal;
in vec4 vTangent;
in vec2 vUV;

layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragDebug; // r = selected LOD (normalized), g = footprint in texels, b = aniso factor, a = mode

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
${samplingGlsl()}
void main() {
  vec2 duvdx = dFdx(vUV);
  vec2 duvdy = dFdy(vUV);

  // The footprint / LOD / anisotropy reported by the telemetry pass is the
  // exact decision used to sample the albedo map, for all texture families.
  float lod, footMax, aniso;
  vec4 albEnc = txSampleMap(uAlbedo, vUV, duvdx, duvdy, uFilterMode,
    uTextureScale, float(uBaseSize), uMipBias, uLevelCount, uAnisoMax,
    lod, footMax, aniso);
  float lodN, footN, anisoN;
  vec4 nrmEnc = txSampleMap(uNormal, vUV, duvdx, duvdy, uFilterMode,
    uTextureScale, float(uBaseSize), uMipBias, uLevelCount, uAnisoMax,
    lodN, footN, anisoN);
  vec4 flowEnc = txSampleMap(uFlow, vUV, duvdx, duvdy, uFilterMode,
    uTextureScale, float(uBaseSize), uMipBias, uLevelCount, uAnisoMax,
    lodN, footN, anisoN);

  // Correct per-family decode.
  vec3 albedo = srgbToLinear(albEnc.rgb);
  vec3 tsNormal = nrmEnc.rgb * 2.0 - 1.0;
  vec2 tsFlow = flowEnc.rg * 2.0 - 1.0;
  float roughness = nrmEnc.a;
  float anisotropy = flowEnc.a;

  // Build the world tangent frame from the deformed mesh.
  vec3 T = normalize(vTangent.xyz);
  vec3 N = normalize(vNormal);
  T = normalize(T - dot(T, N) * N);
  vec3 B = cross(N, T) * vTangent.w;

  // Tangent-space normal perturb (re-normalized; averaging happened at build time).
  vec3 Nw = normalize(mat3(T, B, N) * normalize(tsNormal));

  // Rotate the yarn direction into world space. Because it goes through the
  // mesh's tangent frame, a mirrored UV fold rotates it symmetrically instead
  // of flipping the specular highlight.
  vec3 flowW = normalize(mat3(T, B, N) * vec3(tsFlow, 0.0));

  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 L = normalize(uLightDir);
  vec3 H = normalize(L + V);

  float ndl = max(dot(Nw, L), 0.0);
  float ndh = max(dot(Nw, H), 0.0);
  // Anisotropic GGX-ish lobe stretched along the yarn direction.
  float along = dot(H, flowW);
  float ax = max(roughness * mix(1.0, 0.35, anisotropy), 0.04);
  float ay = max(roughness, 0.04);
  float spec = exp(-2.0 * (pow(along / ax, 2.0) + pow((ndh * ndh - along * along) / max(ay * ay, 1e-4), 1.0)))
             * pow(ndh, 32.0) * 0.6;

  vec3 color = albedo * (0.25 + 0.85 * ndl);
  color += vec3(1.0, 0.97, 0.92) * spec * ndl;
  // Rim to make curved silhouette readable.
  color += albedo * pow(1.0 - max(dot(Nw, V), 0.0), 3.0) * 0.15;

  fragColor = vec4(linearToSrgb(color), 1.0);
  fragDebug = vec4(lod / max(float(uLevelCount) - 1.0, 1.0),
                   clamp(log2(max(footMax, 1.0)) / 10.0, 0.0, 1.0),
                   aniso / 16.0,
                   float(uFilterMode) / 3.0);
  if (uPass == 1) {
    // Telemetry pass: route the metrics through color attachment 0.
    fragColor = fragDebug;
  }
}`;

// Flat overlay shader for reference/error visualizations (2D blit).
export const BLIT_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
out vec2 vUV;
void main() { vUV = aUV; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const BLIT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uTex;
uniform int uIsSrgb;
in vec2 vUV;
out vec4 outColor;
vec3 srgbToLinear(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c)); }
vec3 linearToSrgb(vec3 c){ c=max(c,vec3(0.0)); return mix(c*12.92, 1.055*pow(c,vec3(1.0/2.4))-0.055, step(0.0031308,c)); }
void main() {
  vec4 s = texture(uTex, vUV);
  outColor = uIsSrgb == 1 ? vec4(linearToSrgb(srgbToLinear(s.rgb)), s.a) : s;
}`;
