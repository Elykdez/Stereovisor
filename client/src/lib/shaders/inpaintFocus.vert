#version 300 es

// Vertex stage for the targeting overlay, shared by both of its passes:
// a POINT draw for the grid dots and a fullscreen triangle for the boxes.

// Shared helpers, defined in vertexUtils.glsl and spliced in by glsl.ts. GLSL
// ES has no #include, so the directive is written as a comment that only the
// composer reads; these prototypes are what the compiler and the editor's
// validator resolve the calls against.
vec2 fullscreenTriangle(int vertexId);
vec2 imageUv(vec2 position);
vec2 clipFromImageUv(vec2 uv);
//#include "vertexUtils.glsl"

layout(location = 0) in vec2 aPosition;
uniform bool uDots;
uniform float uPointSize;
out vec2 vUv;

void main() {
  if(uDots) {
    // Dot pass: aPosition already is an image UV, so map it straight to clip
    // space, which is the one place this runs the conversion backwards.
    vUv = aPosition;
    gl_Position = vec4(clipFromImageUv(aPosition), 0.0f, 1.0f);
    gl_PointSize = uPointSize;
  } else {
    // Box pass: no attributes are bound, the triangle comes from the vertex id
    // and is oversized so one primitive covers the viewport.
    vec2 position = fullscreenTriangle(gl_VertexID);
    vUv = imageUv(position);
    gl_Position = vec4(position, 0.0f, 1.0f);
  }
}
