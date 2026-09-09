import { fireEvent, render } from "@testing-library/react";
import { demoVideoExtension, drawScene, SceneCanvas, selectDemoVideoType } from "@/components/SceneCanvas";
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

  it("shatters only the area a running inpainting job is rebuilding", () => {
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
    const cells = {} as HTMLCanvasElement;
    const mask = {} as HTMLCanvasElement;
    const renderer = {
      configure: vi.fn(),
      setMask: vi.fn(),
      setPlate: vi.fn(),
      paint: vi.fn(() => cells),
      smoothOutput: true
    } as unknown as MaskMosaicRenderer;
    const images = new Map([["/source.png", background]]);
    const camera = { x: 0, y: 0, zoom: 1, strength: 68 };

    // No job running: the caller passes no mosaic and the scene is untouched.
    expect(drawScene(canvas, project, camera, images)).toBe(true);
    expect(drawImage.mock.calls.some((call) => call[0] === cells)).toBe(false);

    // A job whose pending area is not known yet stays out of the way entirely.
    drawImage.mockClear();
    expect(drawScene(canvas, project, camera, images, false, false, false, null, { renderer, time: 2, mask: null, progress: 0 })).toBe(true);
    expect(renderer.paint).not.toHaveBeenCalled();
    expect(drawImage.mock.calls.some((call) => call[0] === cells)).toBe(false);

    drawImage.mockClear();
    expect(drawScene(canvas, project, camera, images, false, false, false, null, { renderer, time: 2, mask, progress: 0 })).toBe(true);
    expect(renderer.paint).toHaveBeenCalledWith(2, expect.anything());
    // The pending area is what the effect is bound to, so it marks that region.
    expect(renderer.setMask).toHaveBeenCalledWith(mask);
    expect(drawImage.mock.calls.at(-1)?.[0]).toBe(cells);

    // Reported progress resolves the blocks: a fresh job is far coarser than one
    // about to finish.
    const queued = vi.mocked(renderer.configure).mock.calls.at(-1)?.[2];
    drawScene(canvas, project, camera, images, false, false, false, null, { renderer, time: 2, mask, progress: 96 });
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
});
