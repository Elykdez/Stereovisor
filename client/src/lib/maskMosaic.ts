/**
 * Mosaic mask visuals: a port of the cell system from the Poupiu Unity shader
 * "AIP/UI/MosaicEffect". The shader shatters a whole frame into pixel cells
 * while a generation runs; here the same cells are confined to the area a
 * running inpaint job is rebuilding, so that region reads as a field of shards
 * while the rest of the composition stays intact.
 *
 * The cell mapping is faithful either way (aspect blend, per-row/column stretch
 * variation, twinkle, dropout, and the bright sweep from the shader's line
 * pass). What varies is where it runs. MaskMosaicRenderer
 * prefers the WebGL2 backend in maskMosaicGl.ts, which evaluates the port per
 * fragment exactly as the original does; the CPU backend below stands in when
 * WebGL2 is missing, trading per-pixel detail for a per-cell approximation.
 *
 * This module owns the shared vocabulary: the shape and style the two backends
 * read, and the cell math the CPU one rasterizes with.
 */
import { GlMaskMosaicRenderer } from "./maskMosaicGl";

/** Cell geometry. Mirrors the shader's _Mosaic* properties. */
export interface MosaicShape {
  /** Cells across the reference axis (_MosaicSize). */
  size: number;
  /** 0 = width-based squares, 0.5 = quad-shaped, 1 = height-based squares (_MosaicAspect). */
  aspect: number;
  /** Per-axis cell stretch, 1 = none (_MosaicStretch.xy). */
  stretch: readonly [number, number];
  /** Randomizes stretch per row/column, 0 = uniform (_MosaicStretch.zw). */
  variation: readonly [number, number];
}

/** Per-frame appearance of the cells. */
export interface MosaicStyle {
  /** Opacity of the whole mosaic layer. */
  alpha: number;
  /** Colour the cells are pulled toward, 0-255 per channel. */
  tint: readonly [number, number, number];
  /** How far cells are pulled toward the tint. */
  tintAmount: number;
  /** Multiplier applied to the resolved cell colour. */
  brightness: number;
  /** Fraction of cells punched out (_MosaicDropout). */
  dropout: number;
  /** Animated per-cell brightness noise (_NoiseStrength). */
  grain: number;
  twinkleStrength: number;
  twinkleSpeed: number;
  twinkleDensity: number;
  twinkleJitter: number;
  /** RGB split in cell widths (_ChromaticAberration). Needs a bound plate. */
  chromatic: number;
  /** Horizontal shard displacement on scattered rows (_GlitchStrength). */
  glitch: number;
  /** Brightness of the travelling rainbow line ported from the shader's line pass. */
  sweepStrength: number;
  /** Sweeps per second. */
  sweepSpeed: number;
  /** Half-width of the sweep in reveal-metric units (_LineThickness). */
  sweepWidth: number;
}

export interface MosaicField {
  /** Working resolution the cells were rasterized at. */
  width: number;
  height: number;
  /** Whole-cell counts per axis, used to scale cell-space offsets. */
  cellsX: number;
  cellsY: number;
  /** Number of distinct cells. */
  count: number;
  /** Working pixel -> cell slot. */
  index: Int32Array;
  /** Shader cell id per slot, which seeds all per-cell noise. */
  cellX: Int32Array;
  cellY: Int32Array;
  /** UV the cell samples its colour from (the shader's pixelUV). */
  sampleU: Float32Array;
  sampleV: Float32Array;
  /** Working pixels owned by each slot. */
  area: Int32Array;
}

export const DEFAULT_MOSAIC_SHAPE: MosaicShape = {
  size: 52,
  aspect: 0,
  stretch: [1, 1],
  variation: [0, 0],
};

/**
 * Shown while an inpainting job runs, over the area it is rebuilding: the plate
 * under that area shows through, shattered into cells and tinted. This is the
 * shader's "waiting" state, so it belongs to work in progress and not to any
 * mask display.
 */
export const INPAINT_MOSAIC_STYLE: MosaicStyle = {
  alpha: 0.95,
  tint: [199, 241, 90],
  // Tint and local flicker identify the pending region without a travelling band.
  tintAmount: 0.34,
  brightness: 0.92,
  dropout: 0.06,
  grain: 0.1,
  twinkleStrength: 0.5,
  twinkleSpeed: 5,
  twinkleDensity: 0.12,
  twinkleJitter: 0.45,
  chromatic: 0.4,
  glitch: 0.02,
  sweepStrength: 0,
  sweepSpeed: 0.26,
  sweepWidth: 0.06,
};

/**
 * Cell counts a running job steps through, coarse to fine. The plate starts as
 * a handful of huge blocks and resolves toward the shape's own count as the
 * model finishes, which is how the Unity effect leaves its waiting state.
 *
 * Discrete steps rather than a continuous ramp: cell size drives the whole
 * layout, so a count that moved every frame would slide the grid under the
 * cells instead of reading as a resolve.
 */
export const MOSAIC_RESOLVE_SIZES = [6, 9, 13, 20, 30, 44] as const;

/**
 * Shape for a job that is `percent` (0-100) of the way through. Anything coarser
 * than the target count is dropped, so a shape finer than the ladder still
 * resolves and a coarse one simply has fewer steps to take.
 */
export function mosaicShapeForProgress(
  percent: number,
  shape: MosaicShape = DEFAULT_MOSAIC_SHAPE,
): MosaicShape {
  const ladder: number[] = MOSAIC_RESOLVE_SIZES.filter((size) => size < shape.size);
  ladder.push(shape.size);
  const step = Math.min(
    ladder.length - 1,
    Math.floor(clamp01(percent / 100) * ladder.length),
  );
  return ladder[step] === shape.size ? shape : { ...shape, size: ladder[step] };
}

/** Working pixels per cell. */
const PIXELS_PER_CELL = 8;
const MAX_WORK_EDGE = 512;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clampInt(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0 || Number.EPSILON));
  return t * t * (3 - 2 * t);
}

/** Port of Rand() in FragmentUtils.cginc. */
export function rand(x: number, y: number): number {
  const noise = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return noise - Math.floor(noise);
}

/** Hash cell, tick and stream independently so animation cannot translate the noise field. */
export function mosaicAnimationNoise(x: number, y: number, tick: number, stream: number): number {
  let value = Math.imul(x, 1973) ^ Math.imul(y, 9277) ^ Math.imul(tick, 26699) ^ Math.imul(stream, 31847);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  value ^= value >>> 16;
  // Match the 24 bits that the WebGL float can represent exactly.
  return (value >>> 8) / 16777216;
}

/** Port of HSVtoRGB() in FragmentUtils.cginc, returning 0-255 channels. */
export function hsvToRgb(
  hue: number,
  saturation: number,
  value: number,
): [number, number, number] {
  const channel = (offset: number) => {
    const wrapped = Math.abs(((hue * 6 + offset) % 6) - 3) - 1;
    const clamped = clamp01(wrapped);
    return clamped * clamped * (3 - 2 * clamped);
  };
  return [
    255 * value * lerp(1, channel(0), saturation),
    255 * value * lerp(1, channel(4), saturation),
    255 * value * lerp(1, channel(2), saturation),
  ];
}

/**
 * Cells per axis for a given display aspect. Port of the `n` term in the
 * shader's mosaicCells(): _MosaicAspect picks which dimension stays square.
 */
export function mosaicCellCounts(
  aspect: number,
  shape: MosaicShape,
): [number, number] {
  const ratio = Math.max(aspect, 1e-6);
  const t = clamp01(shape.aspect);
  return [
    Math.max((shape.size * ratio) / lerp(ratio, 1, clamp01(2 * t - 1)), 1),
    Math.max(shape.size / lerp(ratio, 1, clamp01(2 * t)), 1),
  ];
}

/**
 * Rasterize the cell layout once for a configuration. Every working pixel is
 * assigned the cell that owns it plus the UV that cell samples from, which is
 * exactly what mosaicCells() returns per fragment in the shader.
 */
export function buildMosaicField(
  aspect: number,
  shape: MosaicShape,
  width: number,
  height: number,
): MosaicField {
  const [baseX, baseY] = mosaicCellCounts(aspect, shape);
  const stretchX = Math.max(shape.stretch[0], 1);
  const stretchY = Math.max(shape.stretch[1], 1);
  const variationX = clamp01(shape.variation[0]);
  const variationY = clamp01(shape.variation[1]);
  // Stretch only ever lowers the cell count, so the untouched base counts bound
  // every id the mapping below can produce.
  const spanX = Math.max(Math.ceil(baseX), 1);
  const spanY = Math.max(Math.ceil(baseY), 1);
  const slotOf = new Int32Array(spanX * spanY).fill(-1);
  const index = new Int32Array(width * height);
  const cellX: number[] = [];
  const cellY: number[] = [];
  const sampleU: number[] = [];
  const sampleV: number[] = [];
  const area: number[] = [];

  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    const v = (pixelY + 0.5) / height;
    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      const u = (pixelX + 0.5) / width;
      let rowStretch = stretchX;
      let columnStretch = stretchY;
      if (variationX > 0 && stretchX > 1) {
        const rowNoise = rand(Math.floor(v * baseY), 43.17);
        rowStretch = lerp(stretchX, lerp(1, stretchX, rowNoise), variationX);
      }
      if (variationY > 0 && stretchY > 1) {
        const columnNoise = rand(Math.floor(u * baseX), 87.31);
        columnStretch = lerp(
          stretchY,
          lerp(1, stretchY, columnNoise),
          variationY,
        );
      }
      const countX = Math.max(baseX / rowStretch, 1);
      const countY = Math.max(baseY / columnStretch, 1);
      const cellWidth = 1 / countX;
      const cellHeight = 1 / countY;
      const wholeX = Math.max(Math.floor(countX), 1);
      const wholeY = Math.max(Math.floor(countY), 1);
      // Centre the leftover when the counts do not divide the axis evenly.
      const marginX = (1 - wholeX * cellWidth) / 2;
      const marginY = (1 - wholeY * cellHeight) / 2;

      const idX = clampInt(
        Math.floor((u - marginX) / cellWidth),
        0,
        wholeX - 1,
      );
      const idY = clampInt(
        Math.floor((v - marginY) / cellHeight),
        0,
        wholeY - 1,
      );
      const cellU = (idX + 0.5) * cellWidth + marginX;
      const cellV = (idY + 0.5) * cellHeight + marginY;
      const key = idX + idY * spanX;
      let slot = slotOf[key];
      if (slot < 0) {
        slot = cellX.length;
        slotOf[key] = slot;
        cellX.push(idX);
        cellY.push(idY);
        sampleU.push(clamp01(cellU));
        sampleV.push(clamp01(cellV));
        area.push(0);
      }
      index[pixelY * width + pixelX] = slot;
      area[slot] += 1;
    }
  }

  return {
    width,
    height,
    cellsX: Math.max(Math.floor(baseX), 1),
    cellsY: Math.max(Math.floor(baseY), 1),
    count: cellX.length,
    index,
    cellX: Int32Array.from(cellX),
    cellY: Int32Array.from(cellY),
    sampleU: Float32Array.from(sampleU),
    sampleV: Float32Array.from(sampleV),
    area: Int32Array.from(area),
  };
}

/** Working resolution for a shape: enough pixels to resolve every cell edge. */
export function mosaicWorkSize(
  aspect: number,
  shape: MosaicShape,
): [number, number] {
  const [cellsX, cellsY] = mosaicCellCounts(aspect, shape);
  let width = Math.max(Math.round(cellsX * PIXELS_PER_CELL), 8);
  let height = Math.max(Math.round(cellsY * PIXELS_PER_CELL), 8);
  const longest = Math.max(width, height);
  if (longest > MAX_WORK_EDGE) {
    const scale = MAX_WORK_EDGE / longest;
    width = Math.max(Math.round(width * scale), 8);
    height = Math.max(Math.round(height * scale), 8);
  }
  return [width, height];
}

function createCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * CPU fallback for runtimes without WebGL2. Resolves each cell once per frame
 * and expands the result through the prebuilt pixel-to-cell map, so cost tracks
 * the cell count rather than the output resolution. Cells are rasterized into a
 * small working canvas that the caller scales up with nearest-neighbour, which
 * is why cell edges are blockier here than on the GPU path.
 */
class CpuMaskMosaicRenderer {
  private field: MosaicField | null = null;
  private signature = "";
  private coverage = new Float32Array(0);
  private red = new Float32Array(0);
  private green = new Float32Array(0);
  private blue = new Float32Array(0);
  private opacity = new Float32Array(0);
  private maskCanvas: HTMLCanvasElement | null = null;
  private plateCanvas: HTMLCanvasElement | null = null;
  private outputCanvas: HTMLCanvasElement | null = null;
  private pixels: ImageData | null = null;
  private maskSource: CanvasImageSource | null = null;
  private maskBlur = 0;
  private maskSourceWidth = 0;
  private maskDirty = true;
  private plateSource: CanvasImageSource | null = null;
  private plateDirty = true;
  private plateData: Uint8ClampedArray | null = null;
  // Bounds of the covered cells in cell space, so the sweep spans the painted
  // region rather than the whole composition.
  private boundsX: [number, number] = [0, 1];
  private boundsY: [number, number] = [0, 1];

  /**
   * Rebuild the cell field when the composition aspect or the shape changes.
   * Repeated calls with the same arguments are free.
   */
  configure(
    width: number,
    height: number,
    shape: MosaicShape = DEFAULT_MOSAIC_SHAPE,
  ): void {
    const aspect = width / Math.max(height, 1);
    const signature = [
      aspect.toFixed(4),
      shape.size,
      shape.aspect,
      shape.stretch[0],
      shape.stretch[1],
      shape.variation[0],
      shape.variation[1],
    ].join("|");
    if (signature === this.signature && this.field) return;
    const [workWidth, workHeight] = mosaicWorkSize(aspect, shape);
    const field = buildMosaicField(aspect, shape, workWidth, workHeight);
    this.signature = signature;
    this.field = field;
    this.coverage = new Float32Array(field.count);
    this.red = new Float32Array(field.count);
    this.green = new Float32Array(field.count);
    this.blue = new Float32Array(field.count);
    this.opacity = new Float32Array(field.count);
    this.maskCanvas = null;
    this.plateCanvas = null;
    this.outputCanvas = null;
    this.pixels = null;
    this.maskDirty = true;
    this.plateDirty = true;
  }

  /**
   * Bind the alpha mask. `blurPixels` and `sourceWidth` are in the mask's own
   * pixel space so the editor's edge-blur preview survives the downsample.
   */
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

  /** Mark the bound mask as repainted; the next paint() re-reads its coverage. */
  invalidateMask(): void {
    this.maskDirty = true;
  }

  /** Bind the image the cells sample. Pass null for tint-only cells. */
  setPlate(source: CanvasImageSource | null): void {
    if (this.plateSource === source) return;
    this.plateSource = source;
    this.plateDirty = true;
  }

  /**
   * Resolve every cell for `time` (seconds) and return the working canvas.
   * Blit it with image smoothing disabled to keep the cell edges crisp.
   * Returns null when the runtime has no usable 2D canvas.
   */
  paint(time: number, style: MosaicStyle): HTMLCanvasElement | null {
    const field = this.field;
    if (!field) return null;
    if (this.maskDirty && !this.sampleMask()) return null;
    if (this.plateDirty) this.samplePlate();
    const output = (this.outputCanvas ??= createCanvas(
      field.width,
      field.height,
    ));
    const context = output?.getContext("2d") ?? null;
    if (!output || !context) return null;
    const pixels = (this.pixels ??= context.createImageData(
      field.width,
      field.height,
    ));

    this.resolveCells(time, style);

    const data = pixels.data;
    const { index } = field;
    for (let pixel = 0, at = 0; pixel < index.length; pixel += 1, at += 4) {
      const slot = index[pixel];
      data[at] = this.red[slot];
      data[at + 1] = this.green[slot];
      data[at + 2] = this.blue[slot];
      data[at + 3] = this.opacity[slot];
    }
    context.putImageData(pixels, 0, 0);
    return output;
  }

  private resolveCells(time: number, style: MosaicStyle): void {
    const field = this.field;
    if (!field) return;
    const plate = this.plateData;
    const [tintR, tintG, tintB] = style.tint;
    const chromatic = style.chromatic / field.cellsX;
    const jitterScale = style.twinkleJitter / Math.max(field.cellsX, 1);
    const grainStep = Math.floor(time * 12);
    const glitchStep = Math.floor(time * 8);
    const sweepPhase =
      style.sweepStrength > 0 ? (time * style.sweepSpeed) % 1 : -1;
    const spanX = Math.max(this.boundsX[1] - this.boundsX[0], 1);
    const spanY = Math.max(this.boundsY[1] - this.boundsY[0], 1);
    const centreX = (this.boundsX[0] + this.boundsX[1]) / 2;
    const centreY = (this.boundsY[0] + this.boundsY[1]) / 2;

    for (let slot = 0; slot < field.count; slot += 1) {
      // A cell has to hold a real share of the pending area before it lights
      // up, so a coarse grid quantizes the region instead of spilling a cell
      // wide all the way around it.
      const coverage = smoothstep(0.18, 0.62, this.coverage[slot]);
      if (coverage <= 0) {
        this.opacity[slot] = 0;
        continue;
      }
      const idX = field.cellX[slot];
      const idY = field.cellY[slot];
      let alpha = style.alpha * coverage;

      // Dropout punches holes rather than painting black blocks: on an overlay
      // the plate showing through reads as a missing shard.
      if (
        style.dropout > 0 &&
        rand(idX * 5.31 + 17.23, idY * 5.31 + 91.7) > 1 - style.dropout
      ) {
        alpha *= 0.14;
      }

      let offsetU = 0;
      let offsetV = 0;
      let twinkle = 0;
      if (style.twinkleStrength > 0 && style.twinkleDensity > 0) {
        const seed = mosaicAnimationNoise(idX, idY, 0, 0);
        const clock = time * style.twinkleSpeed + seed * 37;
        const step = Math.floor(clock);
        const phase = clock - step;
        const gate =
          mosaicAnimationNoise(idX, idY, step, 1) >= 1 - style.twinkleDensity
            ? 1
            : 0;
        twinkle =
          gate * smoothstep(0, 0.18, phase) * (1 - smoothstep(0.45, 1, phase));
        if (twinkle > 0) {
          offsetU +=
            (mosaicAnimationNoise(idX, idY, step, 2) - 0.5) *
            twinkle *
            jitterScale;
          offsetV +=
            (mosaicAnimationNoise(idX, idY, step, 3) - 0.5) *
            twinkle *
            jitterScale;
        }
      }

      // Scanline tearing: a few cell rows slide sideways for one time step.
      if (style.glitch > 0 && mosaicAnimationNoise(0, idY, glitchStep, 4) > 0.94) {
        offsetU += (mosaicAnimationNoise(0, idY, glitchStep, 5) - 0.5) * style.glitch;
      }

      const u = field.sampleU[slot] + offsetU;
      const v = field.sampleV[slot] + offsetV;
      let red: number;
      let green: number;
      let blue: number;
      if (plate) {
        red = this.samplePlateChannel(plate, u + chromatic, v, 0);
        green = this.samplePlateChannel(plate, u, v, 1);
        blue = this.samplePlateChannel(plate, u - chromatic, v, 2);
      } else {
        // No plate to sample: light the tint per cell instead, otherwise the
        // field collapses into one flat blob and the cells stop reading.
        const shade = 0.5 + rand(idX * 3.7, idY * 3.7) * 0.55;
        red = tintR * shade;
        green = tintG * shade;
        blue = tintB * shade;
      }

      if (style.grain > 0) {
        const grain =
          (mosaicAnimationNoise(idX, idY, grainStep, 6) - 0.5) *
          2 *
          style.grain *
          255;
        red += grain;
        green += grain;
        blue += grain;
      }
      if (twinkle > 0) {
        const pulse =
          (mosaicAnimationNoise(idX, idY, grainStep, 7) - 0.5) *
          2 *
          style.twinkleStrength *
          twinkle *
          255;
        red += pulse;
        green += pulse;
        blue += pulse;
      }

      red = lerp(red, tintR, style.tintAmount) * style.brightness;
      green = lerp(green, tintG, style.tintAmount) * style.brightness;
      blue = lerp(blue, tintB, style.tintAmount) * style.brightness;

      if (sweepPhase >= 0) {
        // The shader's line pass: cells near the travelling wavefront flash in
        // a hue taken from their angle around the centre of the region.
        const metricX = (idX - this.boundsX[0]) / spanX;
        const metricY = (idY - this.boundsY[0]) / spanY;
        const shatter =
          (rand(idX * 13.13 + 71.17, idY * 13.13 + 19.31) - 0.5) * 0.12;
        const metric = clamp01((metricX + metricY) / 2 + shatter);
        const distance = Math.abs(metric - sweepPhase);
        const line =
          1 - smoothstep(style.sweepWidth * 0.5, style.sweepWidth, distance);
        if (line > 0) {
          // The shader takes its hue from the angle around the centre. Over a
          // mask-sized region that turns into per-cell confetti, so the hue
          // rides the wavefront instead and only leans on the angle for a
          // gradient across the band.
          const angle =
            Math.atan2(idY - centreY, idX - centreX) / (Math.PI * 2);
          const hue = metric * 0.3 + angle * 0.12 + time * 0.12;
          const [lineR, lineG, lineB] = hsvToRgb(hue - Math.floor(hue), 0.8, 1);
          const amount = line * style.sweepStrength;
          red = lerp(red, lineR, amount);
          green = lerp(green, lineG, amount);
          blue = lerp(blue, lineB, amount);
          alpha = Math.min(1, alpha + amount * 0.25 * style.alpha);
        }
      }

      this.red[slot] = clampInt(red, 0, 255);
      this.green[slot] = clampInt(green, 0, 255);
      this.blue[slot] = clampInt(blue, 0, 255);
      this.opacity[slot] = clampInt(alpha * 255, 0, 255);
    }
  }

  private samplePlateChannel(
    plate: Uint8ClampedArray,
    u: number,
    v: number,
    channel: number,
  ): number {
    const field = this.field;
    if (!field) return 0;
    const x = clampInt(Math.floor(u * field.width), 0, field.width - 1);
    const y = clampInt(Math.floor(v * field.height), 0, field.height - 1);
    return plate[(y * field.width + x) * 4 + channel];
  }

  private sampleMask(): boolean {
    const field = this.field;
    if (!field) return false;
    const canvas = (this.maskCanvas ??= createCanvas(
      field.width,
      field.height,
    ));
    const context =
      canvas?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (!canvas || !context) return false;
    context.clearRect(0, 0, field.width, field.height);
    if (this.maskSource) {
      const scale =
        this.maskSourceWidth > 0 ? field.width / this.maskSourceWidth : 1;
      const blur = this.maskBlur * scale;
      context.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
      context.drawImage(this.maskSource, 0, 0, field.width, field.height);
      context.filter = "none";
    }
    const data = context.getImageData(0, 0, field.width, field.height).data;
    this.coverage.fill(0);
    const { index } = field;
    for (
      let pixel = 0, alphaAt = 3;
      pixel < index.length;
      pixel += 1, alphaAt += 4
    ) {
      this.coverage[index[pixel]] += data[alphaAt];
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let slot = 0; slot < field.count; slot += 1) {
      const covered =
        this.coverage[slot] / (255 * Math.max(field.area[slot], 1));
      this.coverage[slot] = covered;
      if (covered <= 0) continue;
      if (field.cellX[slot] < minX) minX = field.cellX[slot];
      if (field.cellX[slot] > maxX) maxX = field.cellX[slot];
      if (field.cellY[slot] < minY) minY = field.cellY[slot];
      if (field.cellY[slot] > maxY) maxY = field.cellY[slot];
    }
    this.boundsX = maxX >= minX ? [minX, maxX] : [0, field.cellsX];
    this.boundsY = maxY >= minY ? [minY, maxY] : [0, field.cellsY];
    this.maskDirty = false;
    return true;
  }

  private samplePlate(): void {
    const field = this.field;
    if (!field) return;
    this.plateDirty = false;
    if (!this.plateSource) {
      this.plateData = null;
      return;
    }
    const canvas = (this.plateCanvas ??= createCanvas(
      field.width,
      field.height,
    ));
    const context =
      canvas?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (!canvas || !context) {
      this.plateData = null;
      return;
    }
    context.clearRect(0, 0, field.width, field.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(this.plateSource, 0, 0, field.width, field.height);
    this.plateData = context.getImageData(0, 0, field.width, field.height).data;
  }

  dispose(): void {
    // Nothing but ordinary garbage here; drop the largest buffers eagerly.
    this.field = null;
    this.signature = "";
    this.plateData = null;
    this.pixels = null;
  }
}

interface MosaicBackend {
  configure(width: number, height: number, shape: MosaicShape): void;
  setMask(
    source: CanvasImageSource | null,
    blurPixels: number,
    sourceWidth: number,
  ): void;
  invalidateMask(): void;
  setPlate(source: CanvasImageSource | null): void;
  paint(time: number, style: MosaicStyle): HTMLCanvasElement | null;
  dispose(): void;
}

/**
 * Draws an alpha mask as animated mosaic cells. Callers configure the shape,
 * hand over a mask (and optionally the plate the cells sample), then blit the
 * painted canvas wherever the mask belongs:
 *
 *   const cells = renderer.paint(seconds, INPAINT_MOSAIC_STYLE);
 *   if (cells) {
 *     context.imageSmoothingEnabled = renderer.smoothOutput;
 *     context.drawImage(cells, x, y, width, height);
 *   }
 *
 * Read `smoothOutput` after painting: it reports what the backend that actually
 * produced the frame needs, and a GPU context lost mid-session demotes the
 * renderer to the CPU path on the spot.
 */
export class MaskMosaicRenderer {
  private gpu: GlMaskMosaicRenderer | null = null;
  private cpu: CpuMaskMosaicRenderer | null = null;
  private started = false;
  // Kept so a backend created (or replaced) later can be brought up to date.
  private size: [number, number] = [1, 1];
  private shape: MosaicShape = DEFAULT_MOSAIC_SHAPE;
  private mask: {
    source: CanvasImageSource | null;
    blur: number;
    width: number;
  } = {
    source: null,
    blur: 0,
    width: 0,
  };
  private plate: CanvasImageSource | null = null;

  /** True while a GPU frame is being produced: its output wants smooth scaling. */
  get smoothOutput(): boolean {
    return this.gpu !== null;
  }

  configure(
    width: number,
    height: number,
    shape: MosaicShape = DEFAULT_MOSAIC_SHAPE,
  ): void {
    this.size = [width, height];
    this.shape = shape;
    this.backend().configure(width, height, shape);
  }

  setMask(
    source: CanvasImageSource | null,
    blurPixels = 0,
    sourceWidth = 0,
  ): void {
    this.mask = { source, blur: blurPixels, width: sourceWidth };
    this.backend().setMask(source, blurPixels, sourceWidth);
  }

  invalidateMask(): void {
    this.backend().invalidateMask();
  }

  setPlate(source: CanvasImageSource | null): void {
    this.plate = source;
    this.backend().setPlate(source);
  }

  paint(time: number, style: MosaicStyle): HTMLCanvasElement | null {
    const backend = this.backend();
    const painted = backend.paint(time, style);
    if (painted || backend !== this.gpu) return painted;
    // The GPU context went away. Rebuild on the CPU and finish this frame there.
    this.gpu = null;
    return this.backend().paint(time, style);
  }

  /**
   * Release the backend. A WebGL context is a scarce process-wide resource, so
   * components that mount and unmount repeatedly must call this on teardown.
   */
  dispose(): void {
    this.gpu?.dispose();
    this.cpu?.dispose();
    this.gpu = null;
    this.cpu = null;
    this.started = false;
  }

  private backend(): MosaicBackend {
    if (this.gpu) return this.gpu;
    if (this.cpu) return this.cpu;
    let backend: MosaicBackend;
    // One attempt at WebGL2 per renderer: a runtime that cannot give a context,
    // or lost one, will not do better on the next frame.
    const gpu = this.started ? null : GlMaskMosaicRenderer.create();
    this.started = true;
    if (gpu) {
      this.gpu = gpu;
      backend = gpu;
    } else {
      const cpu = new CpuMaskMosaicRenderer();
      this.cpu = cpu;
      backend = cpu;
    }
    backend.configure(this.size[0], this.size[1], this.shape);
    backend.setMask(this.mask.source, this.mask.blur, this.mask.width);
    backend.setPlate(this.plate);
    return backend;
  }
}
