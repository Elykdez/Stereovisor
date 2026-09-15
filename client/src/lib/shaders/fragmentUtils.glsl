#version 300 es
precision highp float;
precision highp int;

// Shared fragment helpers: the web counterpart of FragmentUtils.cginc. GLSL ES
// has no preprocessor include of its own, so this file is spliced in by glsl.ts.

// The three lines above are scaffolding, there so this file compiles on its own
// and an editor can check it; glsl.ts drops them when splicing, because the
// including shader owns its version and precisions. A shader calling
// animationNoise therefore has to declare `precision highp int;` itself — the
// fragment default is mediump, which is not wide enough for the mixing below.

// Port of Rand() in FragmentUtils.cginc. maskMosaic.ts carries a TS twin of this,
// used where the CPU has to agree with the shader on a cell; change one and the other has to follow.
float rand(vec2 uv) {
  return fract(sin(dot(uv, vec2(12.9898f, 78.233f))) * 43758.5453f);
}

// The 1D form, for whole numbers such as a cycle index or a row.
float hash(float value) {
  return fract(sin(value * 127.1f + 311.7f) * 43758.5453f);
}

// Keep time separate from position; translating sine noise creates moving bands.
// Hashing cell, tick and stream independently means an animation steps
// to a fresh field each tick instead of sliding the previous one across the image.
// stream separates uses that share a cell and a tick.
float animationNoise(vec2 cell, float tick, uint stream) {
  uvec2 position = uvec2(cell);
  uint value = position.x * 1973u ^ position.y * 9277u ^ uint(tick) * 26699u ^ stream * 31847u;
  value = (value ^ (value >> 16u)) * 0x7feb352du;
  value = (value ^ (value >> 15u)) * 0x846ca68bu;
  value ^= value >> 16u;
  return float(value >> 8u) / 16777216.0f;
}

// Port of HSVtoRGB() in FragmentUtils.cginc.
vec3 hsvToRgb(vec3 hsv) {
  vec3 rgb = clamp(abs(mod(hsv.x * 6.0f + vec3(0.0f, 4.0f, 2.0f), 6.0f) - 3.0f) - 1.0f, 0.0f, 1.0f);
  rgb = rgb * rgb * (3.0f - 2.0f * rgb);
  return hsv.z * mix(vec3(1.0f), rgb, hsv.y);
}

// Source-over with both sides premultiplied, so overlapping marks stack rather
// than replace each other and the result blends as-is against the frame below.
vec4 srcOver(vec4 under, vec4 src) {
  return src + under * (1.0f - src.a);
}

// The same, for a straight colour and coverage that have yet to be premultiplied.
vec4 srcOver(vec4 under, vec3 color, float alpha) {
  alpha = clamp(alpha, 0.0f, 1.0f);
  return vec4(color * alpha, alpha) + under * (1.0f - alpha);
}
