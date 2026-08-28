from __future__ import annotations

import io

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import (
    MAX_UPLOAD_BYTES,
    MAX_PROJECT_PACKAGE_BYTES,
    MODE,
    PROJECT_ROOT,
    active_engine,
    ai_dependencies,
    production_available,
    runtime_device,
)
from .pipeline import PipelineError, PreviewPipeline, ProductionPipeline, create_sample_image
from .schemas import HealthPayload, InpaintRequest, ProjectExportRequest, ProjectImportPayload, ProjectPayload, ProviderStatus
from .storage import ProjectPackageError, ProjectStore


app = FastAPI(title="Stereovisor local vision service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "null"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type"],
)
store = ProjectStore(PROJECT_ROOT)


def _pipeline():
    engine = active_engine()
    if engine == "ai":
        if not production_available():
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "AI_STACK_MISSING",
                    "message": "The local AI stack is not installed.",
                    "detail": "Run scripts/setup-ai.ps1, then restart Stereovisor.",
                },
            )
        return ProductionPipeline()
    return PreviewPipeline()


def _analyze_image(image: Image.Image) -> ProjectPayload:
    image = ImageOps.exif_transpose(image).convert("RGB")
    project_id, directory = store.create(image)
    try:
        project = _pipeline().analyze(image, directory, project_id)
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "ANALYSIS_FAILED", "message": str(error)},
        ) from error
    store.write(project)
    return project


@app.get("/api/health", response_model=HealthPayload)
def health() -> HealthPayload:
    dependencies = ai_dependencies()
    engine = active_engine()
    actual_device = runtime_device()
    if engine == "ai":
        message = f"Local AI engine ready on {actual_device}. Inference stays on this machine."
    elif MODE == "preview" and production_available():
        message = "Preview engine selected by configuration. Set STEREOVISOR_MODE=ai to use the installed local models."
    else:
        missing = ", ".join(key for key, value in dependencies.items() if not value.available)
        message = f"Preview engine active. Install the local AI stack for production processing: {missing}."
    return HealthPayload(
        configuredMode=MODE,
        activeEngine=engine,
        device=actual_device,
        providers={
            key: ProviderStatus(available=value.available, detail=value.detail)
            for key, value in dependencies.items()
        },
        message=message,
    )


@app.post("/api/analyze", response_model=ProjectPayload)
async def analyze(file: UploadFile = File(...)) -> ProjectPayload:
    if file.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=415, detail={"code": "UNSUPPORTED_IMAGE", "message": "Use PNG, JPEG, or WebP."})
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail={"code": "IMAGE_TOO_LARGE", "message": "Images are limited to 40 MB."})
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError) as error:
        raise HTTPException(status_code=422, detail={"code": "DECODE_FAILED", "message": "The selected file is not a readable image."}) from error
    return _analyze_image(image)


@app.post("/api/sample", response_model=ProjectPayload)
def sample() -> ProjectPayload:
    return _analyze_image(create_sample_image())


@app.post("/api/projects/{project_id}/inpaint", response_model=ProjectPayload)
def inpaint(project_id: str, request: InpaintRequest) -> ProjectPayload:
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = _pipeline().inpaint(
            project,
            directory,
            request.layerIds,
            refinement=request.refinement,
            prompt=request.prompt,
        )
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "INPAINT_FAILED", "message": str(error)}) from error


@app.get("/api/projects/{project_id}/assets/{name}")
def asset(project_id: str, name: str) -> FileResponse:
    try:
        path = store.asset(project_id, name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "ASSET_NOT_FOUND", "message": "The project asset does not exist."}) from error
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post("/api/projects/{project_id}/export")
def export_project(project_id: str, request: ProjectExportRequest) -> Response:
    try:
        package = store.export_package(project_id, request.camera, request.layers)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except ProjectPackageError as error:
        raise HTTPException(status_code=422, detail={"code": "EXPORT_FAILED", "message": str(error)}) from error
    return Response(
        content=package,
        media_type="application/vnd.stereovisor.project+zip",
        headers={"Content-Disposition": f'attachment; filename="stereovisor-{project_id[:8]}.stereovisor"'},
    )


@app.post("/api/projects/import", response_model=ProjectImportPayload)
async def import_project(file: UploadFile = File(...)) -> ProjectImportPayload:
    data = await file.read(MAX_PROJECT_PACKAGE_BYTES + 1)
    if len(data) > MAX_PROJECT_PACKAGE_BYTES:
        raise HTTPException(status_code=413, detail={"code": "PROJECT_TOO_LARGE", "message": "Project packages are limited to 512 MB."})
    try:
        project, camera = store.import_package(data)
    except ProjectPackageError as error:
        raise HTTPException(status_code=422, detail={"code": "IMPORT_FAILED", "message": str(error)}) from error
    return ProjectImportPayload(project=project, camera=camera)
