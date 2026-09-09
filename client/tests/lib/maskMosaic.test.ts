import {
  buildMosaicField,
  DEFAULT_MOSAIC_SHAPE,
  hsvToRgb,
  INPAINT_MOSAIC_STYLE,
  MaskMosaicRenderer,
  MOSAIC_RESOLVE_SIZES,
  mosaicCellCounts,
  mosaicShapeForProgress,
  mosaicWorkSize,
  rand,
  type MosaicShape
} from "@/lib/maskMosaic";

const grid: MosaicShape = { ...DEFAULT_MOSAIC_SHAPE, size: 8 };

describe("mosaic cell noise", () => {
  it("stays deterministic inside the unit range", () => {
    for (const [x, y] of [[0, 0], [3, 17], [-4, 9.5], [120.25, -3.75]]) {
      const value = rand(x, y);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(rand(x, y)).toBe(value);
    }
    expect(rand(1, 2)).not.toBe(rand(2, 1));
  });

  it("converts hue sweeps to saturated rainbow channels", () => {
    const [red, green, blue] = hsvToRgb(0, 0.8, 1);
    expect(red).toBeCloseTo(255, 5);
    expect(green).toBeLessThan(red);
    expect(blue).toBeLessThan(red);
    // Zero saturation stays neutral whatever the hue is.
    expect(hsvToRgb(0.42, 0, 1)).toEqual([255, 255, 255]);
  });
});

describe("mosaic cell counts", () => {
  it("squares cells against the axis chosen by the aspect blend", () => {
    const shape: MosaicShape = { ...grid, size: 10 };
    const aspect = 2;

    const [widthCellsX, widthCellsY] = mosaicCellCounts(aspect, { ...shape, aspect: 0 });
    // Width-based squares: a cell is 1/10 of the width, and just as tall.
    expect(widthCellsX).toBeCloseTo(10, 6);
    expect((1 / widthCellsY) / aspect).toBeCloseTo(1 / widthCellsX, 6);

    const [heightCellsX, heightCellsY] = mosaicCellCounts(aspect, { ...shape, aspect: 1 });
    expect(heightCellsY).toBeCloseTo(10, 6);
    expect((1 / heightCellsY) / aspect).toBeCloseTo(1 / heightCellsX, 6);

    // The midpoint keeps the requested count on both axes, so cells take the
    // shape of the quad instead of staying square.
    expect(mosaicCellCounts(aspect, { ...shape, aspect: 0.5 })).toEqual([10, 10]);
  });

  it("resolves from huge blocks to the shape's own cells as a job advances", () => {
    const queued = mosaicShapeForProgress(0);
    const half = mosaicShapeForProgress(50);
    const done = mosaicShapeForProgress(100);

    expect(queued.size).toBe(MOSAIC_RESOLVE_SIZES[0]);
    expect(queued.size).toBeLessThan(half.size);
    expect(half.size).toBeLessThan(done.size);
    // The last step is the shape itself, so nothing overshoots its cell count.
    expect(done).toEqual(DEFAULT_MOSAIC_SHAPE);
    expect(mosaicShapeForProgress(140).size).toBe(DEFAULT_MOSAIC_SHAPE.size);
    // Everything but the count is carried through untouched.
    expect(mosaicShapeForProgress(0, { ...grid, size: 40 })).toMatchObject({
      aspect: grid.aspect,
      stretch: grid.stretch,
      variation: grid.variation
    });
    // A shape coarser than the ladder has fewer steps and never gets finer.
    expect(mosaicShapeForProgress(0, { ...grid, size: 8 }).size).toBe(MOSAIC_RESOLVE_SIZES[0]);
    expect(mosaicShapeForProgress(90, { ...grid, size: 8 }).size).toBe(8);
  });

  it("sizes the working canvas from the cell counts", () => {
    const [width, height] = mosaicWorkSize(2, { ...grid, size: 10 });
    expect(width).toBe(80);
    expect(height).toBe(40);
    // A dense shape is capped rather than allowed to grow without bound.
    const [cappedWidth, cappedHeight] = mosaicWorkSize(1, { ...grid, size: 400 });
    expect(Math.max(cappedWidth, cappedHeight)).toBeLessThanOrEqual(512);
  });
});

describe("mosaic field", () => {
  it("maps every pixel of a regular grid to its own cell", () => {
    const field = buildMosaicField(1, grid, 32, 32);

    expect(field.count).toBe(8 * 8);
    expect(field.index).toHaveLength(32 * 32);
    expect(Array.from(field.area).every((area) => area === 16)).toBe(true);
    // Cells sample their own centre, so the first cell reads at 1/16 of the axis.
    expect(field.sampleU[field.index[0]]).toBeCloseTo(1 / 16, 6);
    expect(field.sampleV[field.index[0]]).toBeCloseTo(1 / 16, 6);
    // Opposite corners land in different cells with distinct sample points.
    const last = field.index[field.index.length - 1];
    expect(last).not.toBe(field.index[0]);
    expect(field.sampleU[last]).toBeCloseTo(15 / 16, 6);
  });

  it("stays inert on a runtime with neither WebGL2 nor a 2D canvas", () => {
    // A renderer that can obtain no drawing context at all has to bow out
    // quietly and let the caller fall back to its flat overlay.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const renderer = new MaskMosaicRenderer();
    renderer.configure(200, 100);
    renderer.setMask(document.createElement("canvas"), 4, 200);
    renderer.setPlate(document.createElement("canvas"));
    renderer.invalidateMask();

    expect(renderer.paint(1.5, INPAINT_MOSAIC_STYLE)).toBeNull();
    // Without a GPU frame the caller must scale the result with nearest
    // neighbour, so this has to stay false.
    expect(renderer.smoothOutput).toBe(false);
    expect(() => renderer.dispose()).not.toThrow();
    expect(renderer.paint(1.5, INPAINT_MOSAIC_STYLE)).toBeNull();
    getContext.mockRestore();
  });

  it("stretches cells per row when variation is requested", () => {
    const stretched = buildMosaicField(1, { ...grid, stretch: [3, 1], variation: [1, 0] }, 48, 48);
    const rows = new Map<number, Set<number>>();
    for (let pixel = 0; pixel < stretched.index.length; pixel += 1) {
      const row = Math.floor(pixel / 48);
      const cells = rows.get(row) ?? new Set<number>();
      cells.add(stretched.index[pixel]);
      rows.set(row, cells);
    }
    const widths = new Set(Array.from(rows.values()).map((cells) => cells.size));

    // Randomized stretch means rows disagree on how many cells they hold.
    expect(widths.size).toBeGreaterThan(1);
  });
});
