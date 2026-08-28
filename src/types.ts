export type Engine = "ai" | "preview";

export interface ProviderStatus {
  available: boolean;
  detail: string;
}

export interface HealthStatus {
  status: string;
  version: string;
  configuredMode: "auto" | Engine;
  activeEngine: Engine;
  device: string;
  localOnly: true;
  providers: Record<string, ProviderStatus>;
  message: string;
}

export interface SceneLayer {
  id: string;
  name: string;
  cutoutUrl: string;
  maskUrl: string;
  depth: number;
  order: number;
  selected: boolean;
  visible: boolean;
  bounds: [number, number, number, number];
  kind: "instance" | "depth-plane";
  confidence: number;
}

export interface SceneProject {
  id: string;
  width: number;
  height: number;
  sourceUrl: string;
  backgroundUrl: string | null;
  unionMaskUrl: string | null;
  depthMapUrl: string | null;
  backgroundPrompt: string | null;
  inpaintProvider: "preview" | "big-lama" | "powerpaint" | null;
  vramPeaksMb: Record<string, number>;
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

export type WorkflowPhase = "idle" | "analyzing" | "selecting" | "inpainting" | "editing";
export type InpaintRefinement = "lama" | "powerpaint";
