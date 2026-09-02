import { fireEvent, render } from "@testing-library/react";
import { demoVideoExtension, drawScene, SceneCanvas, selectDemoVideoType } from "@/web/components/SceneCanvas";
import type { SceneProject } from "@/web/types";

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
        showInpaintMask={false}
        maskEditor={null}
        showCompositionWhileMaskEditing={false}
        brushMode="add"
        brushSize={48}
        maskBlurRadius={0}
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
        showInpaintMask={false}
        maskEditor={null}
        showCompositionWhileMaskEditing={false}
        brushMode="add"
        brushSize={48}
        maskBlurRadius={0}
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
        showInpaintMask={false}
        maskEditor={null}
        showCompositionWhileMaskEditing={false}
        brushMode="add"
        brushSize={48}
        maskBlurRadius={0}
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
