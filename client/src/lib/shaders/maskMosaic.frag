#version 300 es

// Uniforms map one to one onto the shader's properties, so _MosaicSize is uSize
// and the remaining uniforms map to the corresponding effect settings.
// Driven from maskMosaicGl.ts, which owns the textures and the uniform values.
precision highp float;
precision highp int;

// Shared helpers, defined in fragmentUtils.glsl and spliced in by glsl.ts.
// GLSL ES has no #include, so the directive is written as a comment that only
// the composer reads; these prototypes are what the compiler and the editor's
// validator resolve the calls against.
float rand(vec2 uv);
float animationNoise(vec2 cell, float tick, uint stream);
vec3 hsvToRgb(vec3 hsv);
//#include "fragmentUtils.glsl"

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uMask;
uniform sampler2D uPlate;
uniform vec2 uMaskSize;
uniform vec2 uPlateSize;
uniform float uHasPlate;
uniform float uAspect;
uniform float uTime;

// Cell geometry (_MosaicSize, _MosaicAspect, _MosaicStretch).
uniform float uSize;
uniform float uShapeAspect;
uniform vec2 uStretch;
uniform vec2 uVariation;

// Appearance.
uniform float uAlpha;
uniform vec3 uTint;
uniform float uTintAmount;
uniform float uBrightness;
uniform float uDropout;
uniform float uGrain;
uniform float uTwinkleStrength;
uniform float uTwinkleSpeed;
uniform float uTwinkleDensity;
uniform float uTwinkleJitter;
uniform float uChromatic;
uniform float uGlitch;
uniform float uSweepStrength;
uniform float uSweepSpeed;
uniform float uSweepWidth;

// Covered area of the mask in UV (minU, minV, maxU, maxV), 
// so the sweep crosses the painted region rather than the whole composition.
uniform vec4 uBounds;

// Port of mosaicCells(). The display aspect comes from a uniform rather than
// _ScreenParams so the grid never wobbles within the quad.
void mosaicCells(vec2 uv, out vec2 cell, out vec2 cellCount, out vec2 pixelUV) {
  float t = clamp(uShapeAspect, 0.0f, 1.0f);
  vec2 n = max(vec2(uSize * uAspect / mix(uAspect, 1.0f, clamp(2.0f * t - 1.0f, 0.0f, 1.0f)), uSize / mix(uAspect, 1.0f, clamp(2.0f * t, 0.0f, 1.0f))), 1.0f);

  vec2 stretch = max(uStretch, vec2(1.0f));
  vec2 variation = clamp(uVariation, 0.0f, 1.0f);
  vec2 variationCell = floor(uv * n);
  if(variation.x > 0.0f && stretch.x > 1.0f) {
    float rowNoise = rand(vec2(variationCell.y, 43.17f));
    stretch.x = mix(stretch.x, mix(1.0f, stretch.x, rowNoise), variation.x);
  }
  if(variation.y > 0.0f && stretch.y > 1.0f) {
    float columnNoise = rand(vec2(variationCell.x, 87.31f));
    stretch.y = mix(stretch.y, mix(1.0f, stretch.y, columnNoise), variation.y);
  }
  n = max(n / stretch, vec2(1.0f));

  vec2 cellUV = 1.0f / n;
  cellCount = max(floor(n), vec2(1.0f));
  // Centre the leftover when the counts do not divide the axis evenly.
  vec2 margin = (1.0f - cellCount * cellUV) * 0.5f;

  cell = clamp(floor((uv - margin) / cellUV), vec2(0.0f), cellCount - 1.0f);
  pixelUV = clamp((cell + 0.5f) * cellUV + margin, 0.0f, 1.0f);
}

void main() {
  vec2 cell, cellCount, pixelUV;
  mosaicCells(vUv, cell, cellCount, pixelUV);

  // One mip read per cell replaces a coverage accumulation loop: the LOD is the
  // cell's own footprint in mask texels, so this is its area average.
  float maskLod = max(log2(uMaskSize.x / max(cellCount.x, 1.0f)), 0.0f);
  float coverage = textureLod(uMask, pixelUV, maskLod).a;
  // A cell has to hold a real share of the pending area before it lights up.
  // The filtered read above spreads coverage about a cell past the mask, which
  // at the coarse end of the resolve would halo across most of the frame.
  float alpha = uAlpha * smoothstep(0.18f, 0.62f, coverage);
  if(alpha <= 0.0f) {
    fragColor = vec4(0.0f);
    return;
  }

  // Dropout punches holes rather than painting black blocks: on an overlay
  // the plate showing through reads as a missing shard.
  if(uDropout > 0.0f && rand(vec2(cell.x * 5.31f + 17.23f, cell.y * 5.31f + 91.7f)) > 1.0f - uDropout) {
    alpha *= 0.14f;
  }

  vec2 offset = vec2(0.0f);
  float twinkle = 0.0f;
  if(uTwinkleStrength > 0.0f && uTwinkleDensity > 0.0f) {
    float seed = animationNoise(cell, 0.0f, 0u);
    float clock = uTime * uTwinkleSpeed + seed * 37.0f;
    float tick = floor(clock);
    float phase = clock - tick;
    float gate = animationNoise(cell, tick, 1u) >= 1.0f - uTwinkleDensity ? 1.0f : 0.0f;
    twinkle = gate * smoothstep(0.0f, 0.18f, phase) * (1.0f - smoothstep(0.45f, 1.0f, phase));
    if(twinkle > 0.0f) {
      float jitterScale = uTwinkleJitter / max(cellCount.x, 1.0f);
      offset.x += (animationNoise(cell, tick, 2u) - 0.5f) * twinkle * jitterScale;
      offset.y += (animationNoise(cell, tick, 3u) - 0.5f) * twinkle * jitterScale;
    }
  }

  float grainTick = floor(uTime * 12.0f);
  float glitchTick = floor(uTime * 8.0f);
  // Scanline tearing: a few cell rows slide sideways for one time step.
  if(uGlitch > 0.0f && animationNoise(vec2(0.0f, cell.y), glitchTick, 4u) > 0.94f) {
    offset.x += (animationNoise(vec2(0.0f, cell.y), glitchTick, 5u) - 0.5f) * uGlitch;
  }

  vec2 sampleUV = pixelUV + offset;
  vec3 base;
  if(uHasPlate > 0.5f) {
    float plateLod = max(log2(uPlateSize.x / max(cellCount.x, 1.0f)), 0.0f);
    float chromatic = uChromatic / max(cellCount.x, 1.0f);
    base = vec3(textureLod(uPlate, sampleUV + vec2(chromatic, 0.0f), plateLod).r, textureLod(uPlate, sampleUV, plateLod).g, textureLod(uPlate, sampleUV - vec2(chromatic, 0.0f), plateLod).b);
  } else {
    // No plate to sample: light the tint per cell instead, otherwise the
    // field collapses into one flat blob and the cells stop reading.
    base = uTint * (0.5f + rand(cell * 3.7f) * 0.55f);
  }

  if(uGrain > 0.0f) {
    base += (animationNoise(cell, grainTick, 6u) - 0.5f) * 2.0f * uGrain;
  }
  if(twinkle > 0.0f) {
    base += (animationNoise(cell, grainTick, 7u) - 0.5f) * 2.0f * uTwinkleStrength * twinkle;
  }

  vec3 color = mix(base, uTint, uTintAmount) * uBrightness;

  if(uSweepStrength > 0.0f) {
    // The shader's line pass. The metric is taken at the cell's sample point so
    // the wavefront lights whole cells instead of cutting through them.
    vec2 span = max(uBounds.zw - uBounds.xy, vec2(1e-5f));
    vec2 metricUV = (pixelUV - uBounds.xy) / span;
    float shatter = (rand(cell * 13.13f + vec2(71.17f, 19.31f)) - 0.5f) * 0.12f;
    float metric = clamp((metricUV.x + metricUV.y) * 0.5f + shatter, 0.0f, 1.0f);
    float line = 1.0f - smoothstep(uSweepWidth * 0.5f, uSweepWidth, abs(metric - fract(uTime * uSweepSpeed)));
    if(line > 0.0f) {
      vec2 centre = (uBounds.xy + uBounds.zw) * 0.5f;
      float angle = atan(pixelUV.y - centre.y, pixelUV.x - centre.x) / 6.2831853f;
      vec3 lineColor = hsvToRgb(vec3(fract(metric * 0.3f + angle * 0.12f + uTime * 0.12f), 0.8f, 1.0f));
      float amount = line * uSweepStrength;
      color = mix(color, lineColor, amount);
      alpha = min(1.0f, alpha + amount * 0.25f * uAlpha);
    }
  }

  fragColor = vec4(clamp(color, 0.0f, 1.0f), clamp(alpha, 0.0f, 1.0f));
}
