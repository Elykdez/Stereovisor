import { fireEvent, render } from "@testing-library/react";
import { demoVideoExtension, demoVideoFrameIndex, drawInpaintComposition, drawScene, SceneCanvas, selectDemoVideoType } from "@/components/SceneCanvas";
import type { MaskMosaicRenderer } from "@/lib/maskMosaic";
import type { SceneProject } from "@/types";

const project: SceneProject = {
  id: "drag-test",
  width: 200,
  height: 100,
  sourceUrl: "/source.png",
  backgroundUrl: null,
  unionMaskUrl: null,
  depthMapUrl: null,
  backgroundPrompt: null,
  inpaintProvider: null,
  vramPeaksMb: {},
  engine: "preview",
  layers: []
};

describe("SceneCanvas camera interaction", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe(): void { }
      disconnect(): void { }
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      top: 0,
      right: 200,
      bottom: 100,
      left: 0,
      toJSON: () => ({})
    });
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps stereo camera interaction over the original image before inpainting", () => {
    const onCameraChange = vi.fn();
    const { getByLabelText } = render(
      <SceneCanvas
        project={project}
        camera={{ x: 0, y: 0, zoom: 1, strength: 68 }}
        interactive
        reviewingSource
        processing={false}
        showInpaintMask={false}
        maskEditor={null}
        showCompositionWhileMaskEditing={false}
        brushMode="add"
        brushSize={48}
        maskBlurRadius={0}
        anchorLayerId={null}
        onLayerAnchorChange={vi.fn()}
        onMaskDirtyChange={vi.fn()}
        onMaskHistoryChange={vi.fn()}
        onMaskReadyChange={vi.fn()}
        onMaskError={vi.fn()}
        onCameraChange={onCameraChange}
      />
    );
    const canvas = getByLabelText("Original image stereo preview. Drag to test layer depth.");

    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 75 });

    expect(onCameraChange).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5, zoom: 1, strength: 68 });
  });

  it("updates the camera after an inpainted background is available", () => {
    const onCameraChange = vi.fn();
    const { getByLabelText } = render(
      <SceneCanvas
        project={{ ...project, backgroundUrl: "/background.png" }}
        camera={{ x: 0, y: 0, zoom: 1, strength: 68 }}
        interactive
        reviewingSource={false}
        processing={false}
        showInpaintMask={false}
        maskEditor={null}
        showCompositionWhileMaskEditing={false}
        brushMode="add"
        brushSize={48}
        maskBlurRadius={0}
        anchorLayerId={null}
        onLayerAnchorChange={vi.fn()}
        onMaskDirtyChange={vi.fn()}
        onMaskHistoryChange={vi.fn()}
        onMaskReadyChange={vi.fn()}
        onMaskError={vi.fn()}
        onCameraChange={onCameraChange}
      />
    );
    const canvas = getByLabelText("Parallax scene preview. Drag to move the camera.");

    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 75 });

    expect(onCameraChange).toHaveBeenLastCalledWith({ x: 0.5, y: 0.5, zoom: 1, strength: 68 });
  });

  it("ignores camera dragging while the scene is processing", () => {
    const onCameraChange = vi.fn();
    const { getByLabelText } = render(
      <SceneCanvas
        project={project}
        camera={{ x: 0, y: 0, zoom: 1, strength: 68 }}
        interactive={false}
        reviewingSource={false}
        processing={false}
        showInpaintMask={false}
        maskEditor={null}
        showCompositionWhileMaskEditing={false}
        brushMode="add"
        brushSize={48}
        maskBlurRadius={0}
        anchorLayerId={null}
        onLayerAnchorChange={vi.fn()}
        onMaskDirtyChange={vi.fn()}
        onMaskHistoryChange={vi.fn()}
        onMaskReadyChange={vi.fn()}
        onMaskError={vi.fn()}
        onCameraChange={onCameraChange}
      />
    );
    const canvas = getByLabelText("Scene processing preview.");

    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 75 });

    expect(onCameraChange).not.toHaveBeenCalled();
  });

  it("draws only the rebuilt background while editing a post-build retouch mask", () => {
    const drawImage = vi.fn();
    const context = {
      clearRect: vi.fn(),
      drawImage,
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low"
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 200,
      height: 100,
      getContext: vi.fn(() => context)
    } as unknown as HTMLCanvasElement;
    const background = {} as HTMLImageElement;
    const foreground = {} as HTMLImageElement;
    const builtProject: SceneProject = {
      ...project,
      backgroundUrl: "/background.png",
      layers: [{
        id: "foreground",
        name: "Foreground",
        cutoutUrl: "/foreground.png",
        maskUrl: "/foreground-mask.png",
        proposalMaskUrl: null,
        refinementState: "rough",
        confirmed: true,
        maskRevision: 0,
        depth: 0.8,
        order: 0,
        offsetX: 0,
        offsetY: 0,
        selected: true,
        visible: true,
        bounds: [0, 0, 100, 100],
        kind: "instance",
        confidence: 0.9
      }]
    };

    expect(drawScene(
      canvas,
      builtProject,
      { x: 0, y: 0, zoom: 1, strength: 68 },
      new Map([["/background.png", background], ["/foreground.png", foreground]]),
      false,
      true
    )).toBe(true);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(drawImage.mock.calls[0][0]).toBe(background);

    drawImage.mockClear();
    expect(drawScene(
      canvas,
      builtProject,
      { x: 0, y: 0, zoom: 1, strength: 68 },
      new Map([["/background.png", background], ["/foreground.png", foreground]]),
      false,
      true,
      true
    )).toBe(true);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(drawImage.mock.calls[1][0]).toBe(foreground);
  });

  it.each([null, "/background.png"])("keeps foreground layers above the inpainting mosaic (background: %s)", (backgroundUrl) => {
    const drawImage = vi.fn();
    const context = {
      clearRect: vi.fn(),
      drawImage,
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low"
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 200,
      height: 100,
      getContext: vi.fn(() => context)
    } as unknown as HTMLCanvasElement;
    const background = {} as HTMLImageElement;
    const foreground = {} as HTMLImageElement;
    const cells = {} as HTMLCanvasElement;
    const mask = {} as HTMLCanvasElement;
    const renderer = {
      configure: vi.fn(),
      setMask: vi.fn(),
      setPlate: vi.fn(),
      paint: vi.fn(() => cells),
      smoothOutput: true
    } as unknown as MaskMosaicRenderer;
    const layeredProject: SceneProject = {
      ...project,
      backgroundUrl,
      layers: [{
        id: "foreground",
        name: "Foreground",
        cutoutUrl: "/foreground.png",
        maskUrl: "/foreground-mask.png",
        proposalMaskUrl: null,
        refinementState: "rough",
        confirmed: true,
        maskRevision: 0,
        depth: 0.8,
        order: 0,
        offsetX: 0.1,
        offsetY: 0.05,
        feather: 0,
        selected: true,
        visible: true,
        bounds: [0, 0, 100, 100],
        kind: "instance",
        confidence: 0.9
      }]
    };
    const images = new Map([[backgroundUrl ?? project.sourceUrl, background], ["/foreground.png", foreground]]);
    const camera = { x: 0, y: 0, zoom: 1, strength: 68 };

    // No job running: the caller passes no mosaic and the scene is untouched.
    expect(drawScene(canvas, layeredProject, camera, images)).toBe(true);
    expect(drawImage.mock.calls.some((call) => call[0] === cells)).toBe(false);

    // A job whose pending area is not known yet stays out of the way entirely.
    drawImage.mockClear();
    expect(drawScene(canvas, layeredProject, camera, images, false, false, false, null, { renderer, time: 2, mask: null, progress: 0 })).toBe(true);
    expect(renderer.paint).not.toHaveBeenCalled();
    expect(drawImage.mock.calls.some((call) => call[0] === cells)).toBe(false);

    drawImage.mockClear();
    expect(drawScene(canvas, layeredProject, camera, images, false, false, false, null, { renderer, time: 2, mask, progress: 0 })).toBe(true);
    expect(renderer.paint).toHaveBeenCalledWith(2, expect.anything());
    // The pending area is what the effect is bound to, so it marks that region.
    expect(renderer.setMask).toHaveBeenCalledWith(mask);
    expect(renderer.setPlate).toHaveBeenCalledWith(background);
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(drawImage.mock.calls[0][0]).toBe(background);
    expect(drawImage.mock.calls[1][0]).toBe(cells);
    expect(drawImage.mock.calls[2][0]).toBe(foreground);

    // Reported progress resolves the blocks: a fresh job is far coarser than one
    // about to finish.
    const queued = vi.mocked(renderer.configure).mock.calls.at(-1)?.[2];
    drawScene(canvas, layeredProject, camera, images, false, false, false, null, { renderer, time: 2, mask, progress: 96 });
    const nearlyDone = vi.mocked(renderer.configure).mock.calls.at(-1)?.[2];
    expect(queued?.size).toBeLessThan(nearlyDone?.size ?? 0);
  });

  it("omits hidden layers from the built composition used as inpaint reference", () => {
    const drawImage = vi.fn();
    const context = {
      clearRect: vi.fn(),
      drawImage,
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low"
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 200,
      height: 100,
      getContext: vi.fn(() => context)
    } as unknown as HTMLCanvasElement;
    const background = {} as HTMLImageElement;
    const visible = {} as HTMLImageElement;
    const hidden = {} as HTMLImageElement;
    const layer = {
      id: "visible",
      name: "Visible",
      cutoutUrl: "/visible.png",
      maskUrl: "/visible-mask.png",
      proposalMaskUrl: null,
      refinementState: "rough" as const,
      confirmed: true,
      maskRevision: 0,
      depth: 0.8,
      order: 0,
      offsetX: 0,
      offsetY: 0,
      selected: true,
      visible: true,
      bounds: [0, 0, 100, 100] as [number, number, number, number],
      kind: "instance" as const,
      confidence: 0.9
    };
    const builtProject: SceneProject = {
      ...project,
      backgroundUrl: "/background.png",
      layers: [layer, { ...layer, id: "hidden", name: "Hidden", cutoutUrl: "/hidden.png", visible: false, order: 1 }]
    };

    expect(drawScene(
      canvas,
      builtProject,
      { x: 0, y: 0, zoom: 1, strength: 68 },
      new Map([["/background.png", background], ["/visible.png", visible], ["/hidden.png", hidden]])
    )).toBe(true);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(drawImage.mock.calls.map((call) => call[0])).toEqual([background, visible]);
    expect(drawImage.mock.calls.some((call) => call[0] === hidden)).toBe(false);
  });

  it("keeps feather and every blur out of the composition sent to inpainting", () => {
    const filters: string[] = [];
    let filter = "none";
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      get filter(): string { return filter; },
      set filter(value: string) { filter = value; filters.push(value); },
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 200,
      height: 100,
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;
    const background = {} as HTMLImageElement;
    const foreground = {} as HTMLImageElement;
    const effectedProject: SceneProject = {
      ...project,
      backgroundUrl: "/background.png",
      layers: [{
        id: "foreground",
        name: "Foreground",
        cutoutUrl: "/foreground.png",
        maskUrl: "/foreground-mask.png",
        proposalMaskUrl: null,
        refinementState: "refined",
        confirmed: true,
        maskRevision: 0,
        depth: 0.5,
        order: 0,
        offsetX: 0,
        offsetY: 0,
        selected: true,
        visible: true,
        bounds: [0, 0, 100, 100],
        kind: "instance",
        confidence: 1,
        feather: 16,
        blur: 8,
      }],
    };

    expect(drawInpaintComposition(
      canvas,
      effectedProject,
      { x: 0.4, y: -0.2, zoom: 1.1, strength: 68, depthOfField: 20, focusDepth: 1 },
      new Map([["/background.png", background], ["/foreground.png", foreground]])
    )).toBe(true);

    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(context.drawImage).toHaveBeenNthCalledWith(1, background, -100, -50, 200, 100);
    expect(context.drawImage).toHaveBeenNthCalledWith(2, foreground, -100, -50, 200, 100);
    expect(filters).toEqual(["none", "none", "none", "none"]);
  });

  it("renders automatic depth blur plus a signed per-layer correction", () => {
    const filters: string[] = [];
    let filter = "none";
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      get filter(): string { return filter; },
      set filter(value: string) { filter = value; filters.push(value); },
    } as unknown as CanvasRenderingContext2D;
    const canvas = {
      width: 200,
      height: 100,
      getContext: vi.fn(() => context),
    } as unknown as HTMLCanvasElement;
    const background = {} as HTMLImageElement;
    const foreground = {} as HTMLImageElement;
    const focusedProject: SceneProject = {
      ...project,
      backgroundUrl: "/background.png",
      layers: [{
        id: "foreground",
        name: "Foreground",
        cutoutUrl: "/foreground.png",
        maskUrl: "/foreground-mask.png",
        proposalMaskUrl: null,
        refinementState: "refined",
        confirmed: true,
        maskRevision: 0,
        depth: 0.5,
        order: 0,
        offsetX: 0,
        offsetY: 0,
        selected: true,
        visible: true,
        bounds: [0, 0, 100, 100],
        kind: "instance",
        confidence: 1,
        feather: 0,
        blur: -2,
      }],
    };

    expect(drawScene(
      canvas,
      focusedProject,
      { x: 0, y: 0, zoom: 1, strength: 68, depthOfField: 12, focusDepth: 1 },
      new Map([["/background.png", background], ["/foreground.png", foreground]])
    )).toBe(true);
    expect(filters).toEqual(["blur(12.00px)", "none", "blur(4.00px)", "none"]);
  });
});

describe("demo video format", () => {
  it("prefers system-compatible H.264 MP4 and retains WebM as a fallback", () => {
    expect(selectDemoVideoType((type) => type === "video/mp4;codecs=avc1.42E01E" || type === "video/webm;codecs=vp9"))
      .toBe("video/mp4;codecs=avc1.42E01E");
    expect(selectDemoVideoType((type) => type === "video/webm;codecs=vp8"))
      .toBe("video/webm;codecs=vp8");
    expect(demoVideoExtension("video/mp4;codecs=avc1.42E01E")).toBe("mp4");
    expect(demoVideoExtension("video/webm;codecs=vp8")).toBe("webm");
  });

  it("limits scene redraws to the encoded 24 fps cadence", () => {
    expect(demoVideoFrameIndex(0)).toBe(0);
    expect(demoVideoFrameIndex(16)).toBe(0);
    expect(demoVideoFrameIndex(42)).toBe(1);
    expect(demoVideoFrameIndex(1000)).toBe(24);
    expect(demoVideoFrameIndex(4000)).toBe(96);
    expect(demoVideoFrameIndex(8000)).toBe(96);
  });
});
