import { backgroundTransform, clamp, demoCameraAt, depthOfFieldBlur, fitCanvasDimensions, fitVideoDimensions, layerTransform, renderedLayerBlur, visibleLayers } from "@/lib/parallax";

describe("parallax transforms", () => {
  const camera = { x: 0.5, y: -0.25, zoom: 1.1, strength: 80 };

  it("moves near layers farther than distant layers", () => {
    const distant = layerTransform(camera, 0.2, 1000, 600);
    const near = layerTransform(camera, 0.9, 1000, 600);

    expect(Math.abs(near.x)).toBeGreaterThan(Math.abs(distant.x));
    expect(Math.abs(near.y)).toBeGreaterThan(Math.abs(distant.y));
    expect(near.scale).toBeGreaterThan(distant.scale);
  });

  it("reverses depth-driven motion for every layer without changing its depth", () => {
    const inverse = { ...camera, inverseDepth: true };
    for (const depth of [0, 0.05, 0.25, 0.5, 0.95, 1]) {
      const expected = layerTransform(camera, 1 - depth, 1000, 600);
      const actual = layerTransform(inverse, depth, 1000, 600);
      expect(actual.x).toBeCloseTo(expected.x);
      expect(actual.y).toBeCloseTo(expected.y);
      expect(actual.scale).toBeCloseTo(expected.scale);
    }
    const near = layerTransform(inverse, 0.95, 1000, 600);
    const distant = layerTransform(inverse, 0.25, 1000, 600);
    expect(Math.abs(near.x)).toBeLessThan(Math.abs(distant.x));
    expect(depthOfFieldBlur({ ...inverse, depthOfField: 20, focusDepth: 0.95 }, 0.95)).toBe(0);
    expect(demoCameraAt(inverse, 0.25).inverseDepth).toBe(true);
  });

  it("moves the background most in inverse mode and covers the viewport at maximum travel", () => {
    for (const x of [-1, 0, 1]) {
      const inverse = { ...camera, x, y: -x, zoom: 1, strength: 100, inverseDepth: true };
      const background = backgroundTransform(inverse);
      const foreground = layerTransform(inverse, 1, 1, 1);
      expect(foreground.x).toBe(0);
      expect(foreground.y).toBe(0);
      expect(background.x).toBeCloseTo(-x * 0.15);
      expect(background.y).toBeCloseTo(x * 0.15);
      expect(background.scale / 2 - Math.abs(background.x)).toBeGreaterThanOrEqual(0.5);
      expect(background.scale / 2 - Math.abs(background.y)).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("offsets an anchored layer without dropping its parallax travel", () => {
    const plain = layerTransform(camera, 0.5, 1000, 600);
    const nudged = layerTransform(camera, 0.5, 1000, 600, { offsetX: 0.1, offsetY: -0.2 });

    expect(nudged.x - plain.x).toBeCloseTo(100, 6);
    expect(nudged.y - plain.y).toBeCloseTo(-120, 6);
    expect(nudged.scale).toBe(plain.scale);
  });

  it("clamps an out-of-range anchor instead of flinging the layer off stage", () => {
    const transform = layerTransform(camera, 0.5, 1000, 600, { offsetX: 9, offsetY: -9 });
    const limit = layerTransform(camera, 0.5, 1000, 600, { offsetX: 1, offsetY: -1 });

    expect(transform.x).toBeCloseTo(limit.x, 6);
    expect(transform.y).toBeCloseTo(limit.y, 6);
  });

  it("pulls a layer's bounds toward the composition center", () => {
    const left = layerTransform(
      { ...camera, x: 0, y: 0, centerPull: 0.5 },
      0.5,
      1000,
      600,
      { offsetX: 0, offsetY: 0, bounds: [100, 100, 300, 300] },
      [1000, 600],
    );
    const centered = layerTransform(
      { ...camera, x: 0, y: 0, centerPull: 1 },
      0.5,
      1000,
      600,
      { offsetX: 0, offsetY: 0, bounds: [100, 100, 300, 300] },
      [1000, 600],
    );

    expect(left.x).toBe(0);
    expect(centered.x).toBeCloseTo(300 * 1.1044, 4);
    expect(centered.y).toBeCloseTo(100 * 1.1044, 4);

    const farther = layerTransform(
      { ...camera, x: 0, y: 0, centerPull: 0 },
      0.5,
      1000,
      600,
      { offsetX: 0, offsetY: 0, bounds: [100, 100, 300, 300] },
      [1000, 600],
    );
    expect(farther.x).toBeCloseTo(-300 * 1.1044, 4);
    expect(farther.y).toBeCloseTo(-100 * 1.1044, 4);
  });

  it("scales the complete scene uniformly", () => {
    const scaled = { ...camera, sceneScale: 1.4 };

    expect(layerTransform(scaled, 0.5, 1000, 600).scale).toBeCloseTo(
      layerTransform(camera, 0.5, 1000, 600).scale * 1.4,
      6,
    );
    expect(backgroundTransform(scaled).scale).toBeCloseTo(
      backgroundTransform(camera).scale * 1.4,
      6,
    );
  });

  it("keeps the background overscanned", () => {
    expect(backgroundTransform(camera).scale).toBeGreaterThan(camera.zoom);
  });

  it("shows the whole background before the camera moves", () => {
    expect(backgroundTransform({ ...camera, x: 0, y: 0, zoom: 1 }).scale).toBe(1);
  });

  it("uses the zoom value directly without a hidden 1.1 base scale", () => {
    const neutral = { ...camera, x: 0, y: 0, zoom: 1, sceneScale: 1 };
    expect(backgroundTransform(neutral).scale).toBe(1);
    for (const depth of [0, 0.5, 1]) {
      expect(layerTransform(neutral, depth, 1000, 600).scale).toBe(1);
    }
    expect(backgroundTransform({ ...neutral, zoom: 1.1 }).scale).toBe(1.1);
    expect(backgroundTransform({ ...neutral, zoom: 1.25 }).scale).toBe(1.25);
  });

  it("clamps direct camera input", () => {
    expect(clamp(4, -1, 1)).toBe(1);
    expect(clamp(-4, -1, 1)).toBe(-1);
  });

  it("derives blur from focus distance and keeps the layer correction additive", () => {
    const lens = { ...camera, depthOfField: 20, focusDepth: 0.8 };

    expect(depthOfFieldBlur(lens, 0.8)).toBe(0);
    expect(depthOfFieldBlur(lens, 0.3)).toBeCloseTo(10);
    expect(renderedLayerBlur(lens, 0.3, 3)).toBeCloseTo(13);
    expect(renderedLayerBlur(lens, 0.3, -4)).toBeCloseTo(6);
    expect(renderedLayerBlur(lens, 0.3, -20)).toBe(0);
    expect(renderedLayerBlur(camera, 0.3, 4)).toBe(4);
  });

  it("sorts only visible layers from far to near", () => {
    const layers = [
      { id: "near", visible: true, depth: 0.9, order: 0 },
      { id: "hidden", visible: false, depth: 0.1, order: 0 },
      { id: "far", visible: true, depth: 0.2, order: 1 }
    ];
    expect(visibleLayers(layers).map((layer) => layer.id)).toEqual(["far", "near"]);
  });

  it("returns the demo camera to its starting position after one loop", () => {
    expect(demoCameraAt(camera, 0)).toEqual({ ...camera, x: 0, y: 0 });
    expect(demoCameraAt(camera, 1).x).toBeCloseTo(0);
    expect(demoCameraAt(camera, 1).y).toBeCloseTo(0);
  });

  it("applies the configured speed and movement amounts to demo motion", () => {
    const motion = { speed: 2, horizontalAmount: 0.4, verticalAmount: 0.1 };
    const frame = demoCameraAt(camera, 0.0625, motion);

    expect(frame.x).toBeCloseTo(Math.SQRT1_2 * 0.4);
    expect(frame.y).toBeCloseTo(0.1);
  });

  it("fits even video dimensions within the export limit", () => {
    expect(fitVideoDimensions(4000, 3000)).toEqual([1280, 960]);
    expect(fitVideoDimensions(601, 901)).toEqual([600, 900]);
    expect(fitVideoDimensions(640, 480)).toEqual([640, 480]);
  });

  it("contains a portrait canvas within both stage dimensions", () => {
    const [width, height] = fitCanvasDimensions(858, 707, 720, 1080);

    expect(width).toBeCloseTo(471.333, 3);
    expect(height).toBeCloseTo(707, 3);
    expect(width).toBeLessThanOrEqual(858);
    expect(height).toBeLessThanOrEqual(707);
    expect(width / height).toBeCloseTo(720 / 1080, 6);
  });
});
