#version 300 es

layout(location = 0) in vec2 aPosition;
uniform bool uDots;
uniform float uPointSize;
out vec2 vUv;

void main() {
  if (uDots) {
    vUv = aPosition;
    gl_Position = vec4(aPosition * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
    gl_PointSize = uPointSize;
  } else {
    vec2 position = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    vUv = position * vec2(0.5, -0.5) + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }
}
