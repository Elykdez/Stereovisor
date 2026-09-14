import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { drawInpaintComposition, drawScene, SceneCanvas, type MaskMosaicFrame, type SceneCanvasHandle } from "@/components/SceneCanvas";
import { loadServiceImage } from "@/lib/api";
import { GlInpaintForegroundRenderer } from "@/lib/inpaintForegroundGl";
import type { MaskMosaicRenderer } from "@/lib/maskMosaic";
import type { SceneLayer, SceneProject } from "@/types";

vi.mock("@/lib/api", () => ({ loadServiceImage: vi.fn() }));

const camera = { x: 0, y: 0, zoom: 1, strength: 68 };

function layer(id: string, overrides: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id, name: id, cutoutUrl: `/${id}.png`, maskUrl: `/${id}-mask.png`,
    proposalMaskUrl: null, refinementState: "refined", confirmed: true, maskRevision: 0,
    depth: 0.5, order: 0, offsetX: 0, offsetY: 0, selected: true, visible: true,
    bounds: [0, 0, 200, 100], kind: "instance", confidence: 1, feather: 0,
    ...overrides,
  };
}

function scene(layers: SceneLayer[], backgroundUrl: string | null = "/background.png"): SceneProject {
  return {
    id: "foreground-test", width: 200, height: 100, sourceUrl: "/source.png", backgroundUrl,
    unionMaskUrl: null, depthMapUrl: null, backgroundPrompt: null, inpaintProvider: null,
    vramPeaksMb: {}, engine: "preview", layers,
  };
}

function contextMock() {
  return {
    clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
    translate: vi.fn(), scale: vi.fn(), filter: "none",
    imageSmoothingEnabled: true, imageSmoothingQuality: "high",
  };
}

function fixture(project: SceneProject) {
  const context = contextMock();
  const canvas = {
    width: 200, height: 100, clientWidth: 100, getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const images = new Map([project.sourceUrl, project.backgroundUrl, ...project.layers.map((item) => item.cutoutUrl)]
    .filter((source): source is string => source !== null)
    .map((source) => [source, Object.assign(new Image(), { src: source })]));
  const effect = document.createElement("canvas");
  const paint = vi.fn((): HTMLCanvasElement | null => effect);
  const foreground = { paint } as unknown as GlInpaintForegroundRenderer;
  const mosaicPaint = vi.fn();
  const frame: MaskMosaicFrame = {
    renderer: { paint: mosaicPaint } as unknown as MaskMosaicRenderer,
    foreground, mask: null, time: 3.25, progress: 20,
  };
  return { canvas, context, images, effect, paint, mosaicPaint, frame };
}

describe("inpaint foreground composition", () => {
  it("adds the effect only to visible cutouts in depth/order order under each layer transform", () => {
    const project = scene([
      layer("near", { depth: 0.9 }),
      layer("middle", { depth: 0.2, order: 2, offsetX: -0.1, scale: 1.5, kind: "manual" }),
      layer("hidden", { visible: false }),
      layer("far", { depth: 0.2, order: 1, selected: false, offsetX: 0.1, offsetY: 0.2, kind: "depth-plane" }),
    ]);
    const { canvas, context, images, effect, paint, mosaicPaint, frame } = fixture(project);

    expect(drawScene(canvas, project, camera, images, false, false, false, null, frame)).toBe(true);
    expect(paint.mock.calls).toEqual([
      [images.get("/far.png"), 200, 100, 3.25, "far", 2],
      [images.get("/middle.png"), 200, 100, 3.25, "middle", 2],
      [images.get("/near.png"), 200, 100, 3.25, "near", 2],
    ]);
    expect(context.drawImage.mock.calls.map((call) => call[0])).toEqual([
      images.get("/background.png"), images.get("/far.png"), effect,
      images.get("/middle.png"), effect, images.get("/near.png"), effect,
    ]);
    expect(context.translate.mock.calls).toEqual([[100, 50], [120, 70], [80, 50], [100, 50]]);
    expect(context.scale.mock.calls).toEqual([[1, 1], [1, 1], [1.5, 1.5], [1, 1]]);
    for (let index = 0; index < 3; index += 1) {
      expect(context.drawImage.mock.invocationCallOrder[2 + index * 2])
        .toBeLessThan(context.restore.mock.invocationCallOrder[index + 1]);
      expect(context.drawImage.mock.calls[2 + index * 2].slice(1)).toEqual([-100, -50, 200, 100]);
    }
    // Foreground animation does not wait for a targeted inpaint mask to load.
    expect(mosaicPaint).not.toHaveBeenCalled();
  });

  it("effects selected cutouts before the initial background exists", () => {
    const project = scene([
      layer("unselected", { selected: false }),
      layer("selected", { selected: true, visible: false }),
    ], null);
    const { canvas, context, images, effect, paint, frame } = fixture(project);

    drawScene(canvas, project, camera, images, false, false, false, null, frame);

    expect(paint).toHaveBeenCalledExactlyOnceWith(images.get("/selected.png"), 200, 100, 3.25, "selected", 2);
    expect(context.drawImage.mock.calls.map((call) => call[0])).toEqual([
      images.get("/source.png"), images.get("/selected.png"), effect,
    ]);
  });

  it("preserves the original foreground when the GPU cannot produce an effect", () => {
    const project = scene([layer("foreground")]);
    const { canvas, context, images, paint, frame } = fixture(project);
    paint.mockReturnValue(null);

    expect(drawScene(canvas, project, camera, images, false, false, false, null, frame)).toBe(true);
    expect(context.drawImage.mock.calls.map((call) => call[0])).toEqual([
      images.get("/background.png"), images.get("/foreground.png"),
    ]);
  });

  it.each(["default", "model", "model-with-frame"] as const)("keeps %s rendering free of foreground effects", (purpose) => {
    const project = scene([layer("foreground")]);
    const { canvas, context, images, paint, frame } = fixture(project);

    const rendered = purpose === "default"
      ? drawScene(canvas, project, camera, images)
      : purpose === "model"
        ? drawInpaintComposition(canvas, project, camera, images)
        : drawScene(canvas, project, camera, images, false, false, false, null, frame, "inpaint-reference");

    expect(rendered).toBe(true);
    expect(paint).not.toHaveBeenCalled();
    expect(context.drawImage.mock.calls.map((call) => call[0])).toEqual([
      images.get("/background.png"), images.get("/foreground.png"),
    ]);
  });
});

describe("inpaint foreground lifecycle", () => {
  const project = scene([layer("foreground", { selected: false })]);
  let context: ReturnType<typeof contextMock>;
  let effect: HTMLCanvasElement;
  let paint: ReturnType<typeof vi.fn>;
  let dispose: ReturnType<typeof vi.fn>;

  function props(overrides: Partial<ComponentProps<typeof SceneCanvas>> = {}): ComponentProps<typeof SceneCanvas> {
    return {
      project, camera, processing: true, interactive: false, reviewingSource: false,
      showInpaintMask: false, maskEditor: null, showCompositionWhileMaskEditing: false,
      brushMode: "add", brushSize: 48, maskBlurRadius: 0, anchorLayerId: null,
      onLayerAnchorChange: vi.fn(), onMaskDirtyChange: vi.fn(), onMaskHistoryChange: vi.fn(),
      onMaskReadyChange: vi.fn(), onMaskError: vi.fn(), onCameraChange: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    context = contextMock();
    effect = document.createElement("canvas");
    paint = vi.fn(() => effect);
    dispose = vi.fn();
    vi.mocked(loadServiceImage).mockImplementation(async (source) => Object.assign(new Image(), { src: source }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(GlInpaintForegroundRenderer, "create").mockReturnValue({ paint, dispose } as unknown as GlInpaintForegroundRenderer);
    vi.stubGlobal("ResizeObserver", class {
      observe(): void { }
      disconnect(): void { }
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 42));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(loadServiceImage).mockReset();
  });

  it.each([
    { processing: false }, { reduceEffects: true }, { reduceMotion: true },
  ])("does not allocate or animate the shader with gate %j", async (gate) => {
    render(<SceneCanvas {...props(gate)} />);
    await waitFor(() => expect(context.drawImage).toHaveBeenCalled());

    expect(GlInpaintForegroundRenderer.create).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it.each([
    { processing: false }, { reduceEffects: true }, { reduceMotion: true },
  ])("releases the shader when %j changes and recreates it when effects resume", async (gate) => {
    const { rerender, unmount } = render(<SceneCanvas {...props()} />);
    expect(GlInpaintForegroundRenderer.create).not.toHaveBeenCalled();
    await waitFor(() => expect(paint).toHaveBeenCalled());
    expect(GlInpaintForegroundRenderer.create).toHaveBeenCalledTimes(1);
    paint.mockClear();

    rerender(<SceneCanvas {...props(gate)} />);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(paint).not.toHaveBeenCalled();

    rerender(<SceneCanvas {...props()} />);
    expect(GlInpaintForegroundRenderer.create).toHaveBeenCalledTimes(2);
    expect(paint).toHaveBeenCalled();
    unmount();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("keeps rendering the scene when shader creation is unavailable", async () => {
    vi.mocked(GlInpaintForegroundRenderer.create).mockReturnValue(null);
    render(<SceneCanvas {...props()} />);
    await waitFor(() => expect(context.drawImage).toHaveBeenCalled());

    expect(GlInpaintForegroundRenderer.create).toHaveBeenCalledTimes(1);
    expect(paint).not.toHaveBeenCalled();
    expect(context.drawImage.mock.calls.map((call) => (call[0] as HTMLImageElement).getAttribute("src")))
      .toEqual(["/background.png", "/foreground.png?maskRevision=0"]);
  });

  it("exports PNG offscreen without baking active inpaint effects into its pixels", async () => {
    const savePng = vi.fn(async () => undefined);
    vi.stubGlobal("stereovisor", { savePng });
    const encodedCanvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
      encodedCanvases.push(this);
      return "data:image/png;base64,clean";
    });
    const ref = createRef<SceneCanvasHandle>();
    const { container } = render(<SceneCanvas {...props()} ref={ref} />);
    await waitFor(() => expect(paint).toHaveBeenCalled());
    paint.mockClear();
    context.drawImage.mockClear();

    await act(async () => { await ref.current!.exportPng(); });

    expect(paint).not.toHaveBeenCalled();
    expect(context.drawImage.mock.calls).toHaveLength(2);
    expect(context.drawImage.mock.calls.some((call) => call[0] === effect)).toBe(false);
    expect(encodedCanvases).toHaveLength(1);
    expect(encodedCanvases[0]).not.toBe(container.querySelector("canvas"));
    expect(savePng).toHaveBeenCalledExactlyOnceWith("data:image/png;base64,clean", "stereovisor-foregrou.png");
  });
});
