from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ErrorPayload(BaseModel):
    code: str
    message: str
    detail: str | None = None


class ProviderStatus(BaseModel):
    available: bool
    detail: str


class HealthPayload(BaseModel):
    status: str = "ok"
    version: str = "0.1.0"
    configuredMode: str
    activeEngine: str
    device: str
    localOnly: bool = True
    providers: dict[str, ProviderStatus]
    message: str


class LayerPayload(BaseModel):
    id: str
    name: str
    cutoutUrl: str
    maskUrl: str
    proposalMaskUrl: str | None = None
    refinementState: Literal["rough", "refined"] = "rough"
    confirmed: bool = True
    maskRevision: int = Field(default=0, ge=0)
    depth: float
    order: int
    selected: bool = True
    visible: bool = True
    bounds: tuple[int, int, int, int]
    kind: Literal["instance", "depth-plane"] = "instance"
    confidence: float = 1.0


class ProjectPayload(BaseModel):
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
    vramPeaksMb: dict[str, int] = Field(default_factory=dict)
    engine: str
    layers: list[LayerPayload]


class InpaintRequest(BaseModel):
    layerIds: list[str] = Field(min_length=1)
    refinement: Literal["lama", "powerpaint"] = "lama"
    prompt: str | None = Field(default=None, max_length=500)


class InpaintHistoryPayload(BaseModel):
    targetId: str
    canUndo: bool
    canRedo: bool


class CameraPayload(BaseModel):
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
    state: Literal["queued", "running", "completed", "failed"]
    progress: int = Field(ge=0, le=100)
    stage: str
    message: str
    result: ProjectPayload | None = None
