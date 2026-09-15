/**
 * WebGL2 backend for the mask mosaic. This is the closest thing to the original shader:
 * the cell mapping, twinkle, dropout, glitch and sweep all run per fragment.
 *
 * Against the CPU backend in maskMosaic.ts it wins twice over. Cost stops
 * scaling with the cell count, because no JavaScript runs per cell or per
 * pixel; and quality goes up, because shard edges are resolved at output
 * resolution instead of being rasterized into a small cell buffer and scaled
 * back up. Per-cell averages that the CPU path accumulates by hand come from
 * mipmapped texture reads at the LOD matching each cell's footprint.
 *
 * Only types are imported from maskMosaic.ts, so the two modules stay free of a
 * runtime cycle.
 */
import { appLog } from "./logger";
import type { MosaicShape, MosaicStyle } from "./maskMosaic";
// The shader stages are ordinary .vert/.frag files. Vite's `?raw` suffix inlines
// their text at build time, so they stay editable (and highlightable) as GLSL
// instead of living in a string literal here.
import { glsl } from "./shaders/glsl";
import VERTEX_SHADER from "./shaders/maskMosaic.vert?raw";
import FRAGMENT_SHADER from "./shaders/maskMosaic.frag?raw";

/** Mask detail past this is wasted: coverage is averaged per cell anyway. */
const MASK_TEXTURE_EDGE = 1024;
const PLATE_TEXTURE_EDGE = 2048;
const MAX_OUTPUT_EDGE = 2048;
/** Resolution the covered bounds are probed at, for the sweep's travel. */
const BOUNDS_PROBE_EDGE = 64;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, glsl(source));
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // A failed stage would otherwise disappear into the CPU fallback, which
    // looks like "the effect got slower" rather than "the shader is broken".
    // The driver's log names the line, so surface it verbatim.
    appLog.error("mosaic.shader.compile", gl.getShaderInfoLog(shader), {
      stage: type === gl.VERTEX_SHADER ? "vertex" : "fragment",
    });
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    appLog.error("mosaic.shader.link", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function scratch(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Fit `width`/`height` inside a square of `edge`, never scaling up. */
function fit(width: number, height: number, edge: number): [number, number] {
  const scale = Math.min(1, edge / Math.max(width, height, 1));
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}

export class GlMaskMosaicRenderer {
  /** Returns null when the runtime has no usable WebGL2. */
  static create(): GlMaskMosaicRenderer | null {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // Straight alpha out, so a 2D drawImage of this canvas composites the way
      // the CPU backend's ImageData does.
      premultipliedAlpha: false,
      // Callers may blit after yielding; keep the buffer readable until then.
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) return null;
    const program = link(gl);
    if (!program) return null;
    return new GlMaskMosaicRenderer(canvas, gl, program);
  }

  readonly smoothOutput = true;

  private readonly uniforms = new Map<string, WebGLUniformLocation>();
  private readonly maskTexture: WebGLTexture | null;
  private readonly plateTexture: WebGLTexture | null;
  private maskScratch: HTMLCanvasElement | null = null;
  private plateScratch: HTMLCanvasElement | null = null;
  private probeScratch: HTMLCanvasElement | null = null;
  private lost = false;
  private aspect = 1;
  private shape: MosaicShape | null = null;
  private maskSource: CanvasImageSource | null = null;
  private maskBlur = 0;
  private maskSourceWidth = 0;
  private maskDirty = true;
  private maskSize: [number, number] = [1, 1];
  private plateSource: CanvasImageSource | null = null;
  private plateDirty = true;
  private plateSize: [number, number] = [1, 1];
  private hasPlate = false;
  private bounds: [number, number, number, number] = [0, 0, 1, 1];

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
  ) {
    canvas.addEventListener("webglcontextlost", (event) => {
      // Nothing to restore into: report failure so the caller can drop to the
      // CPU backend for the rest of the session.
      event.preventDefault();
      this.lost = true;
    });

    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let index = 0; index < count; index += 1) {
      const info = gl.getActiveUniform(program, index);
      const location = info && gl.getUniformLocation(program, info.name);
      if (info && location) this.uniforms.set(info.name, location);
    }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One oversized triangle covers the viewport with no seam down the middle.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Both default to nothing: zero coverage until a mask is bound, and no plate
    // until one is uploaded.
    this.maskTexture = this.createTexture(new Uint8Array([0, 0, 0, 0]));
    this.plateTexture = this.createTexture(new Uint8Array([0, 0, 0, 0]));
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }

  configure(width: number, height: number, shape: MosaicShape): void {
    const [outputWidth, outputHeight] = fit(width, height, MAX_OUTPUT_EDGE);
    this.aspect = width / Math.max(height, 1);
    this.shape = shape;
    if (
      this.canvas.width !== outputWidth ||
      this.canvas.height !== outputHeight
    ) {
      this.canvas.width = outputWidth;
      this.canvas.height = outputHeight;
    }
  }

  setMask(
    source: CanvasImageSource | null,
    blurPixels = 0,
    sourceWidth = 0,
  ): void {
    if (
      this.maskSource === source &&
      this.maskBlur === blurPixels &&
      this.maskSourceWidth === sourceWidth
    )
      return;
    this.maskSource = source;
    this.maskBlur = blurPixels;
    this.maskSourceWidth = sourceWidth;
    this.maskDirty = true;
  }

  invalidateMask(): void {
    this.maskDirty = true;
  }

  setPlate(source: CanvasImageSource | null): void {
    if (this.plateSource === source) return;
    this.plateSource = source;
    this.plateDirty = true;
  }

  paint(time: number, style: MosaicStyle): HTMLCanvasElement | null {
    const { gl } = this;
    if (this.lost || gl.isContextLost() || !this.shape) return null;
    if (this.maskDirty) this.uploadMask();
    if (this.plateDirty) this.uploadPlate();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.plateTexture);
    this.setInt("uMask", 0);
    this.setInt("uPlate", 1);
    this.setVec2("uMaskSize", this.maskSize[0], this.maskSize[1]);
    this.setVec2("uPlateSize", this.plateSize[0], this.plateSize[1]);
    this.setFloat("uHasPlate", this.hasPlate ? 1 : 0);
    this.setFloat("uAspect", this.aspect);
    this.setFloat("uTime", time);

    this.setFloat("uSize", this.shape.size);
    this.setFloat("uShapeAspect", this.shape.aspect);
    this.setVec2("uStretch", this.shape.stretch[0], this.shape.stretch[1]);
    this.setVec2(
      "uVariation",
      this.shape.variation[0],
      this.shape.variation[1],
    );

    this.setFloat("uAlpha", style.alpha);
    this.setVec3(
      "uTint",
      style.tint[0] / 255,
      style.tint[1] / 255,
      style.tint[2] / 255,
    );
    this.setFloat("uTintAmount", style.tintAmount);
    this.setFloat("uBrightness", style.brightness);
    this.setFloat("uDropout", style.dropout);
    this.setFloat("uGrain", style.grain);
    this.setFloat("uTwinkleStrength", style.twinkleStrength);
    this.setFloat("uTwinkleSpeed", style.twinkleSpeed);
    this.setFloat("uTwinkleDensity", style.twinkleDensity);
    this.setFloat("uTwinkleJitter", style.twinkleJitter);
    this.setFloat("uChromatic", style.chromatic);
    this.setFloat("uGlitch", style.glitch);
    this.setFloat("uSweepStrength", style.sweepStrength);
    this.setFloat("uSweepSpeed", style.sweepSpeed);
    this.setFloat("uSweepWidth", style.sweepWidth);
    this.setVec4(
      "uBounds",
      this.bounds[0],
      this.bounds[1],
      this.bounds[2],
      this.bounds[3],
    );

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return gl.isContextLost() ? null : this.canvas;
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.plateTexture);
    gl.deleteProgram(this.program);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.lost = true;
  }

  private createTexture(fill: Uint8Array): WebGLTexture | null {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      fill,
    );
    // A 1x1 texture still has to be mip complete, or the mipmapped filter below
    // samples black however low the requested LOD is.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  private upload(
    texture: WebGLTexture | null,
    source: CanvasImageSource,
  ): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source as TexImageSource,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  private uploadPixels(
    texture: WebGLTexture | null,
    pixels: Uint8Array,
    width: number,
    height: number,
  ): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  private uploadMask(): void {
    this.maskDirty = false;
    if (!this.maskSource) {
      // Nothing marked. A 1x1 transparent texel leaves every cell at zero
      // coverage, which the shader discards before it does any work.
      this.uploadPixels(this.maskTexture, new Uint8Array([0, 0, 0, 0]), 1, 1);
      this.maskSize = [1, 1];
      this.bounds = [0, 0, 1, 1];
      return;
    }
    const [width, height] = fit(
      Math.round(MASK_TEXTURE_EDGE * Math.max(this.aspect, 1)),
      Math.round(MASK_TEXTURE_EDGE / Math.min(this.aspect, 1)),
      MASK_TEXTURE_EDGE,
    );
    const canvas = (this.maskScratch ??= scratch(width, height));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (this.maskSource) {
      // The editor's edge-blur preview has to survive the downsample, so it is
      // baked in here rather than re-applied on every frame.
      const blur =
        this.maskBlur *
        (this.maskSourceWidth > 0 ? width / this.maskSourceWidth : 1);
      context.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
      context.drawImage(this.maskSource, 0, 0, width, height);
      context.filter = "none";
    }
    this.maskSize = [width, height];
    this.upload(this.maskTexture, canvas);
    this.probeBounds(canvas);
  }

  private uploadPlate(): void {
    this.plateDirty = false;
    this.hasPlate = false;
    if (!this.plateSource) return;
    const [width, height] = fit(
      Math.round(PLATE_TEXTURE_EDGE * Math.max(this.aspect, 1)),
      Math.round(PLATE_TEXTURE_EDGE / Math.min(this.aspect, 1)),
      PLATE_TEXTURE_EDGE,
    );
    const canvas = (this.plateScratch ??= scratch(width, height));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(this.plateSource, 0, 0, width, height);
    this.plateSize = [width, height];
    this.upload(this.plateTexture, canvas);
    this.hasPlate = true;
  }

  /**
   * Bounds of the covered area in UV, so the sweep crosses the painted region
   * instead of the whole composition. Read from a thumbnail of the mask, which
   * is the only pixel readback left on this path and happens once per edit.
   */
  private probeBounds(mask: HTMLCanvasElement): void {
    const canvas = (this.probeScratch ??= scratch(
      BOUNDS_PROBE_EDGE,
      BOUNDS_PROBE_EDGE,
    ));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.clearRect(0, 0, BOUNDS_PROBE_EDGE, BOUNDS_PROBE_EDGE);
    context.drawImage(mask, 0, 0, BOUNDS_PROBE_EDGE, BOUNDS_PROBE_EDGE);
    const data = context.getImageData(
      0,
      0,
      BOUNDS_PROBE_EDGE,
      BOUNDS_PROBE_EDGE,
    ).data;
    let minX = BOUNDS_PROBE_EDGE;
    let minY = BOUNDS_PROBE_EDGE;
    let maxX = -1;
    let maxY = -1;
    for (
      let pixel = 0, alphaAt = 3;
      alphaAt < data.length;
      pixel += 1, alphaAt += 4
    ) {
      if (data[alphaAt] === 0) continue;
      const x = pixel % BOUNDS_PROBE_EDGE;
      const y = (pixel - x) / BOUNDS_PROBE_EDGE;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.bounds =
      maxX >= minX
        ? [
            minX / BOUNDS_PROBE_EDGE,
            minY / BOUNDS_PROBE_EDGE,
            (maxX + 1) / BOUNDS_PROBE_EDGE,
            (maxY + 1) / BOUNDS_PROBE_EDGE,
          ]
        : [0, 0, 1, 1];
  }

  private setInt(name: string, value: number): void {
    const location = this.uniforms.get(name);
    if (location) this.gl.uniform1i(location, value);
  }

  private setFloat(name: string, value: number): void {
    const location = this.uniforms.get(name);
    if (location) this.gl.uniform1f(location, value);
  }

  private setVec2(name: string, x: number, y: number): void {
    const location = this.uniforms.get(name);
    if (location) this.gl.uniform2f(location, x, y);
  }

  private setVec3(name: string, x: number, y: number, z: number): void {
    const location = this.uniforms.get(name);
    if (location) this.gl.uniform3f(location, x, y, z);
  }

  private setVec4(
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    const location = this.uniforms.get(name);
    if (location) this.gl.uniform4f(location, x, y, z, w);
  }
}
