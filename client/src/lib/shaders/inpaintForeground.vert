#version 300 es

// Vertex stage for the foreground glitch. No attributes are bound:
// the draw is three vertices and the oversized triangle is built from the vertex id alone,
// so this only has to hand the fragment stage a UV.

// Shared helpers, defined in vertexUtils.glsl and spliced in by glsl.ts. GLSL
// ES has no #include, so the directive is written as a comment that only the
// composer reads; these prototypes are what the compiler and the editor's
// validator resolve the calls against.
vec2 fullscreenTriangle(int vertexId);
vec2 imageUv(vec2 position);
//#include "vertexUtils.glsl"

out vec2 vUv;

void main() {

  vec2 position = fullscreenTriangle(gl_VertexID);

  // Image space: v = 0 is the top row, matching the cutout texture upload.
  vUv = imageUv(position);
  gl_Position = vec4(position, 0.0f, 1.0f);

}
