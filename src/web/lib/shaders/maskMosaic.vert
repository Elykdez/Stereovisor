#version 300 es

// Vertex stage for the mask mosaic. The draw is a single oversized triangle
// covering the viewport, so this only has to hand the fragment stage a UV.

in vec2 aPosition;
out vec2 vUv;

void main() {
  // Image space: v = 0 is the top row, matching the 2D canvases this feeds.
  vUv = vec2(aPosition.x, -aPosition.y) * 0.5f + 0.5f;
  gl_Position = vec4(aPosition, 0.0f, 1.0f);
}
