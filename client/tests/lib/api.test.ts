import {
  cancelProcessingJob,
  confirmProjectLayer,
  inpaintProjectTarget,
  importProjectPackage,
  JOB_POLL_INTERVAL_MS,
  ProcessingCancelledError,
  refineProjectLayer,
  resolveServiceAsset,
  setServiceConnection,
  updateProjectMask,
  waitForJob
} from "@/lib/api";
import type { ComputeStatus, ProcessingProgress, SceneProject } from "@/types";

const project: SceneProject = {
  id: "finished-project",
  width: 32,
  height: 32,
  sourceUrl: "/source.png",
  backgroundUrl: "/background.png",
  unionMaskUrl: "/union-mask.png",
  depthMapUrl: null,
  backgroundPrompt: null,
  inpaintProvider: "preview",
  vramPeaksMb: {},
  engine: "preview",
  layers: []
};

function jobResponse(
  state: "queued" | "running" | "completed" | "cancelled",
  result: SceneProject | null = null,
  queuePosition: number | null = null,
  compute?: ComputeStatus | null,
): Response {
  return new Response(JSON.stringify({
    jobId: "job-id",
    kind: "inpaint",
    state,
    progress: state === "completed" ? 100 : 42,
    stage: state === "completed" ? "Complete" : state === "cancelled" ? "Cancelled" : state === "queued" ? "Queued" : "Redrawing background",
    message: state === "completed" ? "Local processing finished." : state === "cancelled" ? "Processing cancelled by the user." : "PowerPaint is working.",
    queuePosition,
    compute,
    result
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("job polling", () => {
  afterEach(() => {
    setServiceConnection("", "");
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits between requests and ignores duplicate progress payloads", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jobResponse("running"))
      .mockResolvedValueOnce(jobResponse("running"))
      .mockResolvedValueOnce(jobResponse("completed", project));
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn<(progress: ProcessingProgress) => void>();

    const resultPromise = waitForJob("job-id", onProgress);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
    await expect(resultPromise).resolves.toEqual(project);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("surfaces a cancelled worker as a typed error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jobResponse("cancelled")));

    await expect(waitForJob("job-id", vi.fn())).rejects.toBeInstanceOf(ProcessingCancelledError);
  });

  it("delivers compute activity changes at the same overall percentage and clears terminal details", async () => {
    vi.useFakeTimers();
    const initial: ComputeStatus = {
      model: "Qwen3-VL", device: "cpu", phase: "loading",
      elapsedSeconds: 1, idleSeconds: 1,
    };
    const waiting = { ...initial, elapsedSeconds: 41, idleSeconds: 41 };
    const generating: ComputeStatus = { ...initial, device: "cuda", phase: "inference",
      completed: 2, total: 160, unit: "tokens", vramUsedMb: 6144, vramTotalMb: 8192,
      elapsedSeconds: 2, idleSeconds: 0 };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jobResponse("queued", null, 1, initial))
      .mockResolvedValueOnce(jobResponse("running", null, null, initial))
      .mockResolvedValueOnce(jobResponse("running", null, null, waiting))
      .mockResolvedValueOnce(jobResponse("running", null, null, generating))
      .mockResolvedValueOnce(jobResponse("completed", project, null, generating)));
    const onProgress = vi.fn<(progress: ProcessingProgress) => void>();
    const resultPromise = waitForJob("job-id", onProgress);
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ state: "queued", compute: null }));
    for (const compute of [initial, waiting, generating]) {
      await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
      expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ progress: 42, compute }));
    }
    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
    await expect(resultPromise).resolves.toEqual(project);
    expect(onProgress).toHaveBeenCalledTimes(5);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ state: "completed", compute: null }));
  });

  it("reports queue position changes even when progress is unchanged", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jobResponse("queued", null, 2))
      .mockResolvedValueOnce(jobResponse("queued", null, 1))
      .mockResolvedValueOnce(jobResponse("completed", project));
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn<(progress: ProcessingProgress) => void>();

    const resultPromise = waitForJob("job-id", onProgress);
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "queued", queuePosition: 2 }),
    );

    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "queued", queuePosition: 1 }),
    );

    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
    await expect(resultPromise).resolves.toEqual(project);
  });

  it("posts a cancellation request for the active worker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jobResponse("cancelled"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cancelProcessingJob("job/id");

    expect(result.state).toBe("cancelled");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/jobs/job%2Fid/cancel");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });
});

describe("mask updates", () => {
  afterEach(() => {
    setServiceConnection("", "");
    vi.unstubAllGlobals();
  });

  it("routes object and extra-area masks to their local endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify(project),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )));
    vi.stubGlobal("fetch", fetchMock);
    const mask = new Blob(["png"], { type: "image/png" });

    await updateProjectMask("project id", "layer/01", mask);
    await updateProjectMask("project id", null, mask);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project%20id/layers/layer%2F01/mask");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project%20id/extra-mask");
  });

  it("routes explicit confirm and refine actions to one encoded layer", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(project), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "refine-job" }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(jobResponse("completed", project));
    vi.stubGlobal("fetch", fetchMock);

    await confirmProjectLayer("project id", "layer/01");
    await refineProjectLayer("project id", "layer/01", vi.fn());

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project%20id/layers/layer%2F01/confirm");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/jobs/projects/project%20id/layers/layer%2F01/refine");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/jobs/refine-job");
  });

  it("sends composition, mask, and prompt to one encoded inpaint target", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "inpaint-job" }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(jobResponse("completed", project));
    vi.stubGlobal("fetch", fetchMock);
    const composition = new Blob(["composition"], { type: "image/png" });
    const mask = new Blob(["mask"], { type: "image/png" });

    await inpaintProjectTarget("project id", "layer/01", composition, mask, "  rebuild detail  ", vi.fn(), undefined, 12);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/jobs/projects/project%20id/targets/layer%2F01/inpaint");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("composition")).toBeInstanceOf(Blob);
    expect(form.get("mask")).toBeInstanceOf(Blob);
    expect(form.get("prompt")).toBe("rebuild detail");
    expect(form.get("steps")).toBe("12");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/jobs/inpaint-job");
  });
});

describe("startup request resilience", () => {
  afterEach(() => {
    setServiceConnection("", "");
    vi.unstubAllGlobals();
  });

  it("retries a project import while the local service is restarting", async () => {
    vi.useFakeTimers();
    const imported = { project, camera: { x: 0, y: 0, zoom: 1, strength: 68 } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { message: "Local AI is starting" } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(imported), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = importProjectPackage(new File(["package"], "scene.stereovisor"));
    await vi.advanceTimersByTimeAsync(350);

    await expect(resultPromise).resolves.toEqual(imported);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("remote service authentication", () => {
  afterEach(() => {
    setServiceConnection("", "");
    vi.unstubAllGlobals();
  });

  it("adds the configured bearer token to service requests", async () => {
    setServiceConnection("http://192.168.1.20:5772", "shared-secret");
    const fetchMock = vi.fn().mockResolvedValue(jobResponse("cancelled"));
    vi.stubGlobal("fetch", fetchMock);

    await cancelProcessingJob("job-id");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://192.168.1.20:5772/api/jobs/job-id/cancel",
    );
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("Authorization")).toBe("Bearer shared-secret");
  });

  it("fetches protected image assets before handing them to an image element", async () => {
    setServiceConnection("http://192.168.1.20:5772", "shared-secret");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createObjectUrl = vi.fn(() => "blob:protected-asset");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });

    const asset = await resolveServiceAsset("/api/projects/p1/assets/source.png");
    asset.revoke();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://192.168.1.20:5772/api/projects/p1/assets/source.png",
    );
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("Authorization")).toBe("Bearer shared-secret");
    expect(asset.url).toBe("blob:protected-asset");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:protected-asset");
  });
});
