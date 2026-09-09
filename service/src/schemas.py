from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SegmentationDensity = Literal["sparse", "balanced", "dense"]


class ErrorPayload(BaseModel):
    code: str
    message: str
    detail: str | None = None


class ProviderStatus(BaseModel):
    available: bool
    detail: str
    state: Literal[
        "waiting", "starting", "downloading", "initializing", "ready", "blocked"
    ] = "waiting"
    progress: int | None = Field(default=None, ge=0, le=100)


class HealthPayload(BaseModel):
    """Readiness summary consumed by renderer feature gates."""

    status: str = "ok"
    version: str = "0.1.0"
    configuredMode: str
    activeEngine: str
    device: str
    localOnly: bool = True
    providers: dict[str, ProviderStatus]
    message: str
    startupState: Literal[
        "starting", "downloading", "initializing", "ready", "blocked"
    ] = "blocked"
    startupDetail: str | None = None
    startupProvider: str | None = None
    startupProgress: int | None = Field(default=None, ge=0, le=100)


class LayerPayload(BaseModel):
    """Serializable layer plus review state needed for safe inpainting."""

    id: str
    name: str
    cutoutUrl: str
    maskUrl: str
    proposalMaskUrl: str | None = None
    refinementState: Literal["rough", "refined"] = (
        "rough"  # Quality shown in the review UI.
    )
    confirmed: bool = (
        True  # Selected masks must be confirmed before background inpainting.
    )
    maskRevision: int = Field(
        default=0, ge=0
    )  # Cache-busting revision for edited alpha assets.
    depth: float
    order: int
    # Anchor nudge as a fraction of the composition size, applied on top of the
    # parallax transform so a repositioned layer survives export/import.
    offsetX: float = Field(default=0.0, ge=-1, le=1)
    offsetY: float = Field(default=0.0, ge=-1, le=1)
    selected: bool = True
    visible: bool = True
    bounds: tuple[int, int, int, int]
    # "manual" marks a hand-brushed layer: it is refined by edge-guided
    # segmentation instead of salient-subject matting.
    kind: Literal["instance", "depth-plane", "manual"] = "instance"
    confidence: float = 1.0


class ProjectPayload(BaseModel):
    """Project metadata whose asset URLs resolve through the local service."""

    id: str
    width: int
    height: int
    sourceUrl: str
    backgroundUrl: str | None = None
    unionMaskUrl: str | None = None
    extraMaskUrl: str | None = None
    depthMapUrl: str | None = None
    backgroundPrompt: str | None = None
    inpaintProvider: Literal["preview", "big-lama", "powerpaint"] | None = None
    vramPeaksMb: dict[str, int] = Field(
        default_factory=dict
    )  # Diagnostics, not a readiness claim.
    engine: str  # Lets the renderer explain preview versus local-AI capabilities.
    layers: list[LayerPayload]


class InpaintRequest(BaseModel):
    """Validated background-build request with bounded model work."""

    layerIds: list[str] = Field(min_length=1)
    refinement: Literal["lama", "powerpaint"] = "lama"
    prompt: str | None = Field(default=None, max_length=500)
    steps: int = Field(default=25, ge=5, le=100)


class InpaintHistoryPayload(BaseModel):
    targetId: str
    canUndo: bool
    canRedo: bool


class MergeLayersRequest(BaseModel):
    """Layer IDs selected for a destructive-but-reversible mask merge."""

    layerIds: list[str] = Field(min_length=2)


class RenameLayerRequest(BaseModel):
    """User-supplied layer name, bounded before it reaches project storage."""

    name: str = Field(min_length=1, max_length=80)


class CameraPayload(BaseModel):
    """Portable camera state with bounds matching renderer transforms."""

    x: float = Field(ge=-1, le=1)
    y: float = Field(ge=-1, le=1)
    zoom: float = Field(ge=1, le=1.35)
    strength: float = Field(ge=0, le=100)


class LayerEditorPayload(BaseModel):
    id: str
    depth: float = Field(ge=0, le=1)
    order: int = Field(ge=0)
    offsetX: float = Field(default=0.0, ge=-1, le=1)
    offsetY: float = Field(default=0.0, ge=-1, le=1)
    selected: bool
    visible: bool


class ProjectExportRequest(BaseModel):
    """Export includes every layer state so hidden/ordered edits round-trip."""

    camera: CameraPayload
    layers: list[LayerEditorPayload] = Field(min_length=1)


class ProjectImportPayload(BaseModel):
    project: ProjectPayload
    camera: CameraPayload


class ProcessingJobStart(BaseModel):
    jobId: str


class CapabilityParameter(BaseModel):
    """One accepted input of a capability, described for programmatic callers."""

    name: str
    type: Literal["string", "number", "boolean", "enum"]
    default: str | float | bool | None = None
    options: list[str] | None = None


class CapabilityDescriptor(BaseModel):
    """One addressable AI component and the contract for calling it."""

    id: str
    provider: str  # The /api/health provider key that gates this capability.
    model: str
    summary: str
    endpoint: str | None  # None while a component stays workflow-only.
    available: bool
    detail: str
    device: str
    vramBudgetMb: int
    modelRoot: str
    parameters: list[CapabilityParameter] = Field(default_factory=list)


class CapabilityInventory(BaseModel):
    activeEngine: str
    device: str
    capabilities: list[CapabilityDescriptor]


class DetectedInstance(BaseModel):
    label: str
    score: float
    bounds: tuple[int, int, int, int]
    maskPng: str  # base64 PNG, so one JSON response carries the whole result.


class SegmentationResult(BaseModel):
    instances: list[DetectedInstance]
    vramPeaksMb: dict[str, int] = Field(default_factory=dict)


class DepthResult(BaseModel):
    depthPreviewPng: str
    vramPeaksMb: dict[str, int] = Field(default_factory=dict)


class MattingResult(BaseModel):
    alphaPng: str
    vramPeaksMb: dict[str, int] = Field(default_factory=dict)


class InpaintingResult(BaseModel):
    imagePng: str
    provider: str
    vramPeaksMb: dict[str, int] = Field(default_factory=dict)


class VocabularyResult(BaseModel):
    labels: list[str]
    vramPeaksMb: dict[str, int] = Field(default_factory=dict)


class CaptionResult(BaseModel):
    prompt: str
    vramPeaksMb: dict[str, int] = Field(default_factory=dict)


WorkflowJobKind = Literal["analyze", "refine", "inpaint"]
CapabilityJobKind = Literal[
    "segmentation:detect",
    "depth:estimate",
    "matting:refine",
    "inpainting:fill",
    "vlm:vocabulary",
    "vlm:caption",
]
JobKind = WorkflowJobKind | CapabilityJobKind
JobResult = (
    ProjectPayload
    | SegmentationResult
    | DepthResult
    | MattingResult
    | InpaintingResult
    | VocabularyResult
    | CaptionResult
)


class ProcessingJobPayload(BaseModel):
    jobId: str
    kind: JobKind
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    progress: int = Field(ge=0, le=100)
    stage: str
    message: str
    # How many jobs must finish first; None once running or terminal. The same
    # information is mirrored into `message` so existing UI needs no change.
    queuePosition: int | None = Field(default=None, ge=0)
    result: JobResult | None = None
