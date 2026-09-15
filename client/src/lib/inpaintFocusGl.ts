import { appLog } from "./logger";
import type { FocusAnimation } from "./inpaintFocus";
import { glsl } from "./shaders/glsl";
import VERTEX_SHADER from "./shaders/inpaintFocus.vert?raw";
import FRAGMENT_SHADER from "./shaders/inpaintFocus.frag?raw";

// The shader is the single source of truth for both backends' target count.
export const INPAINT_FOCUS_BOX_COUNT = Math.max(1, Math.min(3,
  Number(FRAGMENT_SHADER.match(/^\s*#define\s+FOCUS_BOX_COUNT\s+(\d+)\b/m)?.[1] ?? 3),
));

export class GlInpaintFocusRenderer {
  static create(): GlInpaintFocusRenderer | null {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: true,
    });
    if (!gl) return null;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    try {
      program = gl.createProgram();
      buffer = gl.createBuffer();
      if (!program || !buffer) throw new Error("Could not allocate focus shader resources.");
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Could not allocate a focus shader.");
        shaders.push(shader);
        gl.shaderSource(shader, glsl(source));
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Focus shader compilation failed.");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Focus shader linking failed.");
      return new GlInpaintFocusRenderer(canvas, gl, program, buffer);
    } catch (error) {
      appLog.error("inpaint-focus.shader.failed", error);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return null;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  private dots: readonly [number, number][] | null = null;
  private readonly locations: Record<string, WebGLUniformLocation | null>;
  private readonly bounds = new Float32Array(12);
  private readonly phases = new Float32Array(3);
  private readonly seeds = new Float32Array(3);

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
    private readonly buffer: WebGLBuffer,
  ) {
    this.locations = Object.fromEntries(["uDots", "uPointSize", "uResolution", "uPitch", "uTargets[0]", "uPhases", "uSeeds"]
      .map((name) => [name, gl.getUniformLocation(program, name)]));
  }

  paint(width: number, height: number, pixelScale: number, dots: readonly [number, number][], frames: readonly FocusAnimation[]): HTMLCanvasElement | null {
    const { gl, canvas, locations: u } = this;
    if (gl.isContextLost()) return null;
    const scale = Math.min(1, 2048 / Math.max(width, height), (window.devicePixelRatio || 1) / pixelScale);
    const outputWidth = Math.max(1, Math.round(width * scale));
    const outputHeight = Math.max(1, Math.round(height * scale));
    if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
      canvas.width = outputWidth;
      canvas.height = outputHeight;
    }
    gl.viewport(0, 0, outputWidth, outputHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.dots !== dots) {
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(dots.flat()), gl.STATIC_DRAW);
      this.dots = dots;
    }
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(u.uDots, 1);
    gl.uniform1f(u.uPointSize, Math.max(1, 2 * pixelScale * outputWidth / width));
    gl.drawArrays(gl.POINTS, 0, dots.length);

    this.phases.fill(-1);
    frames.forEach((frame, lane) => {
      const { target } = frame;
      this.bounds.set([target.x, target.y, target.width, target.height], lane * 4);
      this.phases[lane] = frame.phase;
      this.seeds[lane] = frame.seed;
    });
    gl.disableVertexAttribArray(0);
    gl.uniform1i(u.uDots, 0);
    gl.uniform2f(u.uResolution, width / pixelScale, height / pixelScale);
    gl.uniform2f(u.uPitch, frames[0]?.target.pitchX ?? 0, frames[0]?.target.pitchY ?? 0);
    gl.uniform4fv(u["uTargets[0]"], this.bounds);
    gl.uniform3fv(u.uPhases, this.phases);
    gl.uniform3fv(u.uSeeds, this.seeds);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.isContextLost() ? null : canvas;
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.dots = null;
  }
}
