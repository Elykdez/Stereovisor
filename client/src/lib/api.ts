import type {
  CameraState,
  HealthStatus,
  ImportedProject,
  InpaintHistoryState,
  InpaintRefinement,
  ProcessingJobKind,
  ProcessingProgress,
  SceneProject,
} from "../types";
import type { SegmentationDensity } from "../settings";
import { appLog } from "./logger";
import { isChannelConnected, waitForJobEvent } from "./events";
import {
  resolveServiceAccessToken,
  resolveServiceOrigin,
} from "./serviceOrigin";

export {
  DEFAULT_SERVICE_ORIGIN,
  normalizeServiceOrigin,
  resolveServiceAccessToken,
  resolveServiceOrigin,
  setServiceConnection,
  setServiceOrigin,
} from "./serviceOrigin";
export const JOB_POLL_INTERVAL_MS = 1000;
/** Backstop cadence while pushed job events are arriving. */
const EVENT_SAFETY_POLL_MS = 5000;
let jobPollIntervalMs = JOB_POLL_INTERVAL_MS;

export function setJobPollIntervalMs(value: number): void {
  if (Number.isFinite(value)) {
    jobPollIntervalMs = Math.min(
      5000,
      Math.max(250, Math.round(value / 50) * 50),
    );
    appLog.info("processing.poll-interval.updated", {
      intervalMs: jobPollIntervalMs,
    });
  }
}

interface ApiErrorBody {
  detail?: string | { code?: string; message?: string; detail?: string };
  message?: string;
}

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

interface ProcessingJobStart {
  jobId: string;
}

interface ProcessingJob extends ProcessingProgress {
  jobId: string;
  kind: ProcessingJobKind;
  result: SceneProject | null;
}

export class ProcessingCancelledError extends Error {
  constructor(message = "Processing cancelled by the user.") {
    super(message);
    this.name = "ProcessingCancelledError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchService(path, init);
  } catch (error) {
    appLog.warn("api.request.unreachable", {
      method: init?.method ?? "GET",
      path,
      error: error instanceof Error ? error.message : error,
    });
    throw error;
  }
  if (response.ok) {
    return (await response.json()) as T;
  }
  appLog.warn("api.request.failed", {
    method: init?.method ?? "GET",
    path,
    status: response.status,
  });
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    throw new ApiRequestError(
      `Local service failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  let message: string;
  if (typeof body.detail === "object") {
    message = [body.detail.message, body.detail.detail]
      .filter(Boolean)
      .join(" ");
  } else {
    message =
      body.message ??
      body.detail ??
      `Local service failed with HTTP ${response.status}.`;
  }
  throw new ApiRequestError(message, response.status);
}

function authenticatedInit(init?: RequestInit): RequestInit | undefined {
  const accessToken = resolveServiceAccessToken();
  if (!accessToken) return init;
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return { ...init, headers };
}

function fetchService(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${resolveServiceOrigin()}${path}`, authenticatedInit(init));
}

function isTransientStartupError(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError && [502, 503, 504].includes(error.status)
  );
}

async function requestWithStartupRetry<T>(
  path: string,
  init: RequestInit,
  attempts = 8,
  retryNetworkErrors = false,
): Promise<T> {
  let delayMs = 350;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request<T>(path, init);
    } catch (error) {
      const transient =
        isTransientStartupError(error) ||
        (retryNetworkErrors && error instanceof TypeError);
      if (!transient || attempt === attempts) throw error;
      appLog.warn("api.request.startup-retry", {
        path,
        attempt,
        attempts,
        delayMs,
        status: error instanceof ApiRequestError ? error.status : undefined,
      });
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      delayMs = Math.min(2000, delayMs * 2);
    }
  }
  throw new Error("Local service request failed during startup.");
}

export function resolveAssetUrl(path: string): string {
  if (/^(https?:|data:|blob:)/.test(path)) {
    return path;
  }
  return `${resolveServiceOrigin()}${path}`;
}

interface ResolvedServiceAsset {
  url: string;
  revoke: () => void;
}

/**
 * Turn an authenticated service asset into a browser-safe blob URL. Image
 * elements cannot attach bearer headers themselves, so remote assets take this
 * fetch path while the token-free local path remains direct.
 */
export async function resolveServiceAsset(
  path: string,
): Promise<ResolvedServiceAsset> {
  const resolved = resolveAssetUrl(path);
  const serviceBase = resolveServiceOrigin() || window.location.origin;
  const belongsToService =
    !/^(https?:)/.test(path) ||
    new URL(resolved, window.location.href).origin ===
      new URL(serviceBase, window.location.href).origin;
  if (!resolveServiceAccessToken() || /^(data:|blob:)/.test(resolved)) {
    return { url: resolved, revoke: () => undefined };
  }
  if (!belongsToService) return { url: resolved, revoke: () => undefined };
  const response = await fetch(resolved, authenticatedInit());
  if (!response.ok) await throwResponseError(response);
  const objectUrl = URL.createObjectURL(await response.blob());
  return { url: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) };
}

export async function loadServiceImage(
  path: string,
  errorMessage = `Could not load ${path}`,
): Promise<HTMLImageElement> {
  const asset = await resolveServiceAsset(path);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      asset.revoke();
      resolve(image);
    };
    image.onerror = () => {
      asset.revoke();
      reject(new Error(errorMessage));
    };
    image.src = asset.url;
  });
}

export async function getHealth(): Promise<HealthStatus> {
  appLog.info("health.check.started");
  try {
    const status = await retryHealth(12);
    appLog.info("health.check.succeeded", {
      engine: status.activeEngine,
      device: status.device,
      providers: Object.fromEntries(
        Object.entries(status.providers).map(([name, provider]) => [
          name,
          provider.available,
        ]),
      ),
    });
    return status;
  } catch (error) {
    appLog.error("health.check.failed", error);
    throw error;
  }
}

/** Make one readiness request; startup owns the retry cadence and UI state. */
export function probeHealth(): Promise<HealthStatus> {
  return request<HealthStatus>("/api/health");
}

async function retryHealth(attempts: number): Promise<HealthStatus> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request<HealthStatus>("/api/health");
    } catch (error) {
      lastError = error;
      appLog.warn("health.check.retry", {
        attempt: attempt + 1,
        attempts,
        error: error instanceof Error ? error.message : error,
      });
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
    }
  }
  throw lastError;
}

export async function waitForJob(
  jobId: string,
  onProgress: (progress: ProcessingProgress) => void,
  onJobStarted?: (jobId: string) => void,
): Promise<SceneProject> {
  // The service owns the job; the renderer only observes state changes and
  // turns terminal states into a resolved project or a user-facing error.
  const startedAt = performance.now();
  onJobStarted?.(jobId);
  appLog.info("processing.job.started", { jobId });
  let previousProgress = "";
  let previousStage = "";
  for (;;) {
    const job = await request<ProcessingJob>(`/api/jobs/${jobId}`);
    const progressKey = `${job.state}:${job.progress}:${job.stage}:${job.message}:${job.queuePosition ?? ""}`;
    if (progressKey !== previousProgress) {
      onProgress({
        state: job.state,
        progress: job.progress,
        stage: job.stage,
        message: job.message,
        queuePosition: job.queuePosition,
      });
      previousProgress = progressKey;
    }
    if (job.stage !== previousStage) {
      appLog.info("processing.job.stage", {
        jobId,
        state: job.state,
        progress: job.progress,
        stage: job.stage,
      });
      previousStage = job.stage;
    }
    if (job.state === "completed") {
      if (!job.result)
        throw new Error("Local processing completed without a project result.");
      appLog.info("processing.job.completed", {
        jobId,
        kind: job.kind,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return job.result;
    }
    if (job.state === "cancelled") {
      appLog.info("processing.job.cancelled", { jobId, message: job.message });
      throw new ProcessingCancelledError(job.message);
    }
    if (job.state === "failed") {
      appLog.error("processing.job.failed", job.message, {
        jobId,
        stage: job.stage,
      });
      throw new Error(job.message);
    }
    // With the event channel up, transitions drive the loop and the timer is
    // only a safety net; without it this is the original polling cadence.
    await waitForJobEvent(
      jobId,
      isChannelConnected()
        ? Math.max(jobPollIntervalMs, EVENT_SAFETY_POLL_MS)
        : jobPollIntervalMs,
    );
  }
}

export async function analyzeImage(
  file: File,
  onProgress: (progress: ProcessingProgress) => void,
  onJobStarted?: (jobId: string) => void,
  density: SegmentationDensity = "balanced",
  labels = "",
  useVlmVocabularyProposer = false,
): Promise<SceneProject> {
  appLog.info("workflow.analyze-image.started", {
    name: file.name,
    bytes: file.size,
    density,
    hasCustomLabels: Boolean(labels.trim()),
    useVlmVocabularyProposer,
  });
  const form = new FormData();
  form.append("file", file);
  form.append("segmentation_density", density);
  form.append("segmentation_labels", labels);
  form.append("use_vlm_vocabulary", String(useVlmVocabularyProposer));
  const job = await requestWithStartupRetry<ProcessingJobStart>(
    "/api/jobs/analyze",
    { method: "POST", body: form },
  );
  return waitForJob(job.jobId, onProgress, onJobStarted);
}

export async function analyzeSample(
  onProgress: (progress: ProcessingProgress) => void,
  onJobStarted?: (jobId: string) => void,
  density: SegmentationDensity = "balanced",
  labels = "",
  useVlmVocabularyProposer = false,
): Promise<SceneProject> {
  appLog.info("workflow.analyze-sample.started", {
    density,
    hasCustomLabels: Boolean(labels.trim()),
    useVlmVocabularyProposer,
  });
  const query = new URLSearchParams({
    segmentation_density: density,
    segmentation_labels: labels,
    use_vlm_vocabulary: String(useVlmVocabularyProposer),
  });
  const job = await requestWithStartupRetry<ProcessingJobStart>(
    `/api/jobs/sample?${query.toString()}`,
    { method: "POST" },
  );
  return waitForJob(job.jobId, onProgress, onJobStarted);
}

export async function inpaintProject(
  projectId: string,
  layerIds: string[],
  refinement: InpaintRefinement,
  prompt: string | undefined,
  onProgress: (progress: ProcessingProgress) => void,
  onJobStarted?: (jobId: string) => void,
  steps = 25,
): Promise<SceneProject> {
  appLog.info("workflow.inpaint.started", {
    projectId,
    layerCount: layerIds.length,
    refinement,
    steps,
    hasPrompt: Boolean(prompt?.trim()),
  });
  const job = await request<ProcessingJobStart>(
    `/api/jobs/projects/${projectId}/inpaint`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layerIds,
        refinement,
        prompt: prompt?.trim() || null,
        steps,
      }),
    },
  );
  return waitForJob(job.jobId, onProgress, onJobStarted);
}

export async function inpaintProjectTarget(
  projectId: string,
  targetId: string | null,
  composition: Blob,
  mask: Blob,
  prompt: string | undefined,
  onProgress: (progress: ProcessingProgress) => void,
  onJobStarted?: (jobId: string) => void,
  steps = 25,
): Promise<SceneProject> {
  appLog.info("workflow.target-inpaint.started", {
    projectId,
    targetId: targetId ?? "background",
    steps,
    hasPrompt: Boolean(prompt?.trim()),
  });
  const form = new FormData();
  form.append("composition", composition, "composition.png");
  form.append("mask", mask, "inpaint-mask.png");
  form.append("prompt", prompt?.trim() ?? "");
  form.append("steps", String(steps));
  const project = encodeURIComponent(projectId);
  const target = encodeURIComponent(targetId ?? "background");
  const job = await request<ProcessingJobStart>(
    `/api/jobs/projects/${project}/targets/${target}/inpaint`,
    {
      method: "POST",
      body: form,
    },
  );
  return waitForJob(job.jobId, onProgress, onJobStarted);
}

export function cancelProcessingJob(
  jobId: string,
): Promise<ProcessingProgress> {
  appLog.info("processing.job.cancel.requested", { jobId });
  return request<ProcessingProgress>(
    `/api/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
}

export function getInpaintHistory(
  projectId: string,
): Promise<InpaintHistoryState[]> {
  return request<InpaintHistoryState[]>(
    `/api/projects/${encodeURIComponent(projectId)}/inpaint-history`,
  );
}

export function getMaskHistory(
  projectId: string,
): Promise<InpaintHistoryState[]> {
  return request<InpaintHistoryState[]>(
    `/api/projects/${encodeURIComponent(projectId)}/mask-history`,
  );
}

function restoreProjectTargetInpaint(
  projectId: string,
  targetId: string | null,
  action: "undo" | "redo",
): Promise<SceneProject> {
  const project = encodeURIComponent(projectId);
  const target = encodeURIComponent(targetId ?? "background");
  return request<SceneProject>(
    `/api/projects/${project}/targets/${target}/${action}-inpaint`,
    { method: "POST" },
  );
}

export function undoProjectTargetInpaint(
  projectId: string,
  targetId: string | null,
): Promise<SceneProject> {
  return restoreProjectTargetInpaint(projectId, targetId, "undo");
}

export function redoProjectTargetInpaint(
  projectId: string,
  targetId: string | null,
): Promise<SceneProject> {
  return restoreProjectTargetInpaint(projectId, targetId, "redo");
}

function restoreProjectLayerRefine(
  projectId: string,
  layerId: string,
  action: "undo" | "redo",
): Promise<SceneProject> {
  const project = encodeURIComponent(projectId);
  const layer = encodeURIComponent(layerId);
  return request<SceneProject>(
    `/api/projects/${project}/layers/${layer}/${action}-refine`,
    { method: "POST" },
  );
}

export function undoProjectLayerRefine(
  projectId: string,
  layerId: string,
): Promise<SceneProject> {
  return restoreProjectLayerRefine(projectId, layerId, "undo");
}

export function redoProjectLayerRefine(
  projectId: string,
  layerId: string,
): Promise<SceneProject> {
  return restoreProjectLayerRefine(projectId, layerId, "redo");
}

export function mergeProjectLayers(
  projectId: string,
  layerIds: string[],
): Promise<SceneProject> {
  return request<SceneProject>(
    `/api/projects/${encodeURIComponent(projectId)}/layers/merge`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layerIds }),
    },
  );
}

export function getLayerMergeHistory(
  projectId: string,
): Promise<InpaintHistoryState[]> {
  return request<InpaintHistoryState[]>(
    `/api/projects/${encodeURIComponent(projectId)}/layer-merge-history`,
  );
}

function restoreProjectLayerMerge(
  projectId: string,
  action: "undo" | "redo",
): Promise<SceneProject> {
  return request<SceneProject>(
    `/api/projects/${encodeURIComponent(projectId)}/layers/${action}-merge`,
    { method: "POST" },
  );
}

export function undoProjectLayerMerge(
  projectId: string,
): Promise<SceneProject> {
  return restoreProjectLayerMerge(projectId, "undo");
}

export function redoProjectLayerMerge(
  projectId: string,
): Promise<SceneProject> {
  return restoreProjectLayerMerge(projectId, "redo");
}

export async function refineProjectLayer(
  projectId: string,
  layerId: string,
  onProgress: (progress: ProcessingProgress) => void,
  onJobStarted?: (jobId: string) => void,
): Promise<SceneProject> {
  const project = encodeURIComponent(projectId);
  const layer = encodeURIComponent(layerId);
  const job = await request<ProcessingJobStart>(
    `/api/jobs/projects/${project}/layers/${layer}/refine`,
    {
      method: "POST",
    },
  );
  return waitForJob(job.jobId, onProgress, onJobStarted);
}

export function createProjectLayer(
  projectId: string,
  mask: Blob,
  name?: string,
): Promise<SceneProject> {
  const form = new FormData();
  form.append("file", mask, "new-layer-mask.png");
  if (name) form.append("name", name);
  return request<SceneProject>(
    `/api/projects/${encodeURIComponent(projectId)}/layers`,
    { method: "POST", body: form },
  );
}

export function renameProjectLayer(
  projectId: string,
  layerId: string,
  name: string,
): Promise<SceneProject> {
  return request<SceneProject>(
    `/api/projects/${encodeURIComponent(projectId)}/layers/${encodeURIComponent(layerId)}/name`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
}

export function deleteProjectLayer(
  projectId: string,
  layerId: string,
): Promise<SceneProject> {
  return request<SceneProject>(
    `/api/projects/${encodeURIComponent(projectId)}/layers/${encodeURIComponent(layerId)}/delete`,
    { method: "POST" },
  );
}

export function confirmProjectLayer(
  projectId: string,
  layerId: string,
): Promise<SceneProject> {
  return request<SceneProject>(
    `/api/projects/${encodeURIComponent(projectId)}/layers/${encodeURIComponent(layerId)}/confirm`,
    { method: "POST" },
  );
}

export function updateProjectMask(
  projectId: string,
  layerId: string | null,
  mask: Blob,
): Promise<SceneProject> {
  const form = new FormData();
  form.append("file", mask, "edited-mask.png");
  const encodedProjectId = encodeURIComponent(projectId);
  const path = layerId
    ? `/api/projects/${encodedProjectId}/layers/${encodeURIComponent(layerId)}/mask`
    : `/api/projects/${encodedProjectId}/extra-mask`;
  return request<SceneProject>(path, { method: "POST", body: form });
}

export async function exportProjectPackage(
  project: SceneProject,
  camera: CameraState,
): Promise<Blob> {
  appLog.info("workflow.project-export.started", {
    projectId: project.id,
    layerCount: project.layers.length,
  });
  const response = await fetchService(
    `/api/projects/${project.id}/export`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        camera,
        layers: project.layers.map(
          ({ id, depth, order, offsetX, offsetY, selected, visible, feather, blur, centerPull, scale }) => ({
            id,
            depth,
            order,
            offsetX,
            offsetY,
            selected,
            visible,
            feather,
            blur,
            centerPull,
            scale,
          }),
        ),
      }),
    },
  );
  if (!response.ok) {
    appLog.warn("workflow.project-export.failed", {
      projectId: project.id,
      status: response.status,
    });
    await throwResponseError(response);
  }
  const blob = await response.blob();
  appLog.info("workflow.project-export.completed", {
    projectId: project.id,
    bytes: blob.size,
  });
  return blob;
}

export function importProjectPackage(file: File): Promise<ImportedProject> {
  appLog.info("workflow.project-import.started", {
    name: file.name,
    bytes: file.size,
  });
  const form = new FormData();
  form.append("file", file);
  return requestWithStartupRetry<ImportedProject>(
    "/api/projects/import",
    { method: "POST", body: form },
    8,
    true,
  );
}

async function throwResponseError(response: Response): Promise<never> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    throw new Error(`Local service failed with HTTP ${response.status}.`);
  }
  if (typeof body.detail === "object") {
    throw new Error(
      [body.detail.message, body.detail.detail].filter(Boolean).join(" "),
    );
  }
  throw new Error(
    body.message ??
      body.detail ??
      `Local service failed with HTTP ${response.status}.`,
  );
}
