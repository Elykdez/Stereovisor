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


class LayerPayload(BaseModel):
    """Serializable layer plus review state needed for safe inpainting."""
    id: str
    name: str
    cutoutUrl: str
    maskUrl: str
    proposalMaskUrl: str | None = None
    refinementState: Literal["rough", "refined"] = "rough"  # Quality shown in the review UI.
    confirmed: bool = True  # Selected masks must be confirmed before background inpainting.
    maskRevision: int = Field(default=0, ge=0)  # Cache-busting revision for edited alpha assets.
    depth: float
    order: int
    selected: bool = True
    visible: bool = True
    bounds: tuple[int, int, int, int]
    kind: Literal["instance", "depth-plane"] = "instance"
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
    vramPeaksMb: dict[str, int] = Field(default_factory=dict)  # Diagnostics, not a readiness claim.
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


class ProcessingJobPayload(BaseModel):
    jobId: str
    kind: Literal["analyze", "refine", "inpaint"]
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    progress: int = Field(ge=0, le=100)
    stage: str
    message: str
    result: ProjectPayload | None = None
