from __future__ import annotations

import io
import logging
from typing import Callable

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
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
from .jobs import ProcessingJobStore
from .pipeline import (
    PipelineError,
    PreviewPipeline,
    ProductionPipeline,
    ProgressCallback,
    confirm_layer_mask,
    create_sample_image,
    inpaint_history,
    replace_layer_mask,
    restore_inpaint_history,
    save_extra_inpaint_mask,
)
from .schemas import (
    HealthPayload,
    InpaintHistoryPayload,
    InpaintRequest,
    ProcessingJobPayload,
    ProcessingJobStart,
    ProjectExportRequest,
    ProjectImportPayload,
    ProjectPayload,
    ProviderStatus,
)
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
jobs = ProcessingJobStore()
logger = logging.getLogger(__name__)


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


def _analyze_image(image: Image.Image, progress: ProgressCallback | None = None) -> ProjectPayload:
    if progress is not None:
        progress(3, "Preparing image", "Normalizing orientation and color.")
    image = ImageOps.exif_transpose(image).convert("RGB")
    project_id, directory = store.create(image)
    try:
        project = _pipeline().analyze(image, directory, project_id, progress=progress)
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "ANALYSIS_FAILED", "message": str(error)},
        ) from error
    store.write(project)
    return project


async def _decode_upload(file: UploadFile) -> Image.Image:
    if file.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=415, detail={"code": "UNSUPPORTED_IMAGE", "message": "Use PNG, JPEG, or WebP."})
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail={"code": "IMAGE_TOO_LARGE", "message": "Images are limited to 40 MB."})
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        return image
    except (UnidentifiedImageError, OSError) as error:
        raise HTTPException(status_code=422, detail={"code": "DECODE_FAILED", "message": "The selected file is not a readable image."}) from error


def _inpaint_project(
    project_id: str,
    request: InpaintRequest,
    progress: ProgressCallback | None = None,
) -> ProjectPayload:
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = _pipeline().inpaint(
            project,
            directory,
            request.layerIds,
            refinement=request.refinement,
            prompt=request.prompt,
            progress=progress,
        )
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "INPAINT_FAILED", "message": str(error)}) from error


def _inpaint_project_target(
    project_id: str,
    target_id: str,
    composition: Image.Image,
    mask: Image.Image,
    prompt: str | None,
    progress: ProgressCallback | None = None,
) -> ProjectPayload:
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = _pipeline().inpaint_target(
            project,
            directory,
            target_id,
            composition,
            mask,
            prompt=prompt,
            progress=progress,
        )
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "LAYER_INPAINT_FAILED", "message": str(error)}) from error


def _read_inpaint_history(project_id: str) -> list[InpaintHistoryPayload]:
    try:
        directory = store.directory(project_id)
        return inpaint_history(store.read(project_id), directory)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error


def _restore_project_target_inpaint(project_id: str, target_id: str, action: str) -> ProjectPayload:
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = restore_inpaint_history(project, directory, target_id, action)
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "INPAINT_HISTORY_FAILED", "message": str(error)}) from error


def _refine_project(
    project_id: str,
    layer_id: str,
    progress: ProgressCallback | None = None,
) -> ProjectPayload:
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = _pipeline().refine(project, directory, layer_id, progress=progress)
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "REFINE_FAILED", "message": str(error)}) from error


def _confirm_project_layer(project_id: str, layer_id: str) -> ProjectPayload:
    try:
        project = store.read(project_id)
        updated = confirm_layer_mask(project, layer_id)
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "MASK_CONFIRM_FAILED", "message": str(error)}) from error


def _save_edited_mask(project_id: str, mask: Image.Image, layer_id: str | None = None) -> ProjectPayload:
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = (
            replace_layer_mask(project, directory, layer_id, mask)
            if layer_id is not None
            else save_extra_inpaint_mask(project, directory, mask)
        )
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "MASK_EDIT_FAILED", "message": str(error)}) from error


def _error_message(error: Exception) -> str:
    if isinstance(error, HTTPException):
        detail = error.detail
        if isinstance(detail, dict):
            return " ".join(str(detail[key]) for key in ("message", "detail") if detail.get(key))
        return str(detail)
    return str(error) or "Local processing failed."


def _run_job(job_id: str, operation: Callable[[ProgressCallback], ProjectPayload]) -> None:
    jobs.update(job_id, 1, "Starting", "Starting the local AI worker.")
    try:
        result = operation(lambda percent, stage, message: jobs.update(job_id, percent, stage, message))
        jobs.complete(job_id, result)
    except Exception as error:
        jobs.fail(job_id, _error_message(error))
        logger.exception("Processing job %s failed", job_id)


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
    return _analyze_image(await _decode_upload(file))


@app.post("/api/sample", response_model=ProjectPayload)
def sample() -> ProjectPayload:
    return _analyze_image(create_sample_image())


@app.post("/api/jobs/analyze", response_model=ProcessingJobStart)
async def start_analyze_job(background_tasks: BackgroundTasks, file: UploadFile = File(...)) -> ProcessingJobStart:
    image = await _decode_upload(file)
    job_id = jobs.create("analyze")
    background_tasks.add_task(_run_job, job_id, lambda progress: _analyze_image(image, progress))
    return ProcessingJobStart(jobId=job_id)


@app.post("/api/jobs/sample", response_model=ProcessingJobStart)
def start_sample_job(background_tasks: BackgroundTasks) -> ProcessingJobStart:
    image = create_sample_image()
    job_id = jobs.create("analyze")
    background_tasks.add_task(_run_job, job_id, lambda progress: _analyze_image(image, progress))
    return ProcessingJobStart(jobId=job_id)


@app.post("/api/jobs/projects/{project_id}/inpaint", response_model=ProcessingJobStart)
def start_inpaint_job(project_id: str, request: InpaintRequest, background_tasks: BackgroundTasks) -> ProcessingJobStart:
    job_id = jobs.create("inpaint")
    background_tasks.add_task(_run_job, job_id, lambda progress: _inpaint_project(project_id, request, progress))
    return ProcessingJobStart(jobId=job_id)


@app.post("/api/jobs/projects/{project_id}/layers/{layer_id}/refine", response_model=ProcessingJobStart)
def start_refine_job(project_id: str, layer_id: str, background_tasks: BackgroundTasks) -> ProcessingJobStart:
    job_id = jobs.create("refine")
    background_tasks.add_task(_run_job, job_id, lambda progress: _refine_project(project_id, layer_id, progress))
    return ProcessingJobStart(jobId=job_id)


@app.post("/api/jobs/projects/{project_id}/targets/{target_id}/inpaint", response_model=ProcessingJobStart)
async def start_target_inpaint_job(
    project_id: str,
    target_id: str,
    background_tasks: BackgroundTasks,
    composition: UploadFile = File(...),
    mask: UploadFile = File(...),
    prompt: str | None = Form(default=None),
) -> ProcessingJobStart:
    composition_image = await _decode_upload(composition)
    mask_image = await _decode_upload(mask)
    job_id = jobs.create("inpaint")
    background_tasks.add_task(
        _run_job,
        job_id,
        lambda progress: _inpaint_project_target(
            project_id,
            target_id,
            composition_image,
            mask_image,
            prompt,
            progress,
        ),
    )
    return ProcessingJobStart(jobId=job_id)


@app.get("/api/jobs/{job_id}", response_model=ProcessingJobPayload)
def processing_job(job_id: str) -> ProcessingJobPayload:
    try:
        return jobs.read(job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail={"code": "JOB_NOT_FOUND", "message": "The processing job no longer exists."}) from error


@app.get("/api/projects/{project_id}/inpaint-history", response_model=list[InpaintHistoryPayload])
def get_project_inpaint_history(project_id: str) -> list[InpaintHistoryPayload]:
    return _read_inpaint_history(project_id)


@app.post("/api/projects/{project_id}/targets/{target_id}/undo-inpaint", response_model=ProjectPayload)
def undo_target_inpaint(project_id: str, target_id: str) -> ProjectPayload:
    return _restore_project_target_inpaint(project_id, target_id, "undo")


@app.post("/api/projects/{project_id}/targets/{target_id}/redo-inpaint", response_model=ProjectPayload)
def redo_target_inpaint(project_id: str, target_id: str) -> ProjectPayload:
    return _restore_project_target_inpaint(project_id, target_id, "redo")


@app.post("/api/projects/{project_id}/inpaint", response_model=ProjectPayload)
def inpaint(project_id: str, request: InpaintRequest) -> ProjectPayload:
    return _inpaint_project(project_id, request)


@app.post("/api/projects/{project_id}/layers/{layer_id}/mask", response_model=ProjectPayload)
async def update_layer_mask(project_id: str, layer_id: str, file: UploadFile = File(...)) -> ProjectPayload:
    return _save_edited_mask(project_id, await _decode_upload(file), layer_id)


@app.post("/api/projects/{project_id}/layers/{layer_id}/confirm", response_model=ProjectPayload)
def confirm_mask(project_id: str, layer_id: str) -> ProjectPayload:
    return _confirm_project_layer(project_id, layer_id)


@app.post("/api/projects/{project_id}/extra-mask", response_model=ProjectPayload)
async def update_extra_mask(project_id: str, file: UploadFile = File(...)) -> ProjectPayload:
    return _save_edited_mask(project_id, await _decode_upload(file))


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
