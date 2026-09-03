from __future__ import annotations

import io
import logging
import math
import shutil
import time
from typing import Callable

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import (
    MAX_IMAGE_PIXELS,
    MAX_UPLOAD_BYTES,
    MAX_PROJECT_PACKAGE_BYTES,
    MODE,
    PROJECT_ROOT,
    REQUIRED_PROVIDERS,
    active_engine,
    ai_dependencies,
    bootstrap_status,
    production_available,
    runtime_device,
)
from .jobs import JobCancelled, ProcessingJobStore
from .pipeline import (
    PipelineError,
    PreviewPipeline,
    ProductionPipeline,
    ProgressCallback,
    confirm_layer_mask,
    create_layer_from_mask,
    create_sample_image,
    delete_layer,
    inpaint_history,
    layer_merge_history,
    merge_layer_masks,
    mask_history,
    rename_layer,
    replace_layer_mask,
    restore_layer_merge_history,
    restore_mask_history,
    restore_inpaint_history,
    save_extra_inpaint_mask,
)
from .schemas import (
    HealthPayload,
    InpaintHistoryPayload,
    InpaintRequest,
    MergeLayersRequest,
    ProcessingJobPayload,
    ProcessingJobStart,
    ProjectExportRequest,
    ProjectImportPayload,
    ProjectPayload,
    ProviderStatus,
    RenameLayerRequest,
    SegmentationDensity,
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
CancelCheck = Callable[[], None]


def _downsample_image(image: Image.Image) -> Image.Image:
    """Return an aspect-preserving copy whose area is at most 4MP."""
    source_pixels = image.width * image.height
    if source_pixels <= MAX_IMAGE_PIXELS:
        return image

    original_size = image.size
    scale = math.sqrt(MAX_IMAGE_PIXELS / source_pixels)
    bounded_width = max(1, math.floor(image.width * scale))
    bounded_height = max(1, math.floor(image.height * scale))
    if bounded_width * bounded_height > MAX_IMAGE_PIXELS:
        # This only matters for extremely narrow images where rounding a
        # sub-pixel dimension up to one could otherwise exceed the area cap.
        if bounded_width >= bounded_height:
            bounded_width = max(1, MAX_IMAGE_PIXELS // bounded_height)
        else:
            bounded_height = max(1, MAX_IMAGE_PIXELS // bounded_width)
    bounded_size = (bounded_width, bounded_height)
    # Applying the same scale to both dimensions preserves the source ratio;
    # flooring keeps the resulting pixel area at or below the configured cap.
    bounded = image.resize(bounded_size, Image.Resampling.LANCZOS)
    logger.info(
        "image downsampled: original=%sx%s pixels=%s bounded=%sx%s pixels=%s max_pixels=%s",
        original_size[0],
        original_size[1],
        source_pixels,
        bounded.width,
        bounded.height,
        bounded.width * bounded.height,
        MAX_IMAGE_PIXELS,
    )
    return bounded


def _pipeline():
    # Engine selection is evaluated at the request boundary. AI mode fails
    # explicitly when its local stack is incomplete instead of silently using
    # preview output that could look like a successful verification.
    engine = active_engine()
    if engine == "ai":
        if not production_available():
            logger.warning("pipeline unavailable: configured mode=%s active engine=ai", MODE)
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "AI_STACK_MISSING",
                    "message": "The local AI stack is not installed.",
                    "detail": "Run scripts/setup-ai.ps1, then restart Stereovisor.",
                },
            )
        logger.info("pipeline selected: engine=ai mode=%s device=%s", MODE, runtime_device())
        return ProductionPipeline()
    logger.info("pipeline selected: engine=preview mode=%s", MODE)
    return PreviewPipeline()


def _require_ready_for_ai_job() -> None:
    """Reject an AI job before enqueueing it during a service/model swap."""
    if active_engine() != "ai" or production_available():
        return
    dependencies = ai_dependencies()
    missing = ", ".join(key for key in REQUIRED_PROVIDERS if not dependencies[key].available)
    logger.warning("AI job rejected while providers are starting: missing=%s", missing)
    raise HTTPException(
        status_code=503,
        detail={
            "code": "AI_STACK_STARTING",
            "message": "The local AI stack is still starting.",
            "detail": f"Waiting for providers: {missing or 'local runtime'}.",
        },
    )


def _analyze_image(
    image: Image.Image,
    progress: ProgressCallback | None = None,
    cancelled: CancelCheck | None = None,
    segmentation_density: SegmentationDensity = "balanced",
    segmentation_labels: str = "",
    use_vlm_vocabulary: bool = False,
) -> ProjectPayload:
    started_at = time.monotonic()
    if progress is not None:
        progress(3, "Preparing image", "Normalizing orientation and color.")
    if cancelled is not None:
        cancelled()
    # Normalize orientation before downsampling so the stored project dimensions
    # match the pixels users see, including images with EXIF rotation.
    image = _downsample_image(ImageOps.exif_transpose(image).convert("RGB"))
    logger.info(
        "analysis started: size=%sx%s density=%s vlm_vocabulary=%s",
        image.width,
        image.height,
        segmentation_density,
        use_vlm_vocabulary,
    )
    project_id, directory = store.create(image)
    try:
        if cancelled is not None:
            cancelled()
        project = _pipeline().analyze(
            image,
            directory,
            project_id,
            segmentation_density=segmentation_density,
            segmentation_labels=segmentation_labels,
            use_vlm_vocabulary=use_vlm_vocabulary,
            progress=progress,
            cancelled=cancelled,
        )
        if cancelled is not None:
            cancelled()
        store.write(project)
        logger.info(
            "analysis completed: project=%s engine=%s layers=%s duration_ms=%s",
            project_id,
            project.engine,
            len(project.layers),
            round((time.monotonic() - started_at) * 1000),
        )
        return project
    except JobCancelled:
        logger.info("analysis cancelled: project=%s staging_removed=true", project_id)
        shutil.rmtree(directory, ignore_errors=True)
        raise
    except PipelineError as error:
        logger.warning("analysis rejected: project=%s error=%s", project_id, error)
        raise HTTPException(
            status_code=422,
            detail={"code": "ANALYSIS_FAILED", "message": str(error)},
        ) from error


async def _decode_upload(file: UploadFile) -> Image.Image:
    # Read one byte beyond the limit and force a real decode. Extension and
    # content type alone are not sufficient validation for uploaded bytes.
    if file.content_type not in {"image/png", "image/jpeg", "image/webp"}:
        logger.warning("upload rejected: unsupported content_type=%s", file.content_type)
        raise HTTPException(status_code=415, detail={"code": "UNSUPPORTED_IMAGE", "message": "Use PNG, JPEG, or WebP."})
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        logger.warning("upload rejected: bytes=%s limit=%s", len(data), MAX_UPLOAD_BYTES)
        raise HTTPException(status_code=413, detail={"code": "IMAGE_TOO_LARGE", "message": "Images are limited to 40 MB."})
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        logger.info("upload decoded: content_type=%s bytes=%s size=%sx%s", file.content_type, len(data), image.width, image.height)
        return image
    except (UnidentifiedImageError, OSError) as error:
        logger.warning("upload rejected: decode failed content_type=%s error=%s", file.content_type, error)
        raise HTTPException(status_code=422, detail={"code": "DECODE_FAILED", "message": "The selected file is not a readable image."}) from error


def _inpaint_project(
    project_id: str,
    request: InpaintRequest,
    progress: ProgressCallback | None = None,
    cancelled: CancelCheck | None = None,
) -> ProjectPayload:
    logger.info("inpaint started: project=%s layers=%s refinement=%s steps=%s", project_id, len(request.layerIds), request.refinement, request.steps)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = _pipeline().inpaint(
            project,
            directory,
            request.layerIds,
            refinement=request.refinement,
            prompt=request.prompt,
            steps=request.steps,
            progress=progress,
            cancelled=cancelled,
        )
        if cancelled is not None:
            cancelled()
        store.write(updated)
        logger.info("inpaint committed: project=%s provider=%s", project_id, updated.inpaintProvider)
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
    cancelled: CancelCheck | None = None,
    steps: int = 25,
) -> ProjectPayload:
    logger.info("target inpaint started: project=%s target=%s steps=%s", project_id, target_id, steps)
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
            steps=steps,
            progress=progress,
            cancelled=cancelled,
        )
        if cancelled is not None:
            cancelled()
        store.write(updated)
        logger.info("target inpaint committed: project=%s target=%s", project_id, target_id)
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
    logger.info("inpaint history requested: project=%s target=%s action=%s", project_id, target_id, action)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = restore_inpaint_history(project, directory, target_id, action)
        store.write(updated)
        logger.info("inpaint history committed: project=%s target=%s action=%s", project_id, target_id, action)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "INPAINT_HISTORY_FAILED", "message": str(error)}) from error


def _read_mask_history(project_id: str) -> list[InpaintHistoryPayload]:
    try:
        directory = store.directory(project_id)
        return mask_history(store.read(project_id), directory)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error


def _restore_project_mask(project_id: str, layer_id: str, action: str) -> ProjectPayload:
    logger.info("mask history requested: project=%s layer=%s action=%s", project_id, layer_id, action)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = restore_mask_history(project, directory, layer_id, action)
        store.write(updated)
        logger.info("mask history committed: project=%s layer=%s action=%s", project_id, layer_id, action)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "MASK_HISTORY_FAILED", "message": str(error)}) from error


def _refine_project(
    project_id: str,
    layer_id: str,
    progress: ProgressCallback | None = None,
    cancelled: CancelCheck | None = None,
) -> ProjectPayload:
    logger.info("refine started: project=%s layer=%s", project_id, layer_id)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = _pipeline().refine(project, directory, layer_id, progress=progress, cancelled=cancelled)
        if cancelled is not None:
            cancelled()
        store.write(updated)
        logger.info("refine committed: project=%s layer=%s", project_id, layer_id)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "REFINE_FAILED", "message": str(error)}) from error


def _confirm_project_layer(project_id: str, layer_id: str) -> ProjectPayload:
    logger.info("mask confirmation requested: project=%s layer=%s", project_id, layer_id)
    try:
        project = store.read(project_id)
        updated = confirm_layer_mask(project, layer_id)
        store.write(updated)
        logger.info("mask confirmed: project=%s layer=%s", project_id, layer_id)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "MASK_CONFIRM_FAILED", "message": str(error)}) from error


def _create_project_layer(project_id: str, mask: Image.Image, name: str | None) -> ProjectPayload:
    logger.info("layer creation requested: project=%s size=%sx%s", project_id, mask.width, mask.height)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = create_layer_from_mask(project, directory, mask, name)
        store.write(updated)
        logger.info("layer creation committed: project=%s layers=%s", project_id, len(updated.layers))
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "LAYER_CREATE_FAILED", "message": str(error)}) from error


def _rename_project_layer(project_id: str, layer_id: str, name: str) -> ProjectPayload:
    logger.info("layer rename requested: project=%s layer=%s", project_id, layer_id)
    try:
        updated = rename_layer(store.read(project_id), layer_id, name)
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "LAYER_RENAME_FAILED", "message": str(error)}) from error


def _delete_project_layer(project_id: str, layer_id: str) -> ProjectPayload:
    logger.info("layer deletion requested: project=%s layer=%s", project_id, layer_id)
    try:
        directory = store.directory(project_id)
        updated = delete_layer(store.read(project_id), directory, layer_id)
        store.write(updated)
        logger.info("layer deletion committed: project=%s remaining=%s", project_id, len(updated.layers))
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "LAYER_DELETE_FAILED", "message": str(error)}) from error


def _merge_project_layers(project_id: str, layer_ids: list[str]) -> ProjectPayload:
    logger.info("layer merge requested: project=%s layers=%s", project_id, layer_ids)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = merge_layer_masks(project, directory, layer_ids)
        store.write(updated)
        logger.info("layer merge committed: project=%s layers=%s", project_id, len(updated.layers))
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "LAYER_MERGE_FAILED", "message": str(error)}) from error


def _read_layer_merge_history(project_id: str) -> list[InpaintHistoryPayload]:
    try:
        directory = store.directory(project_id)
        return layer_merge_history(store.read(project_id), directory)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error


def _restore_project_layer_merge(project_id: str, action: str) -> ProjectPayload:
    logger.info("layer merge history requested: project=%s action=%s", project_id, action)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = restore_layer_merge_history(project, directory, action)
        store.write(updated)
        logger.info("layer merge history committed: project=%s action=%s layers=%s", project_id, action, len(updated.layers))
        return updated
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except PipelineError as error:
        raise HTTPException(status_code=422, detail={"code": "LAYER_MERGE_HISTORY_FAILED", "message": str(error)}) from error


def _save_edited_mask(project_id: str, mask: Image.Image, layer_id: str | None = None) -> ProjectPayload:
    logger.info("mask save started: project=%s target=%s size=%sx%s", project_id, layer_id or "extra", mask.width, mask.height)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = (
            replace_layer_mask(project, directory, layer_id, mask)
            if layer_id is not None
            else save_extra_inpaint_mask(project, directory, mask)
        )
        store.write(updated)
        logger.info("mask save committed: project=%s target=%s", project_id, layer_id or "extra")
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


def _run_job(job_id: str, operation: Callable[[ProgressCallback, CancelCheck], ProjectPayload]) -> None:
    # Check cancellation both before and after the operation. The second check
    # prevents a worker finishing just after a cancel request from committing a
    # result that the renderer considers discarded.
    try:
        jobs.ensure_active(job_id)

        def report(percent: int, stage: str, message: str) -> None:
            jobs.ensure_active(job_id)
            jobs.update(job_id, percent, stage, message)

        report(1, "Starting", "Starting the local AI worker.")
        logger.info("job worker started: id=%s", job_id)
        result = operation(report, lambda: jobs.ensure_active(job_id))
        jobs.ensure_active(job_id)
        jobs.complete(job_id, result)
        logger.info("job worker completed: id=%s project=%s", job_id, result.id)
    except JobCancelled:
        jobs.cancel(job_id)
        logger.info("job worker cancelled: id=%s", job_id)
    except Exception as error:
        jobs.fail(job_id, _error_message(error))
        logger.exception("job worker failed: id=%s error=%s", job_id, error)


@app.get("/api/health", response_model=HealthPayload)
def health() -> HealthPayload:
    # Provider readiness is an asset/module check, not proof that a full
    # inference has run. The renderer uses it to enable or disable controls.
    dependencies = ai_dependencies()
    engine = active_engine()
    actual_device = runtime_device()
    bootstrap = bootstrap_status()
    startup_state = bootstrap.state
    startup_detail = bootstrap.detail
    core_ready = all(dependencies[key].available for key in REQUIRED_PROVIDERS)
    if core_ready:
        startup_state = "ready"
        startup_detail = None
    elif startup_state == "ready":
        # A completed status file can outlive a changed runtime or a damaged
        # model cache; never report ready until the live provider probe agrees.
        startup_state = "blocked"
        startup_detail = None
    active_startup_state = startup_state in {"starting", "downloading", "initializing"}

    def provider_payload(key: str, dependency: object) -> ProviderStatus:
        available = bool(getattr(dependency, "available", False))
        detail = str(getattr(dependency, "detail", ""))
        if available:
            state = "ready"
            progress = 100
        elif active_startup_state and key in bootstrap.completed:
            # Prepared by the running bootstrap. The core-only service that
            # answers during preparation cannot probe the AI packages itself,
            # so report the finished stage instead of dropping back to waiting.
            state = "ready"
            progress = 100
            detail = "Prepared. Verified when the local AI service starts."
        elif active_startup_state and bootstrap.provider == key:
            state = startup_state
            progress = bootstrap.progress
            if bootstrap.provider == key and startup_detail:
                detail = startup_detail
        elif active_startup_state:
            state = "waiting"
            progress = None
        else:
            state = "blocked"
            progress = None
        return ProviderStatus(available=available, detail=detail, state=state, progress=progress)
    if engine == "ai":
        missing = ", ".join(key for key in REQUIRED_PROVIDERS if not dependencies[key].available)
        message = (
            f"Local AI engine ready on {actual_device}. Inference stays on this machine."
            if not missing
            else startup_detail or f"Local AI engine is starting. Waiting for providers: {missing}."
        )
    elif MODE == "preview" and production_available():
        message = "Preview engine selected by configuration. Set STEREOVISOR_MODE=ai to use the installed local models."
    else:
        missing = ", ".join(key for key, value in dependencies.items() if not value.available)
        message = startup_detail or f"Preview engine active. Install the local AI stack for production processing: {missing}."
    payload = HealthPayload(
        configuredMode=MODE,
        activeEngine=engine,
        device=actual_device,
        providers={key: provider_payload(key, value) for key, value in dependencies.items()},
        message=message,
        startupState=startup_state,
        startupDetail=startup_detail,
        startupProvider=bootstrap.provider,
        startupProgress=bootstrap.progress,
    )
    logger.info(
        "health check: mode=%s engine=%s device=%s providers=%s",
        MODE,
        engine,
        actual_device,
        {key: value.available for key, value in dependencies.items()},
    )
    return payload


@app.post("/api/analyze", response_model=ProjectPayload)
async def analyze(
    file: UploadFile = File(...),
    segmentation_density: SegmentationDensity = Form("balanced"),
    segmentation_labels: str = Form(""),
    use_vlm_vocabulary: bool = Form(False),
) -> ProjectPayload:
    return _analyze_image(
        await _decode_upload(file),
        segmentation_density=segmentation_density,
        segmentation_labels=segmentation_labels,
        use_vlm_vocabulary=use_vlm_vocabulary,
    )


@app.post("/api/sample", response_model=ProjectPayload)
def sample(
    segmentation_density: SegmentationDensity = "balanced",
    segmentation_labels: str = "",
    use_vlm_vocabulary: bool = False,
) -> ProjectPayload:
    return _analyze_image(
        create_sample_image(),
        segmentation_density=segmentation_density,
        segmentation_labels=segmentation_labels,
        use_vlm_vocabulary=use_vlm_vocabulary,
    )


@app.post("/api/jobs/analyze", response_model=ProcessingJobStart)
async def start_analyze_job(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    segmentation_density: SegmentationDensity = Form("balanced"),
    segmentation_labels: str = Form(""),
    use_vlm_vocabulary: bool = Form(False),
) -> ProcessingJobStart:
    _require_ready_for_ai_job()
    image = await _decode_upload(file)
    job_id = jobs.create("analyze")
    logger.info(
        "job accepted: id=%s kind=analyze density=%s vlm_vocabulary=%s",
        job_id,
        segmentation_density,
        use_vlm_vocabulary,
    )
    background_tasks.add_task(
        _run_job,
        job_id,
        lambda progress, cancelled: _analyze_image(
            image,
            progress,
            cancelled,
            segmentation_density=segmentation_density,
            segmentation_labels=segmentation_labels,
            use_vlm_vocabulary=use_vlm_vocabulary,
        ),
    )
    return ProcessingJobStart(jobId=job_id)


@app.post("/api/jobs/sample", response_model=ProcessingJobStart)
def start_sample_job(
    background_tasks: BackgroundTasks,
    segmentation_density: SegmentationDensity = "balanced",
    segmentation_labels: str = "",
    use_vlm_vocabulary: bool = False,
) -> ProcessingJobStart:
    _require_ready_for_ai_job()
    image = create_sample_image()
    job_id = jobs.create("analyze")
    logger.info(
        "job accepted: id=%s kind=sample density=%s vlm_vocabulary=%s",
        job_id,
        segmentation_density,
        use_vlm_vocabulary,
    )
    background_tasks.add_task(
        _run_job,
        job_id,
        lambda progress, cancelled: _analyze_image(
            image,
            progress,
            cancelled,
            segmentation_density=segmentation_density,
            segmentation_labels=segmentation_labels,
            use_vlm_vocabulary=use_vlm_vocabulary,
        ),
    )
    return ProcessingJobStart(jobId=job_id)


@app.post("/api/jobs/projects/{project_id}/inpaint", response_model=ProcessingJobStart)
def start_inpaint_job(project_id: str, request: InpaintRequest, background_tasks: BackgroundTasks) -> ProcessingJobStart:
    job_id = jobs.create("inpaint")
    logger.info("job accepted: id=%s kind=inpaint project=%s layers=%s", job_id, project_id, len(request.layerIds))
    background_tasks.add_task(_run_job, job_id, lambda progress, cancelled: _inpaint_project(project_id, request, progress, cancelled))
    return ProcessingJobStart(jobId=job_id)


@app.post("/api/jobs/projects/{project_id}/layers/{layer_id}/refine", response_model=ProcessingJobStart)
def start_refine_job(project_id: str, layer_id: str, background_tasks: BackgroundTasks) -> ProcessingJobStart:
    job_id = jobs.create("refine")
    logger.info("job accepted: id=%s kind=refine project=%s layer=%s", job_id, project_id, layer_id)
    background_tasks.add_task(_run_job, job_id, lambda progress, cancelled: _refine_project(project_id, layer_id, progress, cancelled))
    return ProcessingJobStart(jobId=job_id)


@app.post("/api/jobs/projects/{project_id}/targets/{target_id}/inpaint", response_model=ProcessingJobStart)
async def start_target_inpaint_job(
    project_id: str,
    target_id: str,
    background_tasks: BackgroundTasks,
    composition: UploadFile = File(...),
    mask: UploadFile = File(...),
    prompt: str | None = Form(default=None),
    steps: int = Form(default=25, ge=5, le=100),
) -> ProcessingJobStart:
    composition_image = await _decode_upload(composition)
    mask_image = await _decode_upload(mask)
    job_id = jobs.create("inpaint")
    logger.info("job accepted: id=%s kind=target-inpaint project=%s target=%s steps=%s", job_id, project_id, target_id, steps)
    background_tasks.add_task(
        _run_job,
        job_id,
        lambda progress, cancelled: _inpaint_project_target(
            project_id,
            target_id,
            composition_image,
            mask_image,
            prompt,
            steps=steps,
            progress=progress,
            cancelled=cancelled,
        ),
    )
    return ProcessingJobStart(jobId=job_id)


@app.get("/api/jobs/{job_id}", response_model=ProcessingJobPayload)
def processing_job(job_id: str) -> ProcessingJobPayload:
    try:
        return jobs.read(job_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail={"code": "JOB_NOT_FOUND", "message": "The processing job no longer exists."}) from error


@app.post("/api/jobs/{job_id}/cancel", response_model=ProcessingJobPayload)
def cancel_processing_job(job_id: str) -> ProcessingJobPayload:
    try:
        payload = jobs.cancel(job_id)
        logger.info("job cancellation response: id=%s state=%s", job_id, payload.state)
        return payload
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


@app.get("/api/projects/{project_id}/mask-history", response_model=list[InpaintHistoryPayload])
def get_project_mask_history(project_id: str) -> list[InpaintHistoryPayload]:
    return _read_mask_history(project_id)


@app.get("/api/projects/{project_id}/layer-merge-history", response_model=list[InpaintHistoryPayload])
def get_layer_merge_history(project_id: str) -> list[InpaintHistoryPayload]:
    return _read_layer_merge_history(project_id)


@app.post("/api/projects/{project_id}/layers", response_model=ProjectPayload)
async def create_layer(
    project_id: str,
    file: UploadFile = File(...),
    name: str | None = Form(default=None),
) -> ProjectPayload:
    return _create_project_layer(project_id, await _decode_upload(file), name)


@app.post("/api/projects/{project_id}/layers/{layer_id}/name", response_model=ProjectPayload)
def rename_project_layer(project_id: str, layer_id: str, request: RenameLayerRequest) -> ProjectPayload:
    return _rename_project_layer(project_id, layer_id, request.name)


# Deletion is a POST like every other mutation here: the local CORS policy
# allows GET and POST only, and the renderer is a cross-origin dev host.
@app.post("/api/projects/{project_id}/layers/{layer_id}/delete", response_model=ProjectPayload)
def delete_project_layer(project_id: str, layer_id: str) -> ProjectPayload:
    return _delete_project_layer(project_id, layer_id)


@app.post("/api/projects/{project_id}/layers/merge", response_model=ProjectPayload)
def merge_layers(project_id: str, request: MergeLayersRequest) -> ProjectPayload:
    return _merge_project_layers(project_id, request.layerIds)


@app.post("/api/projects/{project_id}/layers/undo-merge", response_model=ProjectPayload)
def undo_layer_merge(project_id: str) -> ProjectPayload:
    return _restore_project_layer_merge(project_id, "undo")


@app.post("/api/projects/{project_id}/layers/redo-merge", response_model=ProjectPayload)
def redo_layer_merge(project_id: str) -> ProjectPayload:
    return _restore_project_layer_merge(project_id, "redo")


@app.post("/api/projects/{project_id}/layers/{layer_id}/undo-refine", response_model=ProjectPayload)
def undo_layer_refine(project_id: str, layer_id: str) -> ProjectPayload:
    return _restore_project_mask(project_id, layer_id, "undo")


@app.post("/api/projects/{project_id}/layers/{layer_id}/redo-refine", response_model=ProjectPayload)
def redo_layer_refine(project_id: str, layer_id: str) -> ProjectPayload:
    return _restore_project_mask(project_id, layer_id, "redo")


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
    logger.info("project export started: project=%s layers=%s", project_id, len(request.layers))
    try:
        package = store.export_package(project_id, request.camera, request.layers)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "PROJECT_NOT_FOUND", "message": "The project no longer exists."}) from error
    except ProjectPackageError as error:
        logger.warning("project export rejected: project=%s error=%s", project_id, error)
        raise HTTPException(status_code=422, detail={"code": "EXPORT_FAILED", "message": str(error)}) from error
    logger.info("project export completed: project=%s bytes=%s", project_id, len(package))
    return Response(
        content=package,
        media_type="application/vnd.stereovisor.project+zip",
        headers={"Content-Disposition": f'attachment; filename="stereovisor-{project_id[:8]}.stereovisor"'},
    )


@app.post("/api/projects/import", response_model=ProjectImportPayload)
async def import_project(file: UploadFile = File(...)) -> ProjectImportPayload:
    # Package validation happens in ProjectStore before any staged files are
    # moved into the live project directory.
    data = await file.read(MAX_PROJECT_PACKAGE_BYTES + 1)
    if len(data) > MAX_PROJECT_PACKAGE_BYTES:
        logger.warning("project import rejected: bytes=%s limit=%s", len(data), MAX_PROJECT_PACKAGE_BYTES)
        raise HTTPException(status_code=413, detail={"code": "PROJECT_TOO_LARGE", "message": "Project packages are limited to 512 MB."})
    try:
        project, camera = store.import_package(data)
    except ProjectPackageError as error:
        logger.warning("project import rejected: error=%s", error)
        raise HTTPException(status_code=422, detail={"code": "IMPORT_FAILED", "message": str(error)}) from error
    logger.info("project import completed: project=%s bytes=%s layers=%s", project.id, len(data), len(project.layers))
    return ProjectImportPayload(project=project, camera=camera)
