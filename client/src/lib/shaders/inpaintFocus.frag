#version 300 es
precision highp float;

// Shared helpers, defined in fragmentUtils.glsl and spliced in by glsl.ts.
// GLSL ES has no #include, so the directive is written as a comment that only
// the composer reads; this prototype is what the compiler and the editor's
// validator resolve the call against.
vec4 srcOver(vec4 under, vec3 color, float alpha);
//#include "fragmentUtils.glsl"

// Choose 1, 2, or 3 simultaneous boxes. Target selection and the Canvas
// fallback read this same setting; a small mask may fit fewer boxes.
#define FOCUS_BOX_COUNT 3

// Targeting overlay for the inpainting mosaic: a dot on every grid intersection
// plus a few boxes that travel in from the image edges and lock onto cells that
// are still pending. Driven from inpaintFocusGl.ts, which owns the uniforms;
// inpaintFocus.ts picks the boxes, advances their phase, and mirrors this
// drawing step for step in its Canvas fallback.
in vec2 vUv;
out vec4 fragColor;

// The program runs twice per frame: a POINTS pass for the grid dots, then a
// fullscreen triangle for the boxes. uDots selects which one this is.
uniform bool uDots;

// CSS pixels, so stroke widths stay put when the canvas is scaled for DPR.
uniform vec2 uResolution;

// One grid cell in UV. Guides enter from the neighbouring cell, not the box.
uniform vec2 uPitch;

// Box bounds in UV: xy is the top-left corner, zw the size.
uniform vec4 uTargets[3];

// Lifetime of each box in 0..1; a negative phase marks an unused lane.
uniform vec3 uPhases;

// Per-box randomness: picks the colour and shifts the timing.
uniform vec3 uSeeds;

// Premultiplied accumulator, and half the fragment footprint for antialiasing.
vec4 ink;
float aa;

// Every mark below composites into the one accumulator, so the shared blend is
// wrapped here rather than threaded through each of the drawing helpers.
void over(vec3 color, float alpha) {
  ink = srcOver(ink, color, alpha);
}

// Signed distance to alpha. Everything is drawn as a distance field so the
// hairlines survive the downscale the renderer applies on high-DPI screens.
float coverage(float distance) {
  return 1.0f - smoothstep(-aa, aa, distance);
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 delta = b - a;
  float along = clamp(dot(p - a, delta) / max(dot(delta, delta), 0.0001f), 0.0f, 1.0f);
  return length(p - a - along * delta);
}

float square(vec2 p, vec2 center, float size) {
  vec2 d = abs(p - center) - size * 0.5f;
  return coverage(max(d.x, d.y));
}

// One leg of a feeder line. head and tail are arc lengths measured along
// the whole two-leg path and offset is where this leg starts on it, so the streak
// can be clipped into the leg it currently crosses without knowing the elbow.
void guideSegment(vec2 p, vec2 a, vec2 b, float offset, float head, float tail, vec3 color, float alpha) {
  float extent = length(b - a);
  if(extent < 0.001f)
    return;

  // Faint trace of the whole route, so the path reads before the head arrives.
  over(color, coverage(segment(p, a, b) - 0.5f) * alpha * 0.12f);
  float start = max(tail, offset);
  float end = min(head, offset + extent);
  if(end <= start)
    return;

  vec2 direction = (b - a) / extent;
  vec2 from = a + direction * (start - offset);
  vec2 to = a + direction * (end - offset);

  // Fade the streak back towards its tail, again by arc length.
  float along = clamp(dot(p - from, direction), 0.0f, end - start) + start;
  float brightness = smoothstep(tail, max(tail + 0.001f, head), along);
  over(color, coverage(segment(p, from, to) - 0.5f) * alpha * brightness);

  // The leading dot belongs to whichever leg the head is currently inside.
  if(head <= offset + extent)
    over(vec3(239.0f, 255.0f, 211.0f) / 255.0f, square(p, to, 3.0f) * alpha);
}

// A single feeder line: edge, elbow, box corner. The head decelerates into the
// box and the tail trails 70% of the path behind it.
void guide(vec2 p, vec2 a, vec2 elbow, vec2 end, float phase, vec3 color, float opacity) {
  float first = length(elbow - a);
  float total = first + length(end - elbow);
  // Ease out so the head lands around phase 0.69, just before the box locks.
  float head = total * (1.0f - pow(1.0f - min(1.0f, phase / 0.69f), 1.4f));
  float tail = max(0.0f, head - total * 0.7f);
  float alpha = opacity * (1.0f - smoothstep(0.78f, 1.0f, phase));
  guideSegment(p, a, elbow, 0.0f, head, tail, color, alpha);
  guideSegment(p, elbow, end, first, head, tail, color, alpha);
}

void target(vec2 p, vec4 bounds, float phase, float seed) {
  // Two overlapping windows drive the whole box: opacity is its fade in and
  // out, lock is the brief snap once the guides have landed.
  float opacity = smoothstep(0.0f, 0.1f, phase) * (1.0f - smoothstep(0.82f, 1.0f, phase));
  float lock = smoothstep(0.67f, 0.76f, phase) * (1.0f - smoothstep(0.84f, 1.0f, phase));
  vec2 lo = bounds.xy * uResolution;
  vec2 hi = (bounds.xy + bounds.zw) * uResolution;
  vec2 pitch = uPitch * uResolution;
  vec3 color = (seed > 0.78f ? vec3(181.0f, 237.0f, 221.0f) : vec3(199.0f, 241.0f, 90.0f)) / 255.0f;
  // Each elbow sits one cell outside the box, or on the far side when the box
  // already touches that edge, so no guide ever runs along the border itself.
  float topX = lo.x >= pitch.x ? lo.x - pitch.x : hi.x;
  float rightY = lo.y >= pitch.y ? lo.y - pitch.y : hi.y;
  float bottomX = hi.x + pitch.x <= uResolution.x ? hi.x + pitch.x : lo.x;
  float leftY = hi.y + pitch.y <= uResolution.y ? hi.y + pitch.y : lo.y;
  // Stagger the four arrivals so they read as a sweep rather than one pulse.
  guide(p, vec2(topX, 0.0f), vec2(topX, lo.y), lo, phase, color, opacity);
  guide(p, vec2(uResolution.x, rightY), vec2(hi.x, rightY), vec2(hi.x, lo.y), max(0.0f, phase - 0.015f), color, opacity);
  guide(p, vec2(bottomX, uResolution.y), vec2(bottomX, hi.y), hi, max(0.0f, phase - 0.03f), color, opacity);
  guide(p, vec2(0.0f, leftY), vec2(lo.x, leftY), vec2(lo.x, hi.y), max(0.0f, phase - 0.045f), color, opacity);

  // Keep each box readable while its lines travel, then brighten on lock.
  float frame = opacity * (0.3f + lock * 0.7f);
  // Corner brackets, capped so the arms never meet on a small cell.
  float arm = min(14.0f, min(hi.x - lo.x, hi.y - lo.y) * 0.24f);
  for(int corner = 0; corner < 4; corner++) {
    // side points inward from the corner, visiting them TL, TR, BR, BL.
    vec2 side = vec2(corner == 0 || corner == 3 ? 1.0f : -1.0f, corner < 2 ? 1.0f : -1.0f);
    vec2 c = mix(lo, hi, (1.0f - side) * 0.5f);
    float bracket = min(segment(p, c, c + vec2(side.x * arm, 0.0f)), segment(p, c, c + vec2(0.0f, side.y * arm)));
    over(color, coverage(bracket - 0.5f) * frame * 0.9f);
    over(vec3(239.0f, 255.0f, 211.0f) / 255.0f, square(p, c, 2.0f + lock) * opacity * lock);
    // Ring that collapses onto the corner as the lock completes.
    float ring = abs(length(p - c) - (3.0f + (1.0f - lock) * 4.0f));
    over(color, coverage(ring - 0.5f) * lock * opacity * 0.6f);
  }

  vec2 center = (lo + hi) * 0.5f;
  vec2 d = abs(p - center) - (hi - lo) * 0.5f;
  float edge = max(d.x, d.y);

  // Dash phase advances along whichever border this fragment is nearest, so the
  // pattern stays continuous around the box instead of restarting per side.
  float perimeter = d.x > d.y ? p.y - lo.y : p.x - lo.x;
  float dash = 1.0f - step(2.0f, mod(perimeter, 7.0f));
  over(color, coverage(abs(edge) - 0.5f) * dash * frame * 0.23f);

  // Interior wash and centre crosshair, both only while the box is locked.
  over(color, coverage(edge) * lock * opacity * 0.065f);
  float crossSize = min(3.0f, min(hi.x - lo.x, hi.y - lo.y) * 0.15f);
  float crossDistance = min(segment(p, center - vec2(crossSize, 0.0f), center + vec2(crossSize, 0.0f)), segment(p, center - vec2(0.0f, crossSize), center + vec2(0.0f, crossSize)));
  over(color, coverage(crossDistance - 0.5f) * lock * opacity * 0.7f);
}

void main() {
  // Dot pass: one flat colour, the vertex stage already placed the point.
  if(uDots) {
    fragColor = vec4(vec3(221.0f, 249.0f, 161.0f) / 255.0f * 0.62f, 0.62f);
    return;
  }

  ink = vec4(0.0f);
  vec2 p = vUv * uResolution;

  // Widen the antialiasing band to the real footprint when the canvas renders
  // below CSS resolution; the floor keeps hairlines from dissolving.
  aa = max(0.5f * max(fwidth(p.x), fwidth(p.y)), 0.35f);

  for(int lane = 0; lane < clamp(FOCUS_BOX_COUNT, 1, 3); lane++) {
    if(uPhases[lane] >= 0.0f)
      target(p, uTargets[lane], uPhases[lane], uSeeds[lane]);
  }

  fragColor = ink;
}
