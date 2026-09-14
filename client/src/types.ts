export type Engine = "ai" | "preview";

export const DEFAULT_LAYER_FEATHER = 4;

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

export interface ServerActivity {
  state: "idle" | "running" | "queued" | "stopping";
  queuedJobs: number;
  stage: string | null;
  compute: ComputeStatus | null;
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
  activity?: ServerActivity | null;
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
  feather?: number | null;
  // Signed correction applied after the camera derives blur from layer depth.
  blur?: number;
  centerPull?: number;
  scale?: number;
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
  // Reverse depth-driven motion without changing layer stacking or focus.
  inverseDepth?: boolean;
  // Signed centering control: 0.5 is neutral, above pulls toward center and
  // below pushes away from center.
  centerPull?: number;
  // Uniform scale applied to the complete scene framing.
  sceneScale?: number;
  // Maximum blur, in composition pixels, for a layer one full depth unit away
  // from the focus plane. Zero keeps the legacy sharp rendering.
  depthOfField?: number;
  // Normalized scene depth kept sharp by the depth-of-field pass.
  focusDepth?: number;
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

export interface ComputeStatus {
  model: string;
  device: "cpu" | "cuda" | "hybrid";
  phase: "loading" | "preparing" | "inference" | "cleanup";
  reason?: "cpu_requested" | "cuda_unavailable" | "offloading" | null;
  gpuName?: string | null;
  // The latest worker-reported snapshot, not a live hardware monitor.
  vramUsedMb?: number | null;
  vramTotalMb?: number | null;
  completed?: number | null;
  total?: number | null;
  unit?: "tokens" | "steps" | null;
  elapsedSeconds: number;
  idleSeconds: number;
}

export interface ProcessingProgress {
  // Overall stages stay stable while compute reports activity within a model.
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  stage: string;
  message: string;
  queuePosition: number | null;
  compute?: ComputeStatus | null;
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
