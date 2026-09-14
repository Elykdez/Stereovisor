import { appLog } from "./logger";
import VERTEX_SHADER from "./shaders/inpaintForeground.vert?raw";
import FRAGMENT_SHADER from "./shaders/inpaintForeground.frag?raw";

export class GlInpaintForegroundRenderer {
  static create(): GlInpaintForegroundRenderer | null {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: true,
    });
    if (!gl) return null;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    try {
      program = gl.createProgram();
      if (!program) throw new Error("Could not allocate the foreground program.");
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Could not allocate a foreground shader.");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Foreground shader compilation failed.");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Foreground shader linking failed.");
      return new GlInpaintForegroundRenderer(canvas, gl, program);
    } catch (error) {
      appLog.error("inpaint-foreground.shader.failed", error);
      gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return null;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  private readonly textures = new Map<CanvasImageSource, WebGLTexture>();
  private readonly locations: Record<string, WebGLUniformLocation | null>;
  private readonly upload = document.createElement("canvas");

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
  ) {
    this.locations = Object.fromEntries(["uCutout", "uResolution", "uTime", "uSeed"]
      .map((name) => [name, gl.getUniformLocation(program, name)]));
  }

  paint(source: CanvasImageSource, width: number, height: number, time: number, layerId: string, pixelScale = 1): HTMLCanvasElement | null {
    const { gl, canvas, locations: u } = this;
    if (gl.isContextLost()) return null;
    const scale = Math.min(1, 2048 / Math.max(width, height), (window.devicePixelRatio || 1) / pixelScale);
    const outputWidth = Math.max(1, Math.round(width * scale));
    const outputHeight = Math.max(1, Math.round(height * scale));
    if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
      canvas.width = outputWidth;
      canvas.height = outputHeight;
    }
    gl.activeTexture(gl.TEXTURE0);
    let texture = this.textures.get(source);
    if (!texture) {
      const sampling = this.upload.getContext("2d", { alpha: true });
      if (!sampling) return null;
      const textureScale = Math.min(1, 1024 / Math.max(width, height));
      this.upload.width = Math.max(1, Math.round(width * textureScale));
      this.upload.height = Math.max(1, Math.round(height * textureScale));
      sampling.drawImage(source, 0, 0, this.upload.width, this.upload.height);
      const next = gl.createTexture();
      if (!next) return null;
      texture = next;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.upload);
      this.textures.set(source, texture);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, texture);
    }
    let seed = 0;
    for (const character of layerId) seed = (Math.imul(seed, 31) + character.charCodeAt(0)) >>> 0;
    gl.viewport(0, 0, outputWidth, outputHeight);
    gl.useProgram(this.program);
    gl.uniform1i(u.uCutout, 0);
    gl.uniform2f(u.uResolution, width / pixelScale, height / pixelScale);
    gl.uniform1f(u.uTime, time);
    gl.uniform1f(u.uSeed, (seed % 1009) / 1009);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.isContextLost() ? null : canvas;
  }

  dispose(): void {
    for (const texture of this.textures.values()) this.gl.deleteTexture(texture);
    this.textures.clear();
    this.gl.deleteProgram(this.program);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.upload.width = this.upload.height = 1;
  }
}
