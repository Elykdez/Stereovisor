#version 300 es

// Vertex stage for the mask mosaic. The draw is a single oversized triangle
// covering the viewport, so this only has to hand the fragment stage a UV.

// Shared helpers, defined in vertexUtils.glsl and spliced in by glsl.ts. GLSL
// ES has no #include, so the directive is written as a comment that only the
// composer reads; this prototype is what the compiler and the editor's
// validator resolve the call against.
vec2 imageUv(vec2 position);
//#include "vertexUtils.glsl"

in vec2 aPosition;
out vec2 vUv;

void main() {
  // Image space: v = 0 is the top row, matching the 2D canvases this feeds.
  vUv = imageUv(aPosition);
  gl_Position = vec4(aPosition, 0.0f, 1.0f);
}
