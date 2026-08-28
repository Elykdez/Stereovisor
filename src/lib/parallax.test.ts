import { backgroundTransform, clamp, demoCameraAt, fitCanvasDimensions, fitVideoDimensions, layerTransform, visibleLayers } from "./parallax";

describe("parallax transforms", () => {
  const camera = { x: 0.5, y: -0.25, zoom: 1.1, strength: 80 };

  it("moves near layers farther than distant layers", () => {
    const distant = layerTransform(camera, 0.2, 1000, 600);
    const near = layerTransform(camera, 0.9, 1000, 600);

    expect(Math.abs(near.x)).toBeGreaterThan(Math.abs(distant.x));
    expect(Math.abs(near.y)).toBeGreaterThan(Math.abs(distant.y));
    expect(near.scale).toBeGreaterThan(distant.scale);
  });

  it("keeps the background overscanned", () => {
    expect(backgroundTransform(camera).scale).toBeGreaterThan(camera.zoom);
  });

  it("shows the whole background before the camera moves", () => {
    expect(backgroundTransform({ ...camera, x: 0, y: 0, zoom: 1 }).scale).toBe(1);
  });

  it("clamps direct camera input", () => {
    expect(clamp(4, -1, 1)).toBe(1);
    expect(clamp(-4, -1, 1)).toBe(-1);
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
