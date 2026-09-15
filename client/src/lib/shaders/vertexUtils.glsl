#version 300 es

// Shared vertex helpers, spliced in by glsl.ts, which drops the #version above
// because the including shader has already declared it. A vertex stage defaults
// to highp float, so unlike fragmentUtils.glsl there is no precision to repeat.

// One oversized triangle covering the viewport, built from the vertex id alone
// so the draw needs no attributes and no buffer.
vec2 fullscreenTriangle(int vertexId) {
  return vec2(vertexId == 1 ? 3.0f : -1.0f, vertexId == 2 ? 3.0f : -1.0f);
}

// Clip space to image space: v = 0 is the top row, matching the 2D canvases
// and texture uploads these shaders composite against.
vec2 imageUv(vec2 position) {
  return position * vec2(0.5f, -0.5f) + 0.5f;
}

// The inverse, for passes that already hold an image UV and need clip space.
vec2 clipFromImageUv(vec2 uv) {
  return uv * vec2(2.0f, -2.0f) + vec2(-1.0f, 1.0f);
}
