#version 300 es
precision highp float;
// The fragment default for int is mediump, too narrow for the 32-bit mixing in
// animationNoise below.
precision highp int;

// Shared helpers, defined in fragmentUtils.glsl and spliced in by glsl.ts.
// GLSL ES has no #include, so the directive is written as a comment that only
// the composer reads; these prototypes are what the compiler and the editor's
// validator resolve the calls against.
float hash(float value);
float animationNoise(vec2 cell, float tick, uint stream);
vec4 srcOver(vec4 under, vec4 src);
vec4 srcOver(vec4 under, vec3 color, float alpha);
//#include "fragmentUtils.glsl"

// Glitch pass for an inpainting layer's cutout. It draws on top of the
// untouched subject, so everything here is an addition: outside a burst the
// shader returns transparent black and the layer renders as it normally would.
// Driven from foreground, which uploads the cutout and derives uSeed
// from the layer id, so each layer glitches on its own schedule.
uniform sampler2D uCutout;
uniform vec2 uResolution;
uniform float uTime;
uniform float uSeed;
in vec2 vUv;
out vec4 outColor;

vec4 cutout(vec2 uv) {
  // CLAMP_TO_EDGE alone would smear an edge-touching subject into its echoes.
  if(any(lessThan(uv, vec2(0.0f))) || any(greaterThan(uv, vec2(1.0f))))
    return vec4(0.0f);
  return texture(uCutout, uv);
}

// A displaced copy of the cutout with the channels pulled apart horizontally.
vec4 echo(vec2 offset, float split) {
  vec2 uv = vUv - offset;
  vec4 red = cutout(uv + vec2(split, 0.0f));
  vec4 green = cutout(uv);
  vec4 blue = cutout(uv - vec2(split, 0.0f));
  float alpha = max(red.a, max(green.a, blue.a));

  // Premultiply each channel by its own shifted silhouette, including soft edges.
  vec3 channels = vec3(red.r, green.g, blue.b);
  vec3 coverage = vec3(red.a, green.a, blue.a);
  float overlap = min(red.a, min(green.a, blue.a));

  // Saturate only the separated fringe, keeping overlapping image detail intact.
  vec3 fringe = (coverage - overlap) / max(alpha - overlap, 0.001f);
  float separation = smoothstep(0.02f, 0.22f, alpha - overlap);
  vec3 color = mix(channels * coverage, fringe * alpha, separation * 0.85f);
  return vec4(color, alpha);
}

void main() {

  // Each layer briefly flickers twice, then returns to its untouched appearance.
  // The seed offsets the 6.2s cycle so layers never fire in unison, and picks a
  // fresh start time within every cycle.
  float clock = uTime + uSeed * 6.2f;
  float cycle = floor(clock / 6.2f);
  float start = 1.0f + hash(cycle + uSeed * 17.0f) * 4.2f;
  float age = mod(clock, 6.2f) - start;
  float firstFlash = smoothstep(0.0f, 0.02f, age) * (1.0f - smoothstep(0.04f, 0.08f, age));
  float secondFlash = smoothstep(0.13f, 0.15f, age) * (1.0f - smoothstep(0.24f, 0.34f, age));

  // One envelope for the whole effect: a short weak stutter, then the real hit.
  float burst = max(firstFlash * 0.55f, secondFlash);
  if(burst <= 0.0f) {
    outColor = vec4(0.0f);
    return;
  }

  vec2 pixel = 1.0f / uResolution;
  vec4 source = cutout(vUv);

  // Quantised clock: the tear and grain hold for a frame instead of crawling.
  float tick = floor(uTime * 14.0f);

  // A handful of 8px rows per tick tear sideways; the rest keep band below 0.9.
  float band = hash(floor(vUv.y * uResolution.y / 8.0f) + tick + uSeed);
  float tear = step(0.9f, band) * (band - 0.5f) * 0.8f;
  float scan = 0.5f + 0.5f * sin((vUv.y * uResolution.y - uTime * 9.0f) * 1.57f);

  // Alpha drop against the four neighbours marks the silhouette outline, which
  // takes an extra lift so the subject keeps a readable edge during the burst.
  float neighbor = min(min(cutout(vUv + vec2(pixel.x, 0.0f)).a, cutout(vUv - vec2(pixel.x, 0.0f)).a), min(cutout(vUv + vec2(0.0f, pixel.y)).a, cutout(vUv - vec2(0.0f, pixel.y)).a));
  float rim = max(0.0f, source.a - neighbor);
  vec3 neon = mix(vec3(0.05f, 0.95f, 1.0f), vec3(1.0f, 0.12f, 0.65f), 0.5f + 0.5f * sin(vUv.y * 8.0f + uSeed));

  // Corrupted scan bands contain blocky displaced pixels and short dark dropouts.
  vec2 block = floor(vUv * uResolution / vec2(32.0f, 3.0f));
  float corruption = hash(block.x + block.y * 41.0f + tick + uSeed * 97.0f);
  float damaged = step(0.9f, band) * step(0.72f, corruption);
  vec2 brokenUv = (floor((vUv - vec2(tear * pixel.x, 0.0f)) * uResolution / 2.0f) + 0.5f) * 2.0f * pixel;
  vec3 broken = mix(cutout(brokenUv).rgb * neon, vec3(0.01f, 0.025f, 0.04f), step(0.9f, corruption));

  // Clamped to the source alpha so the tint can never spill past the silhouette.
  float tintAlpha = min(source.a, source.a * (0.022f + scan * 0.04f + damaged * 0.24f) + rim * 0.14f) * burst;
  vec4 tint = vec4(mix(neon, broken, damaged) * tintAlpha, tintAlpha);

  // Two ghosts on opposite sides, drifting further apart as the burst ages.
  float direction = hash(cycle + uSeed * 31.0f) < 0.5f ? -1.0f : 1.0f;
  vec2 offset = vec2(direction * (0.55f + age * 0.6f) + tear, -0.15f) * pixel;
  float split = (0.25f + burst * 0.35f) * pixel.x;
  vec4 nearGhost = echo(offset, split) * (burst * 0.5f);
  vec4 farGhost = echo(-offset, split) * (burst * 0.14f);
  vec4 ghosts = srcOver(farGhost, nearGhost);
  vec4 effect = srcOver(ghosts, tint);

  // Sparse pixel-sized static follows the same burst and stays inside the
  // cutout. The integer hash rather than sin noise: neighbouring pixels must
  // not correlate, or the speckles line up into visible diagonal ridges. The
  // per-pixel cell is the grain's own grid, and the layer seed is its stream.
  float grain = animationNoise(vUv * uResolution, tick, uint(uSeed * 1009.0f));
  float brightSpeck = step(0.96f, grain);
  float darkSpeck = 1.0f - step(0.035f, grain);
  float noiseAlpha = (brightSpeck * 0.28f + darkSpeck * 0.22f) * source.a * burst;
  vec3 noiseColor = mix(vec3(0.86f, 0.9f, 0.94f), neon, step(0.992f, grain) * 0.65f);
  noiseColor = mix(noiseColor, vec3(0.015f, 0.02f, 0.03f), darkSpeck);

  // Static on top, everything else behind it.
  outColor = srcOver(effect, noiseColor, noiseAlpha);
}
