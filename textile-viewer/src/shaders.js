// GLSL ES 3.00 shaders. The fragment shader treats each texture family with its
// own sampling semantics: sRGB albedo is decoded, vector maps are decoded in
// linear space, and the yarn direction is rotated from texture tangent space
// into world space before lighting.

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

// Footprint: UV derivative lengths mapped into base-level texel units.
vec2 footprintTexels(vec2 uv, float scale) {
  vec2 dudx = dFdx(uv) * scale * float(uBaseSize);
  vec2 dudy = dFdy(uv) * scale * float(uBaseSize);
  return vec2(length(dudx), length(dudy));
}

// Triangular-weight elliptical filter over the explicit chain: average two
// nearest LODs with the fractional part, matching trilinear semantics while
// letting us report the exact level used.
vec4 sampleChain(sampler2D s, vec2 uv, float lod, float scale) {
  vec2 st = fract(uv * scale);
  float l0 = floor(lod);
  float f = lod - l0;
  vec4 a = textureLod(s, st, l0);
  vec4 b = textureLod(s, st, min(l0 + 1.0, float(uLevelCount) - 1.0));
  return mix(a, b, f);
}

void main() {
  vec2 foot = footprintTexels(vUV, uTextureScale);
  float footMax = max(foot.x, foot.y);
  float footMin = min(foot.x, foot.y);

  // Screen-coverage LOD: log2 of the texel footprint. This is the same rule the
  // JS selectLod() uses for the HUD, so displayed level matches sampled level.
  float lod = clamp(log2(max(footMax, 1.0)) + uMipBias, 0.0, float(uLevelCount) - 1.0);
  float aniso = clamp(footMax / max(footMin, 1e-4), 1.0, max(uAnisoMax, 1.0));

  vec4 albEnc, nrmEnc, flowEnc;
  if (uFilterMode == 3) {
    // Diagnostic: single base-level point sample, no filtering. Aliasing visible.
    vec2 st = fract(vUV * uTextureScale);
    ivec2 ipx = ivec2(st * float(uBaseSize));
    ipx = ivec2(clamp(ipx, ivec2(0), ivec2(uBaseSize - 1)));
    albEnc = texelFetch(uAlbedo, ipx, 0);
    nrmEnc = texelFetch(uNormal, ipx, 0);
    flowEnc = texelFetch(uFlow, ipx, 0);
  } else if (uFilterMode == 1) {
    // Hardware trilinear; GL computes the LOD internally from derivatives.
    vec2 st = fract(vUV * uTextureScale);
    albEnc = texture(uAlbedo, st);
    nrmEnc = texture(uNormal, st);
    flowEnc = texture(uFlow, st);
  } else {
    // Mode 0: explicit chain. Mode 2: same chain with anisotropic widening of
    // the minor-axis footprint (emulated with extra taps when hardware aniso
    // extension is absent; capped so cost stays bounded).
    albEnc = sampleChain(uAlbedo, vUV, lod, uTextureScale);
    nrmEnc = sampleChain(uNormal, vUV, lod, uTextureScale);
    flowEnc = sampleChain(uFlow, vUV, lod, uTextureScale);
    if (uFilterMode == 2 && uAnisoMax <= 1.0 && aniso > 1.5) {
      // Emulated anisotropic filter: spread extra taps along the MAJOR footprint
      // axis (the derivative with the larger extent), while keeping the minor
      // axis at its own LOD. This averages several narrow footprints instead of
      // one blurry isotropic one, preserving detail at grazing angles.
      vec2 gradX = dFdx(vUV);
      vec2 gradY = dFdy(vUV);
      vec2 major = length(gradX) >= length(gradY) ? gradX : gradY;
      vec2 duv = major * 0.5;
      float taps = 3.0;
      for (int i = -1; i <= 1; i++) {
        vec2 uv2 = vUV + duv * float(i);
        albEnc += sampleChain(uAlbedo, uv2, lod, uTextureScale);
        nrmEnc += sampleChain(uNormal, uv2, lod, uTextureScale);
        flowEnc += sampleChain(uFlow, uv2, lod, uTextureScale);
      }
      albEnc /= taps; nrmEnc /= taps; flowEnc /= taps;
    }
  }

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
