export type Engine = "ai" | "preview";

export interface ProviderStatus {
  available: boolean;
  detail: string;
  state?:
    | "waiting"
    | "starting"
    | "downloading"
    | "initializing"
    | "ready"
    | "blocked";
  progress?: number | null;
}

export interface HealthStatus {
  status: string;
  version: string;
  configuredMode: "auto" | Engine;
  activeEngine: Engine;
  device: string;
  localOnly: boolean;
  providers: Record<string, ProviderStatus>; // Feature gates use readiness details without instantiating models.
  message: string;
  startupState:
    | "starting"
    | "downloading"
    | "initializing"
    | "ready"
    | "blocked";
  startupDetail: string | null;
  startupProvider: string | null;
  startupProgress: number | null;
}

export interface SceneLayer {
  id: string;
  name: string;
  cutoutUrl: string;
  maskUrl: string;
  proposalMaskUrl: string | null;
  refinementState: "rough" | "refined";
  confirmed: boolean;
  maskRevision: number;
  depth: number;
  order: number;
  // Anchor nudge applied on top of the parallax transform, as a fraction of the
  // composition size, so it survives a canvas resize.
  offsetX: number;
  offsetY: number;
  selected: boolean;
  visible: boolean;
  bounds: [number, number, number, number];
  kind: "instance" | "depth-plane" | "manual";
  confidence: number;
}

export interface SceneProject {
  id: string;
  width: number;
  height: number;
  sourceUrl: string;
  backgroundUrl: string | null;
  unionMaskUrl: string | null;
  extraMaskUrl?: string | null;
  depthMapUrl: string | null;
  backgroundPrompt: string | null;
  inpaintProvider: "preview" | "big-lama" | "powerpaint" | null;
  vramPeaksMb: Record<string, number>; // Per-stage diagnostics returned after an AI run.
  engine: Engine;
  layers: SceneLayer[];
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  strength: number;
}

export interface ImportedProject {
  project: SceneProject;
  camera: CameraState;
}

export type ProcessingJobKind =
  | "analyze"
  | "refine"
  | "inpaint"
  | "segmentation:detect"
  | "depth:estimate"
  | "matting:refine"
  | "inpainting:fill"
  | "vlm:vocabulary"
  | "vlm:caption";

export interface ProcessingProgress {
  // Stages are coarse-grained by design; detailed model progress stays in the
  // message while the UI can render one stable progress indicator.
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  stage: string;
  message: string;
  queuePosition: number | null;
}

export interface InpaintHistoryState {
  targetId: string;
  canUndo: boolean;
  canRedo: boolean;
}

export type WorkflowPhase =
  | "idle"
  | "analyzing"
  | "selecting"
  | "inpainting"
  | "editing";
export type InpaintRefinement = "lama" | "powerpaint";
