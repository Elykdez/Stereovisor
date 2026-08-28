import type { CameraState, HealthStatus, ImportedProject, InpaintRefinement, SceneProject } from "../types";

const SERVICE_ORIGIN = import.meta.env.DEV ? "" : "http://127.0.0.1:5179";

interface ApiErrorBody {
  detail?: string | { code?: string; message?: string; detail?: string };
  message?: string;
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

export function analyzeImage(file: File): Promise<SceneProject> {
  const form = new FormData();
  form.append("file", file);
  return request<SceneProject>("/api/analyze", { method: "POST", body: form });
}

export function analyzeSample(): Promise<SceneProject> {
  return request<SceneProject>("/api/sample", { method: "POST" });
}

export function inpaintProject(
  projectId: string,
  layerIds: string[],
  refinement: InpaintRefinement,
  prompt?: string
): Promise<SceneProject> {
  return request<SceneProject>(`/api/projects/${projectId}/inpaint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layerIds, refinement, prompt: prompt?.trim() || null })
  });
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
