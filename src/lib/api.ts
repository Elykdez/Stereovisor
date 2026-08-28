import type { CameraState, HealthStatus, ImportedProject, InpaintHistoryState, InpaintRefinement, ProcessingProgress, SceneProject } from "../types";

const SERVICE_ORIGIN = import.meta.env.DEV ? "" : "http://127.0.0.1:5179";
export const JOB_POLL_INTERVAL_MS = 1000;

interface ApiErrorBody {
  detail?: string | { code?: string; message?: string; detail?: string };
  message?: string;
}

interface ProcessingJobStart {
  jobId: string;
}

interface ProcessingJob extends ProcessingProgress {
  jobId: string;
  kind: "analyze" | "refine" | "inpaint";
  result: SceneProject | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SERVICE_ORIGIN}${path}`, init);
  if (response.ok) {
    return (await response.json()) as T;
  }
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    throw new Error(`Local service failed with HTTP ${response.status}.`);
  }
  if (typeof body.detail === "object") {
    throw new Error([body.detail.message, body.detail.detail].filter(Boolean).join(" "));
  }
  throw new Error(body.message ?? body.detail ?? `Local service failed with HTTP ${response.status}.`);
}

export function resolveAssetUrl(path: string): string {
  if (/^(https?:|data:|blob:)/.test(path)) {
    return path;
  }
  return `${SERVICE_ORIGIN}${path}`;
}

export function getHealth(): Promise<HealthStatus> {
  return retryHealth(12);
}

async function retryHealth(attempts: number): Promise<HealthStatus> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request<HealthStatus>("/api/health");
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
    }
  }
  throw lastError;
}

export async function waitForJob(
  jobId: string,
  onProgress: (progress: ProcessingProgress) => void
): Promise<SceneProject> {
  let previousProgress = "";
  for (;;) {
    const job = await request<ProcessingJob>(`/api/jobs/${jobId}`);
    const progressKey = `${job.state}:${job.progress}:${job.stage}:${job.message}`;
    if (progressKey !== previousProgress) {
      onProgress({ state: job.state, progress: job.progress, stage: job.stage, message: job.message });
      previousProgress = progressKey;
    }
    if (job.state === "completed") {
      if (!job.result) throw new Error("Local processing completed without a project result.");
      return job.result;
    }
    if (job.state === "failed") throw new Error(job.message);
    await new Promise((resolve) => window.setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  }
}

export async function analyzeImage(
  file: File,
  onProgress: (progress: ProcessingProgress) => void
): Promise<SceneProject> {
  const form = new FormData();
  form.append("file", file);
  const job = await request<ProcessingJobStart>("/api/jobs/analyze", { method: "POST", body: form });
  return waitForJob(job.jobId, onProgress);
}

export async function analyzeSample(onProgress: (progress: ProcessingProgress) => void): Promise<SceneProject> {
  const job = await request<ProcessingJobStart>("/api/jobs/sample", { method: "POST" });
  return waitForJob(job.jobId, onProgress);
}

export async function inpaintProject(
  projectId: string,
  layerIds: string[],
  refinement: InpaintRefinement,
  prompt: string | undefined,
  onProgress: (progress: ProcessingProgress) => void
): Promise<SceneProject> {
  const job = await request<ProcessingJobStart>(`/api/jobs/projects/${projectId}/inpaint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layerIds, refinement, prompt: prompt?.trim() || null })
  });
  return waitForJob(job.jobId, onProgress);
}

export async function inpaintProjectTarget(
  projectId: string,
  targetId: string | null,
  composition: Blob,
  mask: Blob,
  prompt: string | undefined,
  onProgress: (progress: ProcessingProgress) => void
): Promise<SceneProject> {
  const form = new FormData();
  form.append("composition", composition, "composition.png");
  form.append("mask", mask, "inpaint-mask.png");
  form.append("prompt", prompt?.trim() ?? "");
  const project = encodeURIComponent(projectId);
  const target = encodeURIComponent(targetId ?? "background");
  const job = await request<ProcessingJobStart>(`/api/jobs/projects/${project}/targets/${target}/inpaint`, {
    method: "POST",
    body: form
  });
  return waitForJob(job.jobId, onProgress);
}

export function getInpaintHistory(projectId: string): Promise<InpaintHistoryState[]> {
  return request<InpaintHistoryState[]>(`/api/projects/${encodeURIComponent(projectId)}/inpaint-history`);
}

function restoreProjectTargetInpaint(projectId: string, targetId: string | null, action: "undo" | "redo"): Promise<SceneProject> {
  const project = encodeURIComponent(projectId);
  const target = encodeURIComponent(targetId ?? "background");
  return request<SceneProject>(`/api/projects/${project}/targets/${target}/${action}-inpaint`, { method: "POST" });
}

export function undoProjectTargetInpaint(projectId: string, targetId: string | null): Promise<SceneProject> {
  return restoreProjectTargetInpaint(projectId, targetId, "undo");
}

export function redoProjectTargetInpaint(projectId: string, targetId: string | null): Promise<SceneProject> {
  return restoreProjectTargetInpaint(projectId, targetId, "redo");
}

export async function refineProjectLayer(
  projectId: string,
  layerId: string,
  onProgress: (progress: ProcessingProgress) => void
): Promise<SceneProject> {
  const project = encodeURIComponent(projectId);
  const layer = encodeURIComponent(layerId);
  const job = await request<ProcessingJobStart>(`/api/jobs/projects/${project}/layers/${layer}/refine`, {
    method: "POST"
  });
  return waitForJob(job.jobId, onProgress);
}

export function confirmProjectLayer(projectId: string, layerId: string): Promise<SceneProject> {
  return request<SceneProject>(
    `/api/projects/${encodeURIComponent(projectId)}/layers/${encodeURIComponent(layerId)}/confirm`,
    { method: "POST" }
  );
}

export function updateProjectMask(projectId: string, layerId: string | null, mask: Blob): Promise<SceneProject> {
  const form = new FormData();
  form.append("file", mask, "edited-mask.png");
  const encodedProjectId = encodeURIComponent(projectId);
  const path = layerId
    ? `/api/projects/${encodedProjectId}/layers/${encodeURIComponent(layerId)}/mask`
    : `/api/projects/${encodedProjectId}/extra-mask`;
  return request<SceneProject>(path, { method: "POST", body: form });
}

export async function exportProjectPackage(project: SceneProject, camera: CameraState): Promise<Blob> {
  const response = await fetch(`${SERVICE_ORIGIN}/api/projects/${project.id}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      camera,
      layers: project.layers.map(({ id, depth, order, selected, visible }) => ({ id, depth, order, selected, visible }))
    })
  });
  if (!response.ok) {
    await throwResponseError(response);
  }
  return response.blob();
}

export function importProjectPackage(file: File): Promise<ImportedProject> {
  const form = new FormData();
  form.append("file", file);
  return request<ImportedProject>("/api/projects/import", { method: "POST", body: form });
}

async function throwResponseError(response: Response): Promise<never> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    throw new Error(`Local service failed with HTTP ${response.status}.`);
  }
  if (typeof body.detail === "object") {
    throw new Error([body.detail.message, body.detail.detail].filter(Boolean).join(" "));
  }
  throw new Error(body.message ?? body.detail ?? `Local service failed with HTTP ${response.status}.`);
}
