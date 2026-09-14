import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { drawInpaintComposition, drawScene, SceneCanvas, type SceneCanvasHandle } from "@/components/SceneCanvas";
import { loadServiceImage } from "@/lib/api";
import { GlInpaintForegroundRenderer } from "@/lib/inpaintForegroundGl";
import { InpaintFocusRenderer } from "@/lib/inpaintFocus";
import { MaskMosaicRenderer } from "@/lib/maskMosaic";
import type { SceneProject } from "@/types";

vi.mock("@/lib/api", () => ({ loadServiceImage: vi.fn() }));

const project: SceneProject = {
  id: "review-blur", width: 200, height: 100, sourceUrl: "/source.png", backgroundUrl: null,
  unionMaskUrl: null, depthMapUrl: null, backgroundPrompt: null, inpaintProvider: null,
  vramPeaksMb: {}, engine: "preview",
  layers: [{
    id: "subject", name: "Subject", cutoutUrl: "/subject.png", maskUrl: "/mask.png",
    proposalMaskUrl: null, refinementState: "rough", confirmed: false, maskRevision: 0,
    depth: 0.8, order: 0, offsetX: 0, offsetY: 0, selected: true, visible: true,
    bounds: [0, 0, 200, 100], kind: "instance", confidence: 1, feather: 0,
  }],
};
const camera = { x: 0, y: 0, zoom: 1, strength: 68 };
const finalCamera = { x: 0.5, y: 0.2, zoom: 1.1, strength: 30 };

function props(overrides: Partial<ComponentProps<typeof SceneCanvas>> = {}): ComponentProps<typeof SceneCanvas> {
  return {
    project, camera, reviewingSource: true, interactive: true, processing: false,
    showInpaintMask: false, maskEditor: null, showCompositionWhileMaskEditing: false,
    brushMode: "add", brushSize: 48, maskBlurRadius: 0, anchorLayerId: null,
    onLayerAnchorChange: vi.fn(), onMaskDirtyChange: vi.fn(), onMaskHistoryChange: vi.fn(),
    onMaskReadyChange: vi.fn(), onMaskError: vi.fn(), onCameraChange: vi.fn(),
    ...overrides,
  };
}

describe("mask review drag blur", () => {
  let now: number;
  let nextFrame: number;
  let frames: Map<number, FrameRequestCallback>;
  let draws: { canvas: HTMLCanvasElement; image: CanvasImageSource; alpha: number; filter: string }[];
  let contexts: WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>;

  beforeEach(() => {
    now = 0;
    nextFrame = 0;
    frames = new Map();
    draws = [];
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
    vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
    vi.mocked(loadServiceImage).mockImplementation(async (src) => Object.assign(new Image(), { src }));
    contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      if (!contexts.has(this)) {
        const canvas = this;
        contexts.set(canvas, {
          clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }),
          putImageData: vi.fn(),
          filter: "none", globalAlpha: 1,
          drawImage(this: CanvasRenderingContext2D, image: CanvasImageSource) {
            draws.push({ canvas, image, alpha: this.globalAlpha, filter: this.filter });
          },
        } as unknown as CanvasRenderingContext2D);
      }
      return contexts.get(this)!;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 200, height: 100, top: 0, right: 200, bottom: 100, left: 0, toJSON: () => ({}),
    });
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
    HTMLCanvasElement.prototype.hasPointerCapture = vi.fn(() => true);
    HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(loadServiceImage).mockReset();
    delete window.stereovisor;
  });

  function advance(milliseconds: number): void {
    act(() => {
      now += milliseconds;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(now));
    });
  }

  async function mount(overrides: Partial<ComponentProps<typeof SceneCanvas>> = {}) {
    const input = props(overrides);
    const ref = createRef<SceneCanvasHandle>();
    const view = render(<SceneCanvas ref={ref} {...input} />);
    const canvas = view.container.querySelector("canvas")!;
    await waitFor(() => expect(canvas.parentElement).toHaveAttribute("aria-busy", "false"));
    return { ...view, canvas, input, ref };
  }

  function drag(canvas: HTMLCanvasElement): void {
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 75 });
  }

  function blurDraws(canvas: HTMLCanvasElement) {
    return draws.filter((draw) => draw.canvas === canvas && draw.image instanceof HTMLCanvasElement);
  }

  function expectAligned(canvas: HTMLCanvasElement): void {
    const context = contexts.get(canvas)!;
    expect(vi.mocked(context.translate).mock.calls.slice(-2)).toEqual([[100, 50], [100, 50]]);
    expect(vi.mocked(context.scale).mock.calls.slice(-2)).toEqual([[1, 1], [1, 1]]);
  }

  it("aligns cutouts with the original image despite the final camera defaults", async () => {
    const { canvas, input } = await mount({ camera: finalCamera });
    expectAligned(canvas);
    expect(input.onCameraChange).not.toHaveBeenCalled();
  });

  it("uses inverse depth during a step 3 drag and stays aligned before and after it", async () => {
    const { canvas, input, rerender } = await mount({ camera: { ...finalCamera, inverseDepth: true } });
    expectAligned(canvas);
    drag(canvas);
    const draggedCamera = vi.mocked(input.onCameraChange).mock.calls.at(-1)![0];
    expect(draggedCamera.inverseDepth).toBe(true);
    rerender(<SceneCanvas {...input} camera={draggedCamera} />);
    advance(160);
    const translations = vi.mocked(contexts.get(canvas)!.translate).mock.calls.slice(-2);
    expect(Math.abs(translations[1][0] - 100)).toBeLessThan(Math.abs(translations[0][0] - 100));
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    advance(160);
    expectAligned(canvas);
  });

  it.each([false, true])("preserves the camera for a built scene with reviewingSource=%s", async (reviewingSource) => {
    const { canvas } = await mount({
      camera: finalCamera, reviewingSource, project: { ...project, backgroundUrl: "/background.png" },
    });
    const context = contexts.get(canvas)!;
    const translations = vi.mocked(context.translate).mock.calls.slice(-2);
    expect(translations[0]).not.toEqual(translations[1]);
    expect(vi.mocked(context.scale).mock.calls.at(-1)?.[0]).toBeGreaterThan(1.1);
  });

  it.each([
    { backgroundUrl: null },
    { backgroundUrl: "/background.png" },
    { backgroundUrl: "/background.png", pendingInpaintMaskUrl: "/pending-mask.png" },
    { backgroundUrl: null, reduceEffects: true },
    { backgroundUrl: null, reduceMotion: true },
  ])("keeps the plate, mosaic, and cutouts aligned throughout inpainting: %j", async ({ backgroundUrl, ...options }) => {
    const mosaic = document.createElement("canvas");
    const foreground = document.createElement("canvas");
    vi.spyOn(MaskMosaicRenderer.prototype, "configure").mockImplementation(() => {});
    vi.spyOn(MaskMosaicRenderer.prototype, "setMask").mockImplementation(() => {});
    vi.spyOn(MaskMosaicRenderer.prototype, "setPlate").mockImplementation(() => {});
    const paintMosaic = vi.spyOn(MaskMosaicRenderer.prototype, "paint").mockReturnValue(mosaic);
    vi.spyOn(InpaintFocusRenderer.prototype, "draw").mockImplementation(() => {});
    vi.spyOn(GlInpaintForegroundRenderer, "create").mockReturnValue({
      paint: vi.fn(() => foreground), dispose: vi.fn(),
    } as unknown as GlInpaintForegroundRenderer);
    const { canvas, input, rerender } = await mount({ camera: { ...finalCamera, inverseDepth: true }, project: { ...project, backgroundUrl } });
    const context = contexts.get(canvas)!;
    const running = { ...input, ...options, reviewingSource: false, interactive: false, processing: true };
    for (const progress of [0, 24, 94]) {
      rerender(<SceneCanvas {...running} inpaintProgress={progress} />);
      if (!options.reduceEffects) await waitFor(() => expect(paintMosaic).toHaveBeenCalled());
      advance(1000);
      const translations = options.reduceEffects
        ? [[100, 50], [100, 50]]
        : [[100, 50], [100, 50], [-100, -50], [100, 50]];
      const scales = options.reduceEffects ? [[1, 1], [1, 1]] : [[1, 1], [1, 1], [1, 1]];
      expect(vi.mocked(context.translate).mock.calls.slice(-translations.length)).toEqual(translations);
      expect(vi.mocked(context.scale).mock.calls.slice(-scales.length)).toEqual(scales);
    }
    expect(input.onCameraChange).not.toHaveBeenCalled();

    rerender(<SceneCanvas {...input} reviewingSource={false} project={{ ...project, backgroundUrl: "/built.png" }} />);
    await waitFor(() => {
      expect(canvas.parentElement).toHaveAttribute("aria-busy", "false");
      expect(vi.mocked(context.translate).mock.calls.at(-1)).not.toEqual([100, 50]);
      expect(vi.mocked(context.scale).mock.calls.at(-1)?.[0]).toBeGreaterThan(1.1);
    });
    expect(frames.size).toBe(0);
  });

  it("fades a cached background beneath sharp cutouts only after the pointer moves", async () => {
    const { canvas, input } = await mount();
    expect(draws.filter((draw) => draw.filter === "blur(8px)")).toHaveLength(1);
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 50 });
    advance(200);
    expect(blurDraws(canvas)).toHaveLength(0);

    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 75 });
    advance(80);
    expect(blurDraws(canvas).at(-1)?.alpha).toBeCloseTo(0.5);
    advance(80);
    expect(blurDraws(canvas).at(-1)?.alpha).toBe(1);
    const frame = draws.filter((draw) => draw.canvas === canvas).slice(-3);
    expect((frame[0].image as HTMLImageElement).src).toContain("/source.png");
    expect(frame[1].image).toBeInstanceOf(HTMLCanvasElement);
    expect((frame[2].image as HTMLImageElement).src).toContain("/subject.png");
    expect(frame[2]).toMatchObject({ alpha: 1, filter: "none" });
    expect(input.onCameraChange).toHaveBeenLastCalledWith({ ...camera, x: 0.5, y: 0.5, inverseDepth: false });
    expect(draws.filter((draw) => draw.filter === "blur(8px)")).toHaveLength(1);
    expect(frames.size).toBe(0);
  });

  it.each(["pointerUp", "pointerCancel", "lostPointerCapture", "windowBlur"] as const)(
    "restores sharpness and source alignment after %s", async (event) => {
      const { canvas, input, rerender } = await mount({ camera: finalCamera });
      drag(canvas);
      expect(input.onCameraChange).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5, zoom: 1, strength: 30, inverseDepth: false });
      const draggedCamera = vi.mocked(input.onCameraChange).mock.calls.at(-1)![0];
      rerender(<SceneCanvas {...input} camera={draggedCamera} />);
      advance(160);
      const translations = vi.mocked(contexts.get(canvas)!.translate).mock.calls.slice(-2);
      expect(translations[0]).not.toEqual(translations[1]);
      if (event === "windowBlur") fireEvent.blur(window);
      else fireEvent[event](canvas, { pointerId: 1 });
      advance(80);
      expect(blurDraws(canvas).at(-1)?.alpha).toBeCloseTo(0.5);
      draws = [];
      advance(80);
      expect(blurDraws(canvas)).toHaveLength(0);
      expect(frames.size).toBe(0);
      expectAligned(canvas);
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 190, clientY: 95 });
      expect(input.onCameraChange).toHaveBeenCalledTimes(1);
      drag(canvas);
      expect(input.onCameraChange).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5, zoom: 1, strength: 30, inverseDepth: false });
    },
  );

  it("ignores secondary pointers and reverses a fade without jumping", async () => {
    const { canvas, input } = await mount();
    drag(canvas);
    advance(80);
    fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { pointerId: 2 });
    expect(input.onCameraChange).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    advance(80);
    expect(blurDraws(canvas).at(-1)?.alpha).toBeCloseTo(0.25);
    drag(canvas);
    advance(80);
    expect(blurDraws(canvas).at(-1)?.alpha).toBeCloseTo(0.625);
  });

  it.each([{ reduceMotion: true }, { reduceEffects: true }])("skips the fade with %j", async (options) => {
    const { canvas } = await mount(options);
    drag(canvas);
    expect(blurDraws(canvas).at(-1)?.alpha).toBe(1);
    expect(frames.size).toBe(0);
    draws = [];
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(blurDraws(canvas)).toHaveLength(0);
  });

  it("clears the effect on a workflow change and cancels animation on unmount", async () => {
    const { canvas, input, rerender, unmount } = await mount();
    drag(canvas);
    advance(80);
    draws = [];
    rerender(<SceneCanvas {...input} reviewingSource={false} interactive={false} />);
    expect(blurDraws(canvas)).toHaveLength(0);
    expect(frames.size).toBe(0);
    rerender(<SceneCanvas {...input} />);
    drag(canvas);
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });

  it.each([{ reviewingSource: false }, { interactive: false }])("does not blur outside review dragging: %j", async (options) => {
    const { canvas } = await mount(options);
    drag(canvas);
    advance(160);
    expect(blurDraws(canvas)).toHaveLength(0);
  });

  it("exports the inverse-depth preview with the same transforms and original stacking", async () => {
    const near = { ...project.layers[0], depth: 0.95 };
    const far = { ...near, id: "far", cutoutUrl: "/far.png", depth: 0.25 };
    const { canvas, ref } = await mount({
      camera: { ...finalCamera, inverseDepth: true }, reviewingSource: false,
      project: { ...project, backgroundUrl: "/background.png", layers: [near, far] },
    });
    const context = contexts.get(canvas)!;
    const translations = vi.mocked(context.translate).mock.calls.slice(-3);
    const scales = vi.mocked(context.scale).mock.calls.slice(-3);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");
    window.stereovisor = { savePng: vi.fn().mockResolvedValue(undefined) } as unknown as NonNullable<Window["stereovisor"]>;
    draws = [];
    await act(async () => { await ref.current!.exportPng(); });
    expect(draws.map((draw) => (draw.image as HTMLImageElement).getAttribute("src")))
      .toEqual(["/background.png", "/far.png?maskRevision=0", "/subject.png?maskRevision=0"]);
    const exported = contexts.get(draws[0].canvas)!;
    expect(vi.mocked(exported.translate).mock.calls).toEqual(translations);
    expect(vi.mocked(exported.scale).mock.calls).toEqual(scales);
  });

  it("keeps PNG exports, model input, and mask editing free of the drag effect", async () => {
    const { canvas, ref, input, rerender } = await mount({ reduceMotion: true, camera: finalCamera });
    drag(canvas);
    rerender(<SceneCanvas ref={ref} {...input} camera={vi.mocked(input.onCameraChange).mock.calls.at(-1)![0]} />);
    expect(blurDraws(canvas).length).toBeGreaterThan(0);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,test");
    window.stereovisor = { savePng: vi.fn().mockResolvedValue(undefined) } as unknown as NonNullable<Window["stereovisor"]>;
    draws = [];
    await act(async () => { await ref.current!.exportPng(); });
    expect(draws).toHaveLength(2);
    expect(draws.every((draw) => draw.canvas !== canvas && draw.image instanceof HTMLImageElement)).toBe(true);
    expectAligned(draws[0].canvas);

    const output = document.createElement("canvas");
    const source = new Image();
    const images = new Map([[project.sourceUrl, source]]);
    const reviewBlur = { image: document.createElement("canvas"), opacity: 1 };
    draws = [];
    drawInpaintComposition(output, project, camera, images);
    drawScene(output, project, camera, images, false, true, false, null, null, "final", reviewBlur);
    drawScene(output, project, camera, images, false, false, false, null, null, "inpaint-reference", reviewBlur);
    drawScene(output, { ...project, layers: [] }, camera, images, true, false, false, null, null, "final", reviewBlur);
    expect(draws.map((draw) => draw.image)).toEqual([source, source, source, source]);
  });
});
