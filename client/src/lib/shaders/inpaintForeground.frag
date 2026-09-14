#version 300 es
precision highp float;

uniform sampler2D uCutout;
uniform vec2 uResolution;
uniform float uTime;
uniform float uSeed;
in vec2 vUv;
out vec4 outColor;

float hash(float value) {
  return fract(sin(value * 127.1 + 311.7) * 43758.5453);
}

vec4 cutout(vec2 uv) {
  // CLAMP_TO_EDGE alone would smear an edge-touching subject into its echoes.
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return texture(uCutout, uv);
}

vec4 echo(vec2 offset, float split) {
  vec2 uv = vUv - offset;
  vec4 red = cutout(uv + vec2(split, 0.0));
  vec4 green = cutout(uv);
  vec4 blue = cutout(uv - vec2(split, 0.0));
  float alpha = max(red.a, max(green.a, blue.a));
  // Premultiply each channel by its own shifted silhouette, including soft edges.
  vec3 channels = vec3(red.r, green.g, blue.b);
  vec3 coverage = vec3(red.a, green.a, blue.a);
  float shared = min(red.a, min(green.a, blue.a));
  // Saturate only the separated fringe, keeping overlapping image detail intact.
  vec3 fringe = (coverage - shared) / max(alpha - shared, 0.001);
  float separation = smoothstep(0.02, 0.22, alpha - shared);
  vec3 color = mix(channels * coverage, fringe * alpha, separation * 0.85);
  return vec4(color, alpha);
}

void main() {
  // Each layer briefly flickers twice, then returns to its untouched appearance.
  float clock = uTime + uSeed * 6.2;
  float cycle = floor(clock / 6.2);
  float start = 1.0 + hash(cycle + uSeed * 17.0) * 4.2;
  float age = mod(clock, 6.2) - start;
  float firstFlash = smoothstep(0.0, 0.02, age) * (1.0 - smoothstep(0.04, 0.08, age));
  float secondFlash = smoothstep(0.13, 0.15, age) * (1.0 - smoothstep(0.24, 0.34, age));
  float burst = max(firstFlash * 0.55, secondFlash);
  if (burst <= 0.0) {
    outColor = vec4(0.0);
    return;
  }

  vec2 pixel = 1.0 / uResolution;
  vec4 source = cutout(vUv);
  float tick = floor(uTime * 14.0);
  float band = hash(floor(vUv.y * uResolution.y / 8.0) + tick + uSeed);
  float tear = step(0.9, band) * (band - 0.5) * 0.8;
  float scan = 0.5 + 0.5 * sin((vUv.y * uResolution.y - uTime * 9.0) * 1.57);
  float neighbor = min(min(cutout(vUv + vec2(pixel.x, 0.0)).a,
                           cutout(vUv - vec2(pixel.x, 0.0)).a),
                       min(cutout(vUv + vec2(0.0, pixel.y)).a,
                           cutout(vUv - vec2(0.0, pixel.y)).a));
  float rim = max(0.0, source.a - neighbor);
  vec3 neon = mix(vec3(0.05, 0.95, 1.0), vec3(1.0, 0.12, 0.65),
                  0.5 + 0.5 * sin(vUv.y * 8.0 + uSeed));
  // Corrupted scan bands contain blocky displaced pixels and short dark dropouts.
  vec2 block = floor(vUv * uResolution / vec2(32.0, 3.0));
  float corruption = hash(block.x + block.y * 41.0 + tick + uSeed * 97.0);
  float damaged = step(0.9, band) * step(0.72, corruption);
  vec2 brokenUv = (floor((vUv - vec2(tear * pixel.x, 0.0)) * uResolution / 2.0) + 0.5) * 2.0 * pixel;
  vec3 broken = mix(cutout(brokenUv).rgb * neon, vec3(0.01, 0.025, 0.04), step(0.9, corruption));
  float tintAlpha = min(source.a, source.a * (0.022 + scan * 0.04 + damaged * 0.24) + rim * 0.14) * burst;
  vec4 tint = vec4(mix(neon, broken, damaged) * tintAlpha, tintAlpha);

  float direction = hash(cycle + uSeed * 31.0) < 0.5 ? -1.0 : 1.0;
  vec2 offset = vec2(direction * (0.55 + age * 0.6) + tear, -0.15) * pixel;
  float split = (0.25 + burst * 0.35) * pixel.x;
  vec4 nearGhost = echo(offset, split) * (burst * 0.5);
  vec4 farGhost = echo(-offset, split) * (burst * 0.14);
  vec4 ghosts = nearGhost + farGhost * (1.0 - nearGhost.a);
  vec4 effect = tint + ghosts * (1.0 - tint.a);

  // Sparse pixel-sized static follows the same burst and stays inside the cutout.
  uvec2 grainCell = uvec2(vUv * uResolution);
  uint noiseSeed = grainCell.x * 1973u + grainCell.y * 9277u + uint(tick) * 26699u + uint(uSeed * 1009.0) * 31847u;
  noiseSeed = (noiseSeed ^ (noiseSeed >> 16u)) * 0x7feb352du;
  noiseSeed = (noiseSeed ^ (noiseSeed >> 15u)) * 0x846ca68bu;
  noiseSeed ^= noiseSeed >> 16u;
  float grain = float(noiseSeed & 0x00ffffffu) / 16777216.0;
  float brightSpeck = step(0.96, grain);
  float darkSpeck = 1.0 - step(0.035, grain);
  float noiseAlpha = (brightSpeck * 0.28 + darkSpeck * 0.22) * source.a * burst;
  vec3 noiseColor = mix(vec3(0.86, 0.9, 0.94), neon, step(0.992, grain) * 0.65);
  noiseColor = mix(noiseColor, vec3(0.015, 0.02, 0.03), darkSpeck);
  outColor = vec4(noiseColor * noiseAlpha, noiseAlpha) + effect * (1.0 - noiseAlpha);
}
