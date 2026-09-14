import {
  buildMosaicField,
  INPAINT_MOSAIC_STYLE,
  mosaicCellCounts,
  mosaicWorkSize,
  rand,
  type MosaicField,
  type MosaicShape,
} from "./maskMosaic";
import { GlInpaintFocusRenderer, INPAINT_FOCUS_BOX_COUNT } from "./inpaintFocusGl";

interface FocusTarget {
  x: number;
  y: number;
  width: number;
  height: number;
  pitchX: number;
  pitchY: number;
}

interface FocusCell extends FocusTarget {
  column: number;
  row: number;
  columns: number;
  rows: number;
}

export interface FocusAnimation {
  target: FocusTarget;
  phase: number;
  seed: number;
}

interface ActiveFocus {
  target: FocusTarget;
  started: number;
  duration: number;
  seed: number;
}

/** Covered, non-dropout cells of the regular inpainting grid, in image UVs. */
export function inpaintFocusTargets(
  field: MosaicField,
  pixels: Uint8ClampedArray,
  countX: number,
  countY: number,
): FocusCell[] {
  const coverage = new Float32Array(field.count);
  for (let pixel = 0; pixel < field.index.length; pixel += 1) {
    coverage[field.index[pixel]] += pixels[pixel * 4 + 3] / 255;
  }
  const targets: FocusCell[] = [];
  const columns = Math.floor(countX);
  const rows = Math.floor(countY);
  const marginX = (1 - columns / countX) / 2;
  const marginY = (1 - rows / countY) / 2;
  for (let slot = 0; slot < field.count; slot += 1) {
    if (coverage[slot] / field.area[slot] < 0.35) continue;
    if (rand(field.cellX[slot] * 5.31 + 17.23, field.cellY[slot] * 5.31 + 91.7) > 1 - INPAINT_MOSAIC_STYLE.dropout) continue;
    // The shader extends the first/last cells into its centred grid margin.
    const x = field.cellX[slot] === 0 ? 0 : marginX + field.cellX[slot] / countX;
    const y = field.cellY[slot] === 0 ? 0 : marginY + field.cellY[slot] / countY;
    const right = field.cellX[slot] === columns - 1 ? 1 : marginX + (field.cellX[slot] + 1) / countX;
    const bottom = field.cellY[slot] === rows - 1 ? 1 : marginY + (field.cellY[slot] + 1) / countY;
    targets.push({
      x, y, width: right - x, height: bottom - y, pitchX: 1 / countX, pitchY: 1 / countY,
      column: field.cellX[slot], row: field.cellY[slot], columns, rows,
    });
  }
  return targets;
}

function smooth(from: number, to: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Random square block, up to half the larger grid axis and bounded by the image. */
export function mosaicFocusRegion(cell: FocusCell, selection: number): FocusTarget {
  const maximumSpan = Math.max(1, Math.min(Math.floor(Math.max(cell.columns, cell.rows) / 2), cell.columns, cell.rows));
  const span = 1 + Math.floor(selection * maximumSpan);
  const column = Math.max(0, Math.min(cell.columns - span, cell.column - Math.floor((span - 1) / 2)));
  const row = Math.max(0, Math.min(cell.rows - span, cell.row - Math.floor((span - 1) / 2)));
  const marginX = (1 - cell.columns * cell.pitchX) / 2;
  const marginY = (1 - cell.rows * cell.pitchY) / 2;
  const x = column === 0 ? 0 : marginX + column * cell.pitchX;
  const y = row === 0 ? 0 : marginY + row * cell.pitchY;
  const right = column + span === cell.columns ? 1 : marginX + (column + span) * cell.pitchX;
  const bottom = row + span === cell.rows ? 1 : marginY + (row + span) * cell.pitchY;
  return { x, y, width: right - x, height: bottom - y, pitchX: cell.pitchX, pitchY: cell.pitchY };
}

/** Prefer a cell of breathing room, then smaller or adjacent boxes on tight masks. */
export function selectFocusRegion(cells: readonly FocusCell[], occupied: readonly FocusTarget[], seed: number): FocusTarget | null {
  for (const gap of [1, 0]) {
    for (const size of [seed, 0]) {
      let best: FocusTarget | null = null;
      let bestScore = -Infinity;
      for (const cell of cells) {
        const candidate = mosaicFocusRegion(cell, size);
        if (occupied.some((other) => !(
          candidate.x + candidate.width + gap * cell.pitchX <= other.x + 1e-6 ||
          other.x + other.width + gap * cell.pitchX <= candidate.x + 1e-6 ||
          candidate.y + candidate.height + gap * cell.pitchY <= other.y + 1e-6 ||
          other.y + other.height + gap * cell.pitchY <= candidate.y + 1e-6
        ))) continue;
        const distance = occupied.length ? Math.min(...occupied.map((other) =>
          (candidate.x + candidate.width / 2 - other.x - other.width / 2) ** 2 +
          (candidate.y + candidate.height / 2 - other.y - other.height / 2) ** 2,
        )) : 0;
        const score = distance + rand(cell.column + seed * 31, cell.row + seed * 17) * 0.05;
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      if (best) return best;
    }
  }
  return null;
}

/** Four open feeder lines, each entering from an image edge with one elbow. */
export function mosaicEdgePaths(target: FocusTarget, width: number, height: number): [number, number][][] {
  const left = target.x * width;
  const top = target.y * height;
  const right = (target.x + target.width) * width;
  const bottom = (target.y + target.height) * height;
  const pitchX = target.pitchX * width;
  const pitchY = target.pitchY * height;
  const topX = left >= pitchX ? left - pitchX : right;
  const rightY = top >= pitchY ? top - pitchY : bottom;
  const bottomX = right + pitchX <= width ? right + pitchX : left;
  const leftY = bottom + pitchY <= height ? bottom + pitchY : top;
  return [
    [[topX, 0], [topX, top], [left, top]],
    [[width, rightY], [right, rightY], [right, top]],
    [[bottomX, height], [bottomX, bottom], [right, bottom]],
    [[0, leftY], [left, leftY], [left, bottom]],
  ];
}

export class InpaintFocusRenderer {
  private mask: CanvasImageSource | null = null;
  private signature = "";
  private targets: FocusCell[] = [];
  private dots: [number, number][] = [];
  private started = 0;
  private previousTime = 0;
  private active: ActiveFocus[] = [];
  private sequence = 0;
  private gpu: GlInpaintFocusRenderer | null = null;
  private gpuAttempted = false;

  draw(
    context: CanvasRenderingContext2D,
    mask: CanvasImageSource,
    width: number,
    height: number,
    shape: MosaicShape,
    time: number,
    pixelScale = 1,
  ): void {
    if (time <= 0) return;
    if (time < this.previousTime) {
      this.started = time;
      this.active = [];
      this.sequence = 0;
    }
    this.previousTime = time;
    const signature = [width, height, shape.size, shape.aspect, ...shape.stretch, ...shape.variation].join("|");
    if (this.mask !== mask || this.signature !== signature) {
      this.mask = mask;
      this.signature = signature;
      this.started = time;
      this.active = [];
      this.sequence = 0;
      this.targets = [];
      this.dots = [];
      const aspect = width / height;
      const [workWidth, workHeight] = mosaicWorkSize(aspect, shape);
      const probe = document.createElement("canvas");
      probe.width = workWidth;
      probe.height = workHeight;
      const sampling = probe.getContext("2d", { willReadFrequently: true });
      if (!sampling) return;
      sampling.drawImage(mask, 0, 0, workWidth, workHeight);
      const field = buildMosaicField(aspect, shape, workWidth, workHeight);
      const [baseX, baseY] = mosaicCellCounts(aspect, shape);
      const countX = Math.max(baseX / Math.max(shape.stretch[0], 1), 1);
      const countY = Math.max(baseY / Math.max(shape.stretch[1], 1), 1);
      this.targets = inpaintFocusTargets(field, sampling.getImageData(0, 0, workWidth, workHeight).data, countX, countY);
      const intersections = new Map<string, [number, number]>();
      for (const target of this.targets) {
        for (const x of [target.x, target.x + target.width]) {
          for (const y of [target.y, target.y + target.height]) {
            intersections.set(`${x.toFixed(6)}|${y.toFixed(6)}`, [x, y]);
          }
        }
      }
      this.dots = [...intersections.values()];
    }
    if (!this.targets.length) return;

    const previousCount = this.active.length;
    const initial = this.sequence === 0;
    this.active = this.active.filter((focus) => time < focus.started + focus.duration);
    if (initial || this.active.length < previousCount) {
      while (this.active.length < INPAINT_FOCUS_BOX_COUNT) {
        const seed = rand(this.sequence * 7.31 + 1, this.sequence * 19.7 + 8);
        const target = selectFocusRegion(this.targets, this.active.map((focus) => focus.target), seed);
        if (!target) break;
        this.active.push({ target, seed, duration: 3.6 + seed * 0.9, started: initial ? this.started : time });
        this.sequence += 1;
      }
    }
    const frames = this.active.map((focus) => ({
      target: focus.target, seed: focus.seed, phase: (time - focus.started) / focus.duration,
    })).filter((frame) => frame.phase > 0 && frame.phase < 1);
    if (!this.gpuAttempted) {
      this.gpuAttempted = true;
      this.gpu = GlInpaintFocusRenderer.create();
    }
    if (this.gpu) {
      const output = this.gpu.paint(width, height, pixelScale, this.dots, frames);
      if (output) {
        context.save();
        context.imageSmoothingEnabled = true;
        context.drawImage(output, 0, 0, width, height);
        context.restore();
        return;
      }
      this.gpu.dispose();
      this.gpu = null;
    }

    context.save();
    context.beginPath();
    context.rect(0, 0, width, height);
    context.clip();
    context.fillStyle = "rgba(221, 249, 161, 0.62)";
    context.beginPath();
    const dot = 2 * pixelScale;
    for (const [u, v] of this.dots) {
      context.rect(u * width - dot / 2, v * height - dot / 2, dot, dot);
    }
    context.fill();
    for (const { target, phase, seed } of frames) {
      this.drawTarget(context, target, width, height, phase, seed, pixelScale);
    }
    context.restore();
  }

  dispose(): void {
    this.mask = null;
    this.signature = "";
    this.targets = [];
    this.dots = [];
    this.previousTime = 0;
    this.active = [];
    this.sequence = 0;
    this.gpu?.dispose();
    this.gpu = null;
    this.gpuAttempted = false;
  }

  private drawTarget(
    context: CanvasRenderingContext2D,
    target: FocusTarget,
    width: number,
    height: number,
    phase: number,
    seed: number,
    pixelScale: number,
  ): void {
    const opacity = smooth(0, 0.1, phase) * (1 - smooth(0.82, 1, phase));
    const lock = smooth(0.67, 0.76, phase) * (1 - smooth(0.84, 1, phase));
    const left = target.x * width;
    const top = target.y * height;
    const cellWidth = target.width * width;
    const cellHeight = target.height * height;
    const right = left + cellWidth;
    const bottom = top + cellHeight;
    const arm = Math.min(14 * pixelScale, target.width * width * 0.24, target.height * height * 0.24);
    const color = seed > 0.78 ? "181, 237, 221" : "199, 241, 90";
    context.lineWidth = pixelScale;
    context.setLineDash([]);
    for (const [edge, points] of mosaicEdgePaths(target, width, height).entries()) {
      this.drawGuide(context, points, Math.max(0, phase - edge * 0.015), opacity, color, pixelScale);
    }

    const frame = opacity * (0.3 + lock * 0.7);
    for (const [x, y, sx, sy] of [[left, top, 1, 1], [right, top, -1, 1], [right, bottom, -1, -1], [left, bottom, 1, -1]]) {
      context.strokeStyle = `rgba(${color}, ${frame * 0.9})`;
      context.beginPath();
      context.moveTo(x + sx * arm, y);
      context.lineTo(x, y);
      context.lineTo(x, y + sy * arm);
      context.stroke();
      const dot = (2 + lock) * pixelScale;
      context.fillStyle = `rgba(239, 255, 211, ${opacity * lock})`;
      context.fillRect(x - dot / 2, y - dot / 2, dot, dot);
      context.strokeStyle = `rgba(${color}, ${lock * opacity * 0.6})`;
      context.beginPath();
      context.arc(x, y, (3 + (1 - lock) * 4) * pixelScale, 0, Math.PI * 2);
      context.stroke();
    }

    context.strokeStyle = `rgba(${color}, ${frame * 0.23})`;
    context.setLineDash([2 * pixelScale, 5 * pixelScale]);
    context.strokeRect(left, top, right - left, bottom - top);
    context.setLineDash([]);
    context.fillStyle = `rgba(${color}, ${lock * opacity * 0.065})`;
    context.fillRect(left, top, right - left, bottom - top);
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const cross = Math.min(3 * pixelScale, (right - left) * 0.15, (bottom - top) * 0.15);
    context.strokeStyle = `rgba(${color}, ${lock * opacity * 0.7})`;
    context.beginPath();
    context.moveTo(x - cross, y);
    context.lineTo(x + cross, y);
    context.moveTo(x, y - cross);
    context.lineTo(x, y + cross);
    context.stroke();
  }

  private drawGuide(
    context: CanvasRenderingContext2D,
    points: [number, number][],
    phase: number,
    opacity: number,
    color: string,
    pixelScale: number,
  ): void {
    const lengths = points.slice(1).map(([x, y], index) => Math.abs(x - points[index][0]) + Math.abs(y - points[index][1]));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const head = total * (1 - Math.pow(1 - Math.min(1, phase / 0.69), 1.4));
    const tail = Math.max(0, head - total * 0.7);
    const trailAlpha = opacity * (1 - smooth(0.78, 1, phase));

    context.strokeStyle = `rgba(${color}, ${trailAlpha * 0.12})`;
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) context.lineTo(x, y);
    context.stroke();
    let distance = 0;
    for (let index = 0; index < lengths.length; index += 1) {
      const length = lengths[index];
      const start = Math.max(tail, distance);
      const end = Math.min(head, distance + length);
      const [x, y] = points[index];
      const dx = points[index + 1][0] - x;
      const dy = points[index + 1][1] - y;
      if (end > start) {
        const fromX = x + dx * (start - distance) / length;
        const fromY = y + dy * (start - distance) / length;
        const toX = x + dx * (end - distance) / length;
        const toY = y + dy * (end - distance) / length;
        const gradient = context.createLinearGradient(fromX, fromY, toX, toY);
        gradient.addColorStop(0, `rgba(${color}, ${trailAlpha * smooth(tail, head, start)})`);
        gradient.addColorStop(1, `rgba(${color}, ${trailAlpha * smooth(tail, head, end)})`);
        context.strokeStyle = gradient;
        context.beginPath();
        context.moveTo(fromX, fromY);
        context.lineTo(toX, toY);
        context.stroke();
        if (end === head) {
          const dot = 3 * pixelScale;
          context.fillStyle = `rgba(239, 255, 211, ${trailAlpha})`;
          context.fillRect(toX - dot / 2, toY - dot / 2, dot, dot);
        }
      }
      distance += length;
    }

  }
}
