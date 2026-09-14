import { InpaintFocusRenderer, inpaintFocusTargets, mosaicEdgePaths, mosaicFocusRegion, selectFocusRegion, type FocusAnimation } from "@/lib/inpaintFocus";
import { GlInpaintFocusRenderer, INPAINT_FOCUS_BOX_COUNT } from "@/lib/inpaintFocusGl";
import { buildMosaicField, mosaicCellCounts, mosaicShapeForProgress, mosaicWorkSize } from "@/lib/maskMosaic";

describe("inpainting focus grid", () => {
  const anchor = { x: 0.4, y: 0.375, width: 0.1, height: 0.125, pitchX: 0.1, pitchY: 0.125, column: 4, row: 3, columns: 10, rows: 8 };

  beforeEach(() => {
    vi.spyOn(GlInpaintFocusRenderer, "create").mockReturnValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  function coveredCells(width = 800, height = 600) {
    const shape = mosaicShapeForProgress(72);
    const [workWidth, workHeight] = mosaicWorkSize(width / height, shape);
    const field = buildMosaicField(width / height, shape, workWidth, workHeight);
    const [countX, countY] = mosaicCellCounts(width / height, shape);
    return inpaintFocusTargets(field, new Uint8ClampedArray(workWidth * workHeight * 4).fill(255), countX, countY);
  }

  function expectSeparated(frames: readonly FocusAnimation[]) {
    for (let index = 0; index < frames.length; index += 1) {
      const a = frames[index].target;
      for (const { target: b } of frames.slice(index + 1)) {
        expect(a.x + a.width <= b.x + 1e-6 || b.x + b.width <= a.x + 1e-6 ||
          a.y + a.height <= b.y + 1e-6 || b.y + b.height <= a.y + 1e-6).toBe(true);
      }
    }
  }

  it.each([1, 2, 3])("selects %s simultaneous regions with space between them", (count) => {
    const cells = coveredCells();
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const frames: FocusAnimation[] = [];
      for (let lane = 0; lane < count; lane += 1) {
        const target = selectFocusRegion(cells, frames.map((frame) => frame.target), ((cycle * 3 + lane) % 11) / 11);
        expect(target).not.toBeNull();
        frames.push({ target: target!, seed: 0, phase: 0.5 });
      }
      expectSeparated(frames);
      for (const { target: a } of frames) {
        for (const { target: b } of frames) {
          if (a === b) continue;
          expect(a.x + a.width + a.pitchX <= b.x + 1e-6 || b.x + b.width + a.pitchX <= a.x + 1e-6 ||
            a.y + a.height + a.pitchY <= b.y + 1e-6 || b.y + b.height + a.pitchY <= a.y + 1e-6).toBe(true);
        }
      }
    }
  });

  it("shrinks boxes on tight masks and stops when there is no separate region", () => {
    const cell = { ...anchor, column: 0, row: 0, columns: 2, rows: 1, pitchX: 0.5, pitchY: 1 };
    const cells = [cell, { ...cell, column: 1 }];
    const first = selectFocusRegion(cells, [], 0.9)!;
    const second = selectFocusRegion(cells, [first], 0.9)!;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expectSeparated([first, second].map((target) => ({ target, seed: 0, phase: 0.5 })));
    expect(selectFocusRegion(cells, [first, second], 0.9)).toBeNull();
    expect(selectFocusRegion([], [], 0.5)).toBeNull();
  });

  it("draws through the GPU with stable, separated targets and falls back after context loss", () => {
    const sampling = {
      drawImage: vi.fn(),
      getImageData: vi.fn((x: number, y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4).fill(255),
      })),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(sampling as unknown as CanvasRenderingContext2D);
    const output = document.createElement("canvas");
    const paint = vi.fn((_width: number, _height: number, _scale: number, _dots: readonly [number, number][], _frames: readonly FocusAnimation[]) => output as HTMLCanvasElement | null);
    const dispose = vi.fn();
    vi.mocked(GlInpaintFocusRenderer.create).mockReturnValue({ paint, dispose } as unknown as GlInpaintFocusRenderer);
    const context = {
      save: vi.fn(), restore: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      fill: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(), createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    } as unknown as CanvasRenderingContext2D;
    const renderer = new InpaintFocusRenderer();
    const mask = document.createElement("canvas");
    const shape = mosaicShapeForProgress(72);
    renderer.draw(context, mask, 800, 600, shape, 1);
    renderer.draw(context, mask, 800, 600, shape, 1.5);
    const initial = paint.mock.lastCall![4];
    expect(initial).toHaveLength(INPAINT_FOCUS_BOX_COUNT);
    renderer.draw(context, mask, 800, 600, shape, 2);
    expect(paint.mock.lastCall![4].map((frame) => frame.target)).toEqual(initial.map((frame) => frame.target));
    for (let time = 2.2; time < 25; time += 0.2) {
      renderer.draw(context, mask, 800, 600, shape, time);
      const frames = paint.mock.lastCall![4];
      expect(frames.length).toBeLessThanOrEqual(INPAINT_FOCUS_BOX_COUNT);
      expectSeparated(frames);
    }
    expect(context.drawImage).toHaveBeenCalledWith(output, 0, 0, 800, 600);
    expect(context.stroke).not.toHaveBeenCalled();
    expect(sampling.getImageData).toHaveBeenCalledTimes(1);
    paint.mockReturnValue(null);
    renderer.draw(context, mask, 800, 600, shape, 25.1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(context.stroke).toHaveBeenCalled();
    renderer.draw(context, mask, 800, 600, shape, 25.2);
    expect(GlInpaintFocusRenderer.create).toHaveBeenCalledTimes(1);
    renderer.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    renderer.draw(context, mask, 800, 600, shape, 0.01);
    expect(GlInpaintFocusRenderer.create).toHaveBeenCalledTimes(2);
    renderer.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2, 3, 4, 5])("selects a block spanning %s cells per side with corners on the live grid", (span) => {
    const target = mosaicFocusRegion(anchor, (span - 0.5) / 5);
    expect(target.width / target.pitchX).toBeCloseTo(span, 6);
    expect(target.height / target.pitchY).toBeCloseTo(span, 6);
    expect(target.x).toBeLessThanOrEqual(anchor.x);
    expect(target.y).toBeLessThanOrEqual(anchor.y);
    expect(target.x + target.width).toBeGreaterThanOrEqual(anchor.x + anchor.width);
    expect(target.y + target.height).toBeGreaterThanOrEqual(anchor.y + anchor.height);
  });

  it("enters from four image edges with at most one bend and ends at the block corners", () => {
    const target = mosaicFocusRegion(anchor, 0.5);
    const paths = mosaicEdgePaths(target, 800, 600);
    expect(paths[0][0][1]).toBe(0);
    expect(paths[1][0][0]).toBe(800);
    expect(paths[2][0][1]).toBe(600);
    expect(paths[3][0][0]).toBe(0);
    const left = target.x * 800;
    const top = target.y * 600;
    const right = (target.x + target.width) * 800;
    const bottom = (target.y + target.height) * 600;
    expect(paths.map((path) => path.at(-1))).toEqual([[left, top], [right, top], [right, bottom], [left, bottom]]);
    for (const points of paths) {
      expect(points).toHaveLength(3);
      expect(points[0][0] === points[1][0] || points[0][1] === points[1][1]).toBe(true);
      expect(points[1][0] === points[2][0] || points[1][1] === points[2][1]).toBe(true);
    }
    expect(mosaicEdgePaths(target, 1600, 1200)).toEqual(paths.map((path) => path.map(([x, y]) => [x * 2, y * 2])));
  });

  it.each([[0, 0], [9, 0], [0, 7], [9, 7]])("keeps a large block and its elbows inside the image near cell %s, %s", (column, row) => {
    const target = mosaicFocusRegion({ ...anchor, column, row }, 0.7);
    for (const path of mosaicEdgePaths(target, 800, 600)) {
      for (const [x, y] of path) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(800);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(600);
      }
    }
    expect(target.width / target.pitchX).toBeCloseTo(4, 6);
    expect(target.height / target.pitchY).toBeCloseTo(4, 6);
    const narrow = mosaicFocusRegion({ ...anchor, columns: 2, rows: 1, column: 0, row: 0, pitchX: 0.5, pitchY: 1 }, 0.999);
    expect(narrow.width).toBe(0.5);
    expect(narrow.height).toBe(1);
  });

  it.each([[6, 4, 3], [52, 39, 26], [20, 52, 20], [52, 6, 6]])("updates the target-size range with a %s by %s grid", (columns, rows, maximumSpan) => {
    const cell = { ...anchor, column: 0, row: 0, columns, rows, pitchX: 1 / columns, pitchY: 1 / rows };
    const small = mosaicFocusRegion(cell, 0);
    const large = mosaicFocusRegion(cell, 0.999);
    expect(small.width / cell.pitchX).toBeCloseTo(1, 6);
    expect(small.height / cell.pitchY).toBeCloseTo(1, 6);
    expect(large.width / cell.pitchX).toBeCloseTo(maximumSpan, 6);
    expect(large.height / cell.pitchY).toBeCloseTo(maximumSpan, 6);
    expect(large.x + large.width).toBeLessThanOrEqual(1);
    expect(large.y + large.height).toBeLessThanOrEqual(1);
  });

  it.each([[800, 600], [600, 800], [1000, 563]])("aligns dots with the mosaic at %s x %s, including the outer margins", (width, height) => {
    for (const progress of [0, 34, 72, 100]) {
      const shape = mosaicShapeForProgress(progress);
      const [countX, countY] = mosaicCellCounts(width / height, shape);
      const [workWidth, workHeight] = mosaicWorkSize(width / height, shape);
      const field = buildMosaicField(width / height, shape, workWidth, workHeight);
      const pixels = new Uint8ClampedArray(workWidth * workHeight * 4).fill(255);
      const targets = inpaintFocusTargets(field, pixels, countX, countY);
      expect(targets.length).toBeGreaterThan(0);
      const marginX = (1 - Math.floor(countX) / countX) / 2;
      const marginY = (1 - Math.floor(countY) / countY) / 2;
      for (const target of targets) {
        expect(target.x).toBeGreaterThanOrEqual(0);
        expect(target.y).toBeGreaterThanOrEqual(0);
        expect(target.x + target.width).toBeLessThanOrEqual(1);
        expect(target.y + target.height).toBeLessThanOrEqual(1);
        for (const x of [target.x, target.x + target.width]) {
          if (x === 0 || x === 1) continue;
          const column = (x - marginX) * countX;
          expect(column).toBeCloseTo(Math.round(column), 4);
        }
        for (const y of [target.y, target.y + target.height]) {
          if (y === 0 || y === 1) continue;
          const row = (y - marginY) * countY;
          expect(row).toBeCloseTo(Math.round(row), 4);
        }
      }
    }
  });

  it("only targets covered cells, ignoring RGB in transparent pixels", () => {
    const shape = mosaicShapeForProgress(0);
    const field = buildMosaicField(1, shape, 48, 48);
    const pixels = new Uint8ClampedArray(48 * 48 * 4).fill(255);
    for (let pixel = 0; pixel < field.index.length; pixel += 1) pixels[pixel * 4 + 3] = 0;
    expect(inpaintFocusTargets(field, pixels, 6, 6)).toEqual([]);
    for (let pixel = 0; pixel < field.index.length; pixel += 1) {
      if (field.cellX[field.index[pixel]] === 2) pixels[pixel * 4 + 3] = 255;
    }
    const targets = inpaintFocusTargets(field, pixels, 6, 6);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.x).toBeCloseTo(2 / 6, 6);
      expect(target.width).toBeCloseTo(1 / 6, 6);
    }
  });

  it("caches coverage, stays idle with a stopped clock, and releases the cached mask", () => {
    const getImageData = vi.fn((x: number, y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    }));
    const sampling = { drawImage: vi.fn(), getImageData };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(sampling as unknown as CanvasRenderingContext2D);
    const context = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      fill: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
      setLineDash: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), arc: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    } as unknown as CanvasRenderingContext2D;
    const renderer = new InpaintFocusRenderer();
    const mask = document.createElement("canvas");
    const coarse = mosaicShapeForProgress(0);
    const fine = mosaicShapeForProgress(80);
    renderer.draw(context, mask, 800, 600, coarse, 0);
    expect(getImageData).not.toHaveBeenCalled();
    expect(context.save).not.toHaveBeenCalled();
    renderer.draw(context, mask, 800, 600, coarse, 1);
    for (let time = 1.1; time < 9; time += 0.1) renderer.draw(context, mask, 800, 600, coarse, time);
    expect(context.strokeRect).toHaveBeenCalled();
    expect(getImageData).toHaveBeenCalledTimes(1);
    renderer.draw(context, mask, 800, 600, fine, 10);
    expect(getImageData).toHaveBeenCalledTimes(2);
    renderer.draw(context, mask, 400, 300, fine, 11);
    expect(getImageData).toHaveBeenCalledTimes(3);
    renderer.draw(context, document.createElement("canvas"), 400, 300, fine, 12);
    expect(getImageData).toHaveBeenCalledTimes(4);
    renderer.dispose();
    renderer.draw(context, mask, 400, 300, fine, 13);
    expect(getImageData).toHaveBeenCalledTimes(5);
    vi.mocked(context.stroke).mockClear();
    renderer.draw(context, mask, 400, 300, fine, 0.01);
    expect(context.stroke).not.toHaveBeenCalled();
    renderer.draw(context, mask, 400, 300, fine, 1.1);
    expect(context.stroke).toHaveBeenCalled();
    expect(getImageData).toHaveBeenCalledTimes(5);
    getContext.mockRestore();
  });
});
