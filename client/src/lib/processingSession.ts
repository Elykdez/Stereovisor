import type { ProcessingPreview, SceneProject, WorkflowPhase } from "../types";
import { appLog } from "./logger";
import { resolveServiceOrigin } from "./serviceOrigin";

export interface ProcessingSession {
  jobId: string;
  kind: "analyze" | "inpaint" | "refine" | "target-inpaint";
  project: SceneProject | null;
  phase: WorkflowPhase;
  preview?: ProcessingPreview | null;
  layerId?: string | null;
}

function storageKey(): string {
  return `stereovisor.processing:${resolveServiceOrigin() || window.location.origin}`;
}

export function readProcessingSession(): ProcessingSession | null {
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return null;
    const session = JSON.parse(raw) as ProcessingSession;
    if (
      !session || typeof session.jobId !== "string" || !session.jobId ||
      !["analyze", "inpaint", "refine", "target-inpaint"].includes(session.kind) ||
      !["idle", "analyzing", "selecting", "inpainting", "editing"].includes(session.phase) ||
      (session.project !== null && (
        !session.project || typeof session.project.id !== "string" || !Array.isArray(session.project.layers)
      ))
    ) {
      window.localStorage.removeItem(storageKey());
      return null;
    }
    const preview = session.preview;
    if (preview && (
      typeof preview.sourceUrl !== "string" || !preview.sourceUrl.startsWith("data:image/jpeg;base64,") ||
      !Number.isInteger(preview.width) || preview.width < 1 || preview.width > 1024 ||
      !Number.isInteger(preview.height) || preview.height < 1 || preview.height > 1024
    )) session.preview = null;
    if (session.layerId != null && typeof session.layerId !== "string") session.layerId = null;
    return session;
  } catch (error) {
    appLog.warn("processing.session.read-failed", { error: String(error) });
    return null;
  }
}

export function saveProcessingSession(session: ProcessingSession): void {
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(session));
  } catch (error) {
    appLog.warn("processing.session.save-failed", { error: String(error) });
  }
}

export function clearProcessingSession(jobId: string): void {
  try {
    // An older observer finishing must not erase a newer job's recovery data.
    if (readProcessingSession()?.jobId === jobId) window.localStorage.removeItem(storageKey());
  } catch (error) {
    appLog.warn("processing.session.clear-failed", { error: String(error) });
  }
}
