/**
 * Adapted from better-lyrics/kawarp, commit bb914faf44a394c8b05896b31b21edbb369b5596.
 * Copyright (c) 2026 Better Lyrics. MIT license, see THIRD_PARTY_LICENSES/Kawarp-LICENSE.
 * GLSL becomes SkSL, with fused warp/output, native crossfading and a readability scrim.
 */
export const KAWARP_TEXTURE_SIZE = 128;
export const KAWARP_BLUR_PASSES = 8;
export const KAWARP_FRAME_MS = 1000 / 30;
export const KAWARP_TRANSITION_MS = 1200;

/** Bound physical shader pixels independently of screen size and display density. */
export function kawarpRenderSize(width: number, height: number, pixelRatio: number) {
  const density = Math.max(1, pixelRatio);
  const maxPoints = Math.max(1, Math.floor(720 / density));
  const scale = Math.min(1, maxPoints / Math.max(1, width, height));
  // Skia's iOS Metal provider truncates layout dimensions to integer points.
  const renderWidth = Math.min(maxPoints, Math.ceil(width * scale));
  const renderHeight = Math.min(maxPoints, Math.ceil(height * scale));
  // Keep the scaled surface's filtered edge one source pixel outside the viewport.
  const bleed = 1 / (scale * density);
  return {
    width: renderWidth,
    height: renderHeight,
    scale: Math.max((width + 2 * bleed) / renderWidth, (height + 2 * bleed) / renderHeight),
    bleed,
  };
}

export const KAWARP_TINT_SHADER = `
uniform shader artwork;
half4 main(float2 p) {
  half4 color = artwork.eval(p);
  float luma = dot(color.rgb, float3(0.299, 0.587, 0.114));
  float darkMask = 1.0 - smoothstep(0.0, 0.5, luma);
  return half4(mix(color.rgb, half3(0.16, 0.16, 0.24), darkMask * 0.15), 1.0);
}`;

export const KAWARP_BLUR_SHADER = `
uniform shader artwork;
uniform float offset;
half4 main(float2 p) {
  return 0.25 * (
    artwork.eval(p + float2(-offset, -offset)) +
    artwork.eval(p + float2( offset, -offset)) +
    artwork.eval(p + float2(-offset,  offset)) +
    artwork.eval(p + float2( offset,  offset))
  );
}`;

export const KAWARP_WARP_SHADER = `
uniform shader previous;
uniform shader current;
uniform float2 resolution;
uniform float time;
uniform float blend;

float3 mod289(float3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float2 mod289(float2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float3 permute(float3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(float2 v) {
  const float4 C = float4(0.211324865405187, 0.366025403784439,
                         -0.577350269189626, 0.024390243902439);
  float2 i = floor(v + dot(v, C.yy));
  float2 x0 = v - i + dot(i, C.xx);
  float2 i1 = x0.x > x0.y ? float2(1.0, 0.0) : float2(0.0, 1.0);
  float4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  float3 p = permute(permute(i.y + float3(0.0, i1.y, 1.0)) + i.x + float3(0.0, i1.x, 1.0));
  float3 m = max(0.5 - float3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  float3 x = 2.0 * fract(p * C.www) - 1.0;
  float3 h = abs(x) - 0.5;
  float3 ox = floor(x + 0.5);
  float3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  float3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float hash(float3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

half4 main(float2 p) {
  float2 uv = p / resolution;
  float t = time * 0.08;
  float2 center = uv - 0.5;
  float centerWeight = 1.0 - smoothstep(0.0, 0.7, length(center));
  float n1 = snoise(uv * 0.35 + float2(t, t * 0.7));
  float n2 = snoise(uv * 0.35 + float2(-t * 0.8, t * 0.5) + float2(50.0));
  float n3 = snoise(uv * 0.9 + float2(t * 1.2, -t) + float2(100.0, 0.0));
  float n4 = snoise(uv * 0.9 + float2(-t, t * 1.1) + float2(0.0, 100.0));
  float2 warp = float2(n1 * 0.65 + n3 * 0.35, n2 * 0.65 + n4 * 0.35) * centerWeight;
  float2 samplePos = clamp((uv + warp * 1.12) * 128.0, 0.5, 127.5);
  half3 color = mix(previous.eval(samplePos).rgb, current.eval(samplePos).rgb, blend);
  color *= 1.0 - dot(center, center) * 0.3;
  float gray = dot(color, float3(0.299, 0.587, 0.114));
  color = clamp(mix(half3(gray), color, 1.5), 0.0, 1.0);
  // Fixed grain avoids shimmer when motion stops. Darker controls, legible white lyrics.
  color += (hash(float3(floor(p), 0.0)) - 0.5) * 0.008;
  float visibility = 0.42 - 0.13 * smoothstep(0.45, 1.0, uv.y);
  return half4(mix(half3(0.031, 0.035, 0.055), color, visibility), 1.0);
}`;
