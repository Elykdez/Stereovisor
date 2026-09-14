import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import App from "@/App";
import { analyzeSample, cancelProcessingJob, exportProjectPackage, getInpaintHistory, getLayerMergeHistory, getMaskHistory, inpaintProject, probeHealth, ProcessingCancelledError, resolveServiceAsset, waitForJob } from "@/lib/api";
import { readProcessingSession, saveProcessingSession } from "@/lib/processingSession";
import { subscribeToHealthEvents } from "@/lib/events";
import { SceneCanvas } from "@/components/SceneCanvas";
import { SETTINGS_STORAGE_KEY } from "@/settings";
import type { SceneProject } from "@/types";

vi.mock("@/lib/api");
vi.mock("@/lib/logger");
vi.mock("@/lib/events", () => ({
  isChannelConnected: () => false,
  subscribeToChannelState: () => () => {},
  subscribeToHealthEvents: vi.fn(() => () => {})
}));
vi.mock("@/components/SceneCanvas", () => ({ SceneCanvas: vi.fn(() => null) }));

const project: SceneProject = {
  id: "processing-test",
  width: 200,
  height: 100,
  sourceUrl: "/source.png",
  backgroundUrl: null,
  unionMaskUrl: null,
  depthMapUrl: null,
  backgroundPrompt: null,
  inpaintProvider: null,
  vramPeaksMb: {},
  engine: "ai",
  layers: [{
    id: "person",
    name: "Person",
    cutoutUrl: "/person.png",
    maskUrl: "/person-mask.png",
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
    confidence: 1
  }]
};

describe("App processing status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(probeHealth).mockResolvedValue({
      status: "ok",
      version: "0.1.0",
      configuredMode: "ai",
      activeEngine: "ai",
      device: "cpu",
      localOnly: true,
      providers: Object.fromEntries(
        ["runtime", "segmentation", "matting", "depth", "inpainting"].map((key) => [key, { available: true, detail: "ready" }])
      ),
      message: "Local AI ready.",
      startupState: "ready",
      startupDetail: null,
      startupProvider: null,
      startupProgress: null
    });
    vi.mocked(analyzeSample).mockResolvedValue(project);
    vi.mocked(getMaskHistory).mockResolvedValue([]);
    vi.mocked(getLayerMergeHistory).mockResolvedValue([]);
    vi.mocked(getInpaintHistory).mockResolvedValue([]);
    vi.mocked(resolveServiceAsset).mockImplementation(async (source) => ({ url: source, revoke: () => {} }));
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows server activity before this client has started a job and follows health updates", async () => {
    const initialHealth = await probeHealth();
    vi.mocked(probeHealth).mockResolvedValue({ ...initialHealth,
      activity: { state: "running", queuedJobs: 0, stage: "Describing background",
        compute: { model: "Qwen3-VL", device: "cuda", phase: "loading", elapsedSeconds: 12, idleSeconds: 12 } },
    });
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector(".server-status-copy strong")).toHaveTextContent("Local server / Busy"));
    expect(view.container.querySelector(".server-status-copy small")).toHaveTextContent("GPU compute");
    expect(view.container.querySelector(".server-status")?.outerHTML).not.toMatch(/Qwen3-VL|Loading weights|Describing background/);
    expect(view.container.querySelector(".processing-status")).not.toBeInTheDocument();
    expect(analyzeSample).not.toHaveBeenCalled();
    act(() => vi.mocked(subscribeToHealthEvents).mock.calls.at(-1)![0]({ ...initialHealth,
      activity: { state: "idle", queuedJobs: 0, stage: null, compute: null },
    }));
    expect(view.container.querySelector(".server-status-copy strong")).toHaveTextContent("Local server / Ready");
    expect(view.container.querySelector(".server-status-copy small")).toHaveTextContent("CPU available");
    expect(view.container.querySelector(".fps-counter")).toBeInTheDocument();
  });

  it.each(["browser", "desktop"])("shows and renders 1.10x in the final step with legacy %s settings", async (storage) => {
    const legacySettings = { version: 1, camera: { defaultZoom: 1, defaultStrength: 68 } };
    if (storage === "desktop") {
      vi.stubGlobal("stereovisor", { getSettings: vi.fn().mockResolvedValue(legacySettings) });
    } else {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(legacySettings));
    }
    vi.mocked(inpaintProject).mockResolvedValue({ ...project, backgroundUrl: "/background.png" });
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole("button", { name: "Use sample scene" })).toBeEnabled());
    fireEvent.click(view.getByRole("button", { name: "Use sample scene" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Inpaint holes" })).toBeEnabled());
    fireEvent.click(view.getByRole("button", { name: "Inpaint holes" }));
    const zoom = await view.findByRole("slider", { name: "Zoom" });
    const renderedCamera = () => vi.mocked(SceneCanvas).mock.calls.at(-1)![0].camera;
    expect(zoom).toHaveValue("1.1");
    expect(zoom.closest("label")).toHaveTextContent("1.10x");
    expect(view.getByRole("slider", { name: "Strength" })).toHaveValue("30");
    expect(view.getByRole("slider", { name: "Horizontal" })).toHaveValue("0.5");
    expect(view.getByRole("slider", { name: "Vertical" })).toHaveValue("0.2");
    expect(renderedCamera()).toMatchObject({ x: 0.5, y: 0.2, zoom: 1.1, sceneScale: 1, strength: 30 });

    fireEvent.change(zoom, { target: { value: "1" } });
    expect(zoom.closest("label")).toHaveTextContent("1.00x");
    expect(renderedCamera()).toMatchObject({ zoom: 1, sceneScale: 1 });
    fireEvent.change(view.getByRole("slider", { name: "Strength" }), { target: { value: "60" } });
    fireEvent.change(view.getByRole("slider", { name: "Horizontal" }), { target: { value: "-0.4" } });
    fireEvent.change(view.getByRole("slider", { name: "Vertical" }), { target: { value: "-0.3" } });
    fireEvent.click(within(view.getByRole("region", { name: "Camera controls" })).getByRole("button", { name: "Reset" }));
    expect(zoom).toHaveValue("1.1");
    expect(view.getByRole("slider", { name: "Strength" })).toHaveValue("30");
    expect(view.getByRole("slider", { name: "Horizontal" })).toHaveValue("0.5");
    expect(view.getByRole("slider", { name: "Vertical" })).toHaveValue("0.2");
    expect(renderedCamera()).toMatchObject({ x: 0.5, y: 0.2, zoom: 1.1, sceneScale: 1, strength: 30 });
  });

  it("shows inverse depth in the layer panel in steps 3 and 4 and preserves it through build and export", async () => {
    let completeBuild!: (project: SceneProject) => void;
    vi.mocked(inpaintProject).mockImplementation(() => new Promise((resolve) => { completeBuild = resolve; }));
    vi.mocked(exportProjectPackage).mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(0) } as Blob);
    const saveProject = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("stereovisor", { saveProject });
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole("button", { name: "Use sample scene" })).toBeEnabled());
    fireEvent.click(view.getByRole("button", { name: "Use sample scene" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Inpaint holes" })).toBeEnabled());
    const note = view.container.querySelector(".layers-panel .panel-note")! as HTMLElement;
    const toggle = within(note).getByRole("checkbox", { name: "Inverse depth" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    const rendered = () => vi.mocked(SceneCanvas).mock.calls.at(-1)![0];
    expect(rendered().camera.inverseDepth).toBe(true);
    expect(rendered().project.layers).toEqual(project.layers);
    fireEvent.click(view.getByRole("button", { name: "Inpaint holes" }));
    expect(view.getByRole("checkbox", { name: "Inverse depth" })).toBeChecked();
    expect(view.getByRole("checkbox", { name: "Inverse depth" })).toBeDisabled();
    await act(async () => { completeBuild({ ...project, backgroundUrl: "/background.png" }); });
    expect(view.getAllByRole("checkbox", { name: "Inverse depth" })).toHaveLength(1);
    expect(view.getByRole("checkbox", { name: "Inverse depth" })).toBeChecked();
    expect(view.getByRole("checkbox", { name: "Inverse depth" })).toBeEnabled();
    expect(rendered().camera.inverseDepth).toBe(true);
    expect(view.container.querySelector(".layers-panel .panel-note"))
      .toHaveTextContent("Near layers move less. Distant layers and the background move more.");

    fireEvent.click(view.getByRole("button", { name: "Add hole mask" }));
    expect(rendered().camera.inverseDepth).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.getByRole("checkbox", { name: "Inverse depth" })).toBeChecked();
    fireEvent.click(view.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalled());
    expect(exportProjectPackage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inverseDepth: true }));

    fireEvent.click(within(view.getByRole("region", { name: "Camera controls" })).getByRole("button", { name: "Reset" }));
    expect(view.getByRole("checkbox", { name: "Inverse depth" })).not.toBeChecked();
    expect(rendered().project.layers).toEqual(project.layers);
  });

  it("shows one generation status and locks layer editing until inpainting finishes", async () => {
    let complete!: (result: SceneProject) => void;
    vi.mocked(inpaintProject).mockReturnValue(new Promise((resolve) => { complete = resolve; }));

    const { container, getByRole, getByText, queryByRole } = render(<App />);
    await waitFor(() => expect(getByRole("button", { name: "Use sample scene" })).toBeEnabled());
    fireEvent.click(getByRole("button", { name: "Use sample scene" }));
    await waitFor(() => expect(getByRole("button", { name: "Inpaint holes" })).toBeEnabled());
    fireEvent.click(getByRole("button", { name: "Inpaint holes" }));

    expect(getByText("Queued")).toBeInTheDocument();
    expect(container.querySelector(".processing-status .spinner")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("#inspector-panel .build-panel")).not.toBeInTheDocument();
    const depthSlider = getByRole("slider", { name: "Person depth" });
    const visibilityToggle = getByRole("button", { name: "Disable Person" });
    const layerCard = visibilityToggle.closest("article")!;
    expect(depthSlider).toBeDisabled();
    expect(visibilityToggle).toBeDisabled();
    expect(layerCard).toHaveAttribute("tabindex", "-1");
    fireEvent.change(depthSlider, { target: { value: "0.8" } });
    fireEvent.click(visibilityToggle);
    fireEvent.pointerDown(layerCard);
    fireEvent.focus(layerCard);
    expect(getByText("100% / 50 depth")).toBeInTheDocument();
    expect(visibilityToggle).toHaveAttribute("aria-pressed", "true");
    expect(layerCard).not.toHaveAttribute("aria-current", "true");

    const [, , , , onProgress, onJobStarted] = vi.mocked(inpaintProject).mock.calls[0];
    act(() => {
      onJobStarted?.("inpaint-job");
      onProgress({ state: "running", progress: 24, stage: "Describing background", message: "Qwen3-VL is creating a local background prompt.", queuePosition: null });
    });

    expect(getByText("Describing background")).toBeInTheDocument();
    expect(getByText("Qwen3-VL is creating a local background prompt.")).toBeInTheDocument();
    expect(getByText("24%")).toBeInTheDocument();
    expect(container.querySelector(".server-status-copy strong")).toHaveTextContent("Local server / Connected");
    act(() => onProgress({ state: "running", progress: 24, stage: "Describing background",
      message: "Qwen3-VL is creating a local background prompt.", queuePosition: null,
      compute: { model: "Qwen3-VL", device: "cuda", phase: "inference", completed: 12,
        total: 160, unit: "tokens", elapsedSeconds: 35, idleSeconds: 0 } }));
    // The sidebar uses server-wide activity, while the banner keeps its stage description.
    expect(container.querySelector(".server-status-copy strong")).toHaveTextContent("Local server / Connected");
    expect(getByText("CPU available")).toBeInTheDocument();
    const currentHealth = await probeHealth();
    act(() => vi.mocked(subscribeToHealthEvents).mock.calls.at(-1)![0]({ ...currentHealth,
      activity: { state: "running", queuedJobs: 0, stage: "Describing background", compute: {
        model: "Qwen3-VL", device: "cuda", phase: "inference", elapsedSeconds: 35, idleSeconds: 0,
        gpuName: "NVIDIA GeForce RTX 3070", vramUsedMb: 5120, vramTotalMb: 8192,
      } },
    }));
    expect(container.querySelector(".server-status-copy small")).toHaveTextContent("GPU compute");
    expect(container.querySelector(".server-gpu")).toHaveTextContent("NVIDIA GeForce RTX 3070");
    expect(container.querySelector(".server-gpu")).toHaveTextContent("VRAM (last reported): 5.0 / 8.0 GiB");
    expect(container.querySelector(".processing-status")?.textContent).not.toMatch(/GPU compute|VRAM|tokens|Phase elapsed|Running inference/);
    expect(getByRole("progressbar", { name: "Describing background" })).toHaveAttribute("aria-valuenow", "24");
    expect(getByRole("button", { name: "Cancel processing" })).toBeEnabled();
    expect(container.querySelectorAll(".spinner")).toHaveLength(1);
    expect(depthSlider).toBeDisabled();
    expect(getByRole("button", { name: "Inpaint" })).toBeDisabled();

    await act(async () => { complete({ ...project, backgroundUrl: "/background.png" }); });

    expect(queryByRole("progressbar")).not.toBeInTheDocument();
    expect(container.querySelector(".compute-readout")).not.toBeInTheDocument();
    expect(container.querySelector(".spinner")).not.toBeInTheDocument();
    expect(container.querySelector("#inspector-panel .build-panel")).toBeInTheDocument();
    expect(depthSlider).toBeEnabled();
    expect(visibilityToggle).toBeEnabled();
    expect(layerCard).toHaveAttribute("tabindex", "0");
    fireEvent.change(depthSlider, { target: { value: "0.8" } });
    expect(getByText("100% / 80 depth")).toBeInTheDocument();

    const zoomSlider = getByRole("slider", { name: "Zoom" });
    expect(zoomSlider).toHaveValue("1.1");
    fireEvent.change(zoomSlider, { target: { value: "1.25" } });
    expect(zoomSlider).toHaveValue("1.25");
    fireEvent.click(within(getByRole("region", { name: "Camera controls" })).getByRole("button", { name: "Reset" }));
    expect(zoomSlider).toHaveValue("1.1");
  });

  it("reconnects to the same inpainting job after remounting without submitting another job", async () => {
    let originalComplete!: (result: SceneProject) => void;
    vi.mocked(inpaintProject).mockImplementation(async (_id, _layers, _mode, _prompt, onProgress, onJobStarted) => {
      onJobStarted?.("surviving-job");
      onProgress({ state: "running", progress: 42, stage: "Loading PowerPaint", message: "Loading local checkpoints and preparing CPU/GPU offload before the first denoising step.", queuePosition: null });
      return new Promise((resolve) => { originalComplete = resolve; });
    });
    const original = render(<App />);
    await waitFor(() => expect(original.getByRole("button", { name: "Use sample scene" })).toBeEnabled());
    fireEvent.click(original.getByRole("button", { name: "Use sample scene" }));
    await waitFor(() => expect(original.getByRole("button", { name: "Inpaint holes" })).toBeEnabled());
    fireEvent.click(original.getByRole("button", { name: "Inpaint holes" }));
    await waitFor(() => expect(readProcessingSession()?.jobId).toBe("surviving-job"));
    original.unmount();

    let resumedComplete!: (result: SceneProject) => void;
    vi.mocked(waitForJob).mockImplementation(async (_jobId, onProgress) => {
      onProgress({ state: "running", progress: 60, stage: "Redrawing background", message: "PowerPaint denoising step 9 of 25.", queuePosition: null });
      return new Promise((resolve) => { resumedComplete = resolve; });
    });
    const resumed = render(<App />);
    await waitFor(() => expect(resumed.getByText("Redrawing background")).toBeInTheDocument());
    expect(vi.mocked(waitForJob).mock.calls[0][0]).toBe("surviving-job");
    expect(resumed.getByRole("button", { name: "Open image" })).toBeDisabled();
    expect(resumed.getByRole("button", { name: "Cancel processing" })).toBeEnabled();
    expect(analyzeSample).toHaveBeenCalledTimes(1);
    expect(inpaintProject).toHaveBeenCalledTimes(1);

    // A discarded observer must not clear the session owned by the remount.
    await act(async () => { originalComplete(project); });
    expect(readProcessingSession()?.jobId).toBe("surviving-job");
    await act(async () => { resumedComplete({ ...project, backgroundUrl: "/background.png" }); });
    expect(readProcessingSession()).toBeNull();
    expect(resumed.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(resumed.getByRole("button", { name: "Open image" })).toBeEnabled();
  });

  it("cancels a job recovered after reload and releases its controls", async () => {
    saveProcessingSession({ jobId: "old-job", kind: "inpaint", project, phase: "selecting" });
    let rejectJob!: (error: Error) => void;
    vi.mocked(waitForJob).mockImplementation(() => new Promise((_resolve, reject) => { rejectJob = reject; }));
    vi.mocked(cancelProcessingJob).mockResolvedValue({
      state: "cancelled", progress: 42,
      stage: "Cancelled", message: "Processing cancelled by the user.", queuePosition: null
    });
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole("button", { name: "Cancel processing" })).toBeEnabled());
    fireEvent.click(view.getByRole("button", { name: "Cancel processing" }));
    await waitFor(() => expect(cancelProcessingJob).toHaveBeenCalledWith("old-job"));
    await act(async () => { rejectJob(new ProcessingCancelledError()); });
    expect(readProcessingSession()).toBeNull();
    expect(view.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open image" })).toBeEnabled();
    expect(inpaintProject).not.toHaveBeenCalled();
  });

  it("collects analysis that completed while the app was closed", async () => {
    saveProcessingSession({ jobId: "finished-job", kind: "analyze", project: null, phase: "idle" });
    vi.mocked(waitForJob).mockResolvedValue(project);
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole("button", { name: "Inpaint holes" })).toBeEnabled());
    expect(vi.mocked(waitForJob).mock.calls[0][0]).toBe("finished-job");
    expect(analyzeSample).not.toHaveBeenCalled();
    expect(readProcessingSession()).toBeNull();
  });

  it("releases recovery controls if the service no longer has the job", async () => {
    saveProcessingSession({ jobId: "expired-job", kind: "analyze", project: null, phase: "idle" });
    vi.mocked(waitForJob).mockRejectedValue(new Error("The processing job no longer exists."));
    const view = render(<App />);
    await waitFor(() => expect(view.getByRole("button", { name: "Open image" })).toBeEnabled());
    expect(view.getByRole("alert")).toHaveTextContent("The processing job no longer exists.");
    expect(readProcessingSession()).toBeNull();
    expect(view.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
