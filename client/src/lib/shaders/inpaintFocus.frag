#version 300 es
precision highp float;

// Choose 1, 2, or 3 simultaneous boxes. Target selection and the Canvas
// fallback read this same setting; a small mask may fit fewer boxes.
#define FOCUS_BOX_COUNT 3

in vec2 vUv;
out vec4 fragColor;
uniform bool uDots;
uniform vec2 uResolution;
uniform vec2 uPitch;
uniform vec4 uTargets[3];
uniform vec3 uPhases;
uniform vec3 uSeeds;

vec4 ink;
float aa;

void over(vec3 color, float alpha) {
  alpha = clamp(alpha, 0.0, 1.0);
  ink = vec4(color * alpha, alpha) + ink * (1.0 - alpha);
}

float coverage(float distance) {
  return 1.0 - smoothstep(-aa, aa, distance);
}

float segment(vec2 p, vec2 a, vec2 b) {
  vec2 delta = b - a;
  float along = clamp(dot(p - a, delta) / max(dot(delta, delta), 0.0001), 0.0, 1.0);
  return length(p - a - along * delta);
}

float square(vec2 p, vec2 center, float size) {
  vec2 d = abs(p - center) - size * 0.5;
  return coverage(max(d.x, d.y));
}

void guideSegment(vec2 p, vec2 a, vec2 b, float offset, float head, float tail, vec3 color, float alpha) {
  float extent = length(b - a);
  if (extent < 0.001) return;
  over(color, coverage(segment(p, a, b) - 0.5) * alpha * 0.12);
  float start = max(tail, offset);
  float end = min(head, offset + extent);
  if (end <= start) return;
  vec2 direction = (b - a) / extent;
  vec2 from = a + direction * (start - offset);
  vec2 to = a + direction * (end - offset);
  float along = clamp(dot(p - from, direction), 0.0, end - start) + start;
  float brightness = smoothstep(tail, max(tail + 0.001, head), along);
  over(color, coverage(segment(p, from, to) - 0.5) * alpha * brightness);
  if (head <= offset + extent) over(vec3(239.0, 255.0, 211.0) / 255.0, square(p, to, 3.0) * alpha);
}

void guide(vec2 p, vec2 a, vec2 elbow, vec2 end, float phase, vec3 color, float opacity) {
  float first = length(elbow - a);
  float total = first + length(end - elbow);
  float head = total * (1.0 - pow(1.0 - min(1.0, phase / 0.69), 1.4));
  float tail = max(0.0, head - total * 0.7);
  float alpha = opacity * (1.0 - smoothstep(0.78, 1.0, phase));
  guideSegment(p, a, elbow, 0.0, head, tail, color, alpha);
  guideSegment(p, elbow, end, first, head, tail, color, alpha);
}

void target(vec2 p, vec4 bounds, float phase, float seed) {
  float opacity = smoothstep(0.0, 0.1, phase) * (1.0 - smoothstep(0.82, 1.0, phase));
  float lock = smoothstep(0.67, 0.76, phase) * (1.0 - smoothstep(0.84, 1.0, phase));
  vec2 lo = bounds.xy * uResolution;
  vec2 hi = (bounds.xy + bounds.zw) * uResolution;
  vec2 pitch = uPitch * uResolution;
  vec3 color = (seed > 0.78 ? vec3(181.0, 237.0, 221.0) : vec3(199.0, 241.0, 90.0)) / 255.0;
  float topX = lo.x >= pitch.x ? lo.x - pitch.x : hi.x;
  float rightY = lo.y >= pitch.y ? lo.y - pitch.y : hi.y;
  float bottomX = hi.x + pitch.x <= uResolution.x ? hi.x + pitch.x : lo.x;
  float leftY = hi.y + pitch.y <= uResolution.y ? hi.y + pitch.y : lo.y;
  guide(p, vec2(topX, 0.0), vec2(topX, lo.y), lo, phase, color, opacity);
  guide(p, vec2(uResolution.x, rightY), vec2(hi.x, rightY), vec2(hi.x, lo.y), max(0.0, phase - 0.015), color, opacity);
  guide(p, vec2(bottomX, uResolution.y), vec2(bottomX, hi.y), hi, max(0.0, phase - 0.03), color, opacity);
  guide(p, vec2(0.0, leftY), vec2(lo.x, leftY), vec2(lo.x, hi.y), max(0.0, phase - 0.045), color, opacity);

  // Keep each box readable while its lines travel, then brighten on lock.
  float frame = opacity * (0.3 + lock * 0.7);
  float arm = min(14.0, min(hi.x - lo.x, hi.y - lo.y) * 0.24);
  for (int corner = 0; corner < 4; corner++) {
    vec2 side = vec2(corner == 0 || corner == 3 ? 1.0 : -1.0, corner < 2 ? 1.0 : -1.0);
    vec2 c = mix(lo, hi, (1.0 - side) * 0.5);
    float bracket = min(segment(p, c, c + vec2(side.x * arm, 0.0)), segment(p, c, c + vec2(0.0, side.y * arm)));
    over(color, coverage(bracket - 0.5) * frame * 0.9);
    over(vec3(239.0, 255.0, 211.0) / 255.0, square(p, c, 2.0 + lock) * opacity * lock);
    float ring = abs(length(p - c) - (3.0 + (1.0 - lock) * 4.0));
    over(color, coverage(ring - 0.5) * lock * opacity * 0.6);
  }
  vec2 center = (lo + hi) * 0.5;
  vec2 d = abs(p - center) - (hi - lo) * 0.5;
  float edge = max(d.x, d.y);
  float perimeter = d.x > d.y ? p.y - lo.y : p.x - lo.x;
  float dash = 1.0 - step(2.0, mod(perimeter, 7.0));
  over(color, coverage(abs(edge) - 0.5) * dash * frame * 0.23);
  over(color, coverage(edge) * lock * opacity * 0.065);
  float crossSize = min(3.0, min(hi.x - lo.x, hi.y - lo.y) * 0.15);
  float crossDistance = min(segment(p, center - vec2(crossSize, 0.0), center + vec2(crossSize, 0.0)), segment(p, center - vec2(0.0, crossSize), center + vec2(0.0, crossSize)));
  over(color, coverage(crossDistance - 0.5) * lock * opacity * 0.7);
}

void main() {
  if (uDots) {
    fragColor = vec4(vec3(221.0, 249.0, 161.0) / 255.0 * 0.62, 0.62);
    return;
  }
  ink = vec4(0.0);
  vec2 p = vUv * uResolution;
  aa = max(0.5 * max(fwidth(p.x), fwidth(p.y)), 0.35);
  for (int lane = 0; lane < clamp(FOCUS_BOX_COUNT, 1, 3); lane++) {
    if (uPhases[lane] >= 0.0) target(p, uTargets[lane], uPhases[lane], uSeeds[lane]);
  }
  fragColor = ink;
}
