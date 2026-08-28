import {
  confirmProjectLayer,
  inpaintProjectTarget,
  JOB_POLL_INTERVAL_MS,
  refineProjectLayer,
  updateProjectMask,
  waitForJob
} from "./api";
import type { ProcessingProgress, SceneProject } from "../types";

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

function jobResponse(state: "running" | "completed", result: SceneProject | null = null): Response {
  return new Response(JSON.stringify({
    jobId: "job-id",
    kind: "inpaint",
    state,
    progress: state === "completed" ? 100 : 42,
    stage: state === "completed" ? "Complete" : "Redrawing background",
    message: state === "completed" ? "Local processing finished." : "PowerPaint is working.",
    result
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("job polling", () => {
  afterEach(() => {
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
});

describe("mask updates", () => {
  afterEach(() => vi.unstubAllGlobals());

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

    await inpaintProjectTarget("project id", "layer/01", composition, mask, "  rebuild detail  ", vi.fn());

    expect(fetchMock.mock.calls[0][0]).toBe("/api/jobs/projects/project%20id/targets/layer%2F01/inpaint");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("composition")).toBeInstanceOf(Blob);
    expect(form.get("mask")).toBeInstanceOf(Blob);
    expect(form.get("prompt")).toBe("rebuild detail");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/jobs/inpaint-job");
  });
});
