from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import logging
import math
import os
import secrets
import shutil
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from email.utils import formatdate, parsedate
from typing import Literal

from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from ._version import __version__ as SERVICE_VERSION
from .config import (
    ALLOWED_ORIGINS,
    JOB_DB_PATH,
    JOB_RETENTION_SECONDS,
    MAX_IMAGE_PIXELS,
    MAX_PROJECT_PACKAGE_BYTES,
    MAX_UPLOAD_BYTES,
    MODE,
    PROJECT_ROOT,
    REQUIRED_PROVIDERS,
    SERVICE_AUTH_TOKEN,
    SERVICE_HOST,
    active_engine,
    ai_dependencies,
    bootstrap_status,
    ensure_bind_allowed,
    is_loopback_host,
    production_available,
    runtime_device,
)
from .events import events
from .compute import compute_scope
from .jobqueue import JobQueue
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
    mask_history,
    merge_layer_masks,
    rename_layer,
    replace_layer_mask,
    restore_inpaint_history,
    restore_layer_merge_history,
    restore_mask_history,
    save_extra_inpaint_mask,
)
from .providers import (
    capability_inventory,
    capability_ready,
    caption_background,
    detect_instances,
    encode_png,
    estimate_depth,
    fill_region,
    propose_vocabulary,
    refine_matte,
)
from .schemas import (
    CapabilityDescriptor,
    CapabilityInventory,
    CapabilityJobKind,
    CaptionResult,
    DepthResult,
    DetectedInstance,
    HealthPayload,
    InpaintHistoryPayload,
    InpaintingResult,
    InpaintRequest,
    JobKind,
    JobResult,
    MattingResult,
    MergeLayersRequest,
    ProcessingJobPayload,
    ProcessingJobStart,
    ProcessingPreview,
    ProjectExportRequest,
    ProjectImportPayload,
    ProjectPayload,
    ProviderStatus,
    RenameLayerRequest,
    SegmentationDensity,
    SegmentationResult,
    VocabularyResult,
)
from .storage import ProjectPackageError, ProjectStore

# Readiness is derived from the filesystem and module probes, so it has no
# natural push source. One server-side watch replaces every client's poll, and
# it only runs while somebody is listening.
HEALTH_WATCH_INTERVAL_SECONDS = 1.0
# Once every provider is ready the payload stops changing, so recomputing it
# every second is pure filesystem churn for the life of the session. A provider
# that later disappears is still caught within this window, and the renderer
# keeps its own backstop poll underneath.
HEALTH_WATCH_IDLE_SECONDS = 5.0


def health_watch_interval(payload: HealthPayload) -> float:
    """Watch closely while readiness is still moving, then ease off."""
    return (
        HEALTH_WATCH_IDLE_SECONDS
        if payload.startupState == "ready" and (
            payload.activity is None or payload.activity.state == "idle"
        )
        else HEALTH_WATCH_INTERVAL_SECONDS
    )


async def _watch_health() -> None:
    previous: str | None = None
    interval = HEALTH_WATCH_INTERVAL_SECONDS
    while True:
        try:
            await asyncio.sleep(interval)
            if not events.subscriber_count():
                # Forget the last snapshot so the next subscriber is resynced
                # from scratch rather than from a stale comparison.
                previous = None
                interval = HEALTH_WATCH_INTERVAL_SECONDS
                continue
            # compute_health touches the filesystem; keep it off the loop.
            payload = await asyncio.to_thread(compute_health)
            serialized = payload.model_dump_json()
            if serialized != previous:
                previous = serialized
                events.publish("health", json.loads(serialized))
            interval = health_watch_interval(payload)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - defensive
            logger.exception("health watch iteration failed")


# Finished jobs are swept periodically rather than on every request, so a
# status poll never pays for someone else's housekeeping.
JOB_EVICTION_INTERVAL_SECONDS = 300.0


async def _evict_jobs() -> None:
    while True:
        try:
            await asyncio.sleep(JOB_EVICTION_INTERVAL_SECONDS)
            await asyncio.to_thread(jobs.evict_expired)
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - defensive
            logger.exception("job eviction failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # First line in the console window the client opens when service.showConsole
    # is set, so a running service always identifies its own build.
    logger.info("Stereovisor service %s", SERVICE_VERSION)
    # Enforce the authenticated network boundary even when somebody starts
    # Uvicorn directly instead of going through service/scripts/run-service.py.
    ensure_bind_allowed()
    events.bind(asyncio.get_running_loop())
    # A previous lifespan in this process left the queue stopped.
    job_queue.start()
    # GPU work cannot be resumed, so anything left mid-flight by a crash is
    # failed with an explanation instead of appearing to still be running.
    await asyncio.to_thread(jobs.fail_interrupted)
    background = [
        asyncio.create_task(_watch_health()),
        asyncio.create_task(_evict_jobs()),
    ]
    try:
        yield
    finally:
        for task in background:
            task.cancel()
        for task in background:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # pragma: no cover
                pass
        await asyncio.to_thread(job_queue.stop)
        events.reset()


def _publish_job_event(payload: ProcessingJobPayload) -> None:
    # Deliberately excludes `result`: the socket reports state transitions, and
    # the authoritative project is always fetched over HTTP.
    events.publish(
        "job",
        {
            "jobId": payload.jobId,
            "kind": payload.kind,
            "state": payload.state,
            "progress": payload.progress,
            "stage": payload.stage,
            "message": payload.message,
            "queuePosition": payload.queuePosition,
        },
    )


app = FastAPI(
    title="Stereovisor local vision service",
    version=SERVICE_VERSION,
    lifespan=lifespan,
)


AUTH_SUBPROTOCOL_PREFIX = "stereovisor.auth."


def _remote_auth_required() -> bool:
    return not is_loopback_host(SERVICE_HOST)


def _token_matches(candidate: str) -> bool:
    return bool(SERVICE_AUTH_TOKEN) and secrets.compare_digest(
        candidate.encode("utf-8"), SERVICE_AUTH_TOKEN.encode("utf-8")
    )


def _bearer_token(value: str | None) -> str:
    if not value:
        return ""
    scheme, separator, token = value.partition(" ")
    return token.strip() if separator and scheme.lower() == "bearer" else ""


def _websocket_auth(websocket: WebSocket) -> tuple[str | None, str]:
    """Return the selected auth subprotocol and its decoded bearer token."""
    offered = websocket.headers.get("sec-websocket-protocol", "")
    for raw_protocol in offered.split(","):
        protocol = raw_protocol.strip()
        if not protocol.startswith(AUTH_SUBPROTOCOL_PREFIX):
            continue
        encoded = protocol[len(AUTH_SUBPROTOCOL_PREFIX) :]
        try:
            padding = "=" * (-len(encoded) % 4)
            token = base64.b64decode(
                encoded + padding, altchars=b"-_", validate=True
            ).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            return protocol, ""
        return protocol, token
    return None, ""


class RemoteAuthMiddleware:
    """Bearer-token gate for a non-loopback bind.

    Written against the ASGI interface rather than as a BaseHTTPMiddleware
    dispatcher. That base class re-frames every response through a task group
    and a memory stream, which costs about a fifth of the throughput when a
    project reloads its larger cutouts - to run a check that is a no-op on the
    loopback default. The host and token are read per request so a running
    service can be reconfigured, and so the tests can drive both paths.
    """

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Websocket handshakes carry the token in a subprotocol instead, and
        # /api/events checks it itself; lifespan has no caller to authenticate.
        if scope["type"] != "http" or not _remote_auth_required():
            await self._app(scope, receive, send)
            return
        authorization = Headers(scope=scope).get("authorization")
        if _token_matches(_bearer_token(authorization)):
            await self._app(scope, receive, send)
            return
        logger.warning("remote request rejected: path=%s", scope.get("path", ""))
        rejection = JSONResponse(
            status_code=401,
            content={
                "detail": {
                    "code": "AUTH_REQUIRED",
                    "message": "A valid Stereovisor server access token is required.",
                }
            },
            headers={"WWW-Authenticate": "Bearer"},
        )
        await rejection(scope, receive, send)


# Added before CORS so that CORS ends up outermost: a browser preflight has no
# Authorization header to present and has to be answered before this gate.
app.add_middleware(RemoteAuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type", "authorization"],
)
store = ProjectStore(PROJECT_ROOT)
jobs = ProcessingJobStore(
    _publish_job_event,
    path=JOB_DB_PATH,
    retention_seconds=JOB_RETENTION_SECONDS,
)
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
    dependencies = ai_dependencies()
    engine = active_engine(dependencies)
    if engine == "ai":
        if not production_available(dependencies):
            logger.warning(
                "pipeline unavailable: configured mode=%s active engine=ai", MODE
            )
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "AI_STACK_MISSING",
                    "message": "The local AI stack is not installed.",
                    "detail": "Run the platform AI setup launcher, then restart Stereovisor.",
                },
            )
        logger.info(
            "pipeline selected: engine=ai mode=%s device=%s", MODE, runtime_device()
        )
        return ProductionPipeline()
    logger.info("pipeline selected: engine=preview mode=%s", MODE)
    return PreviewPipeline()


def _require_ready_for_ai_job() -> None:
    """Reject an AI job before enqueueing it during a service/model swap."""
    dependencies = ai_dependencies()
    if active_engine(dependencies) != "ai" or production_available(dependencies):
        return
    missing = ", ".join(
        key for key in REQUIRED_PROVIDERS if not dependencies[key].available
    )
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


# The declared content type is only a hint. A browser sends no type, or
# application/octet-stream, when the operating system has no mapping for an
# extension, so a real WebP can arrive unlabeled. The decoded format decides.
SUPPORTED_UPLOAD_CONTENT_TYPES = {"image/png", "image/jpeg", "image/webp"}
UNTYPED_UPLOAD_CONTENT_TYPES = {None, "", "application/octet-stream"}
SUPPORTED_UPLOAD_FORMATS = {"PNG", "JPEG", "WEBP"}


def _unsupported_image() -> HTTPException:
    return HTTPException(
        status_code=415,
        detail={"code": "UNSUPPORTED_IMAGE", "message": "Use PNG, JPEG, or WebP."},
    )


def _decode_image_bytes(data: bytes, content_type: str | None) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
        if image.format not in SUPPORTED_UPLOAD_FORMATS:
            logger.warning(
                "upload rejected: unsupported format=%s content_type=%s",
                image.format,
                content_type,
            )
            raise _unsupported_image()
        logger.info(
            "upload decoded: content_type=%s bytes=%s size=%sx%s",
            content_type,
            len(data),
            image.width,
            image.height,
        )
        return image
    except (
        Image.DecompressionBombError,
        UnidentifiedImageError,
        OSError,
        ValueError,
    ) as error:
        logger.warning(
            "upload rejected: decode failed content_type=%s error=%s",
            content_type,
            error,
        )
        raise HTTPException(
            status_code=422,
            detail={
                "code": "DECODE_FAILED",
                "message": "The selected file is not a readable image.",
            },
        ) from error


async def _decode_upload(file: UploadFile) -> Image.Image:
    # Read one byte beyond the limit and force a real decode. Extension and
    # content type alone are not sufficient validation for uploaded bytes.
    if (
        file.content_type not in SUPPORTED_UPLOAD_CONTENT_TYPES
        and file.content_type not in UNTYPED_UPLOAD_CONTENT_TYPES
    ):
        logger.warning(
            "upload rejected: unsupported content_type=%s", file.content_type
        )
        raise _unsupported_image()
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        logger.warning(
            "upload rejected: bytes=%s limit=%s", len(data), MAX_UPLOAD_BYTES
        )
        raise HTTPException(
            status_code=413,
            detail={
                "code": "IMAGE_TOO_LARGE",
                "message": "Images are limited to 40 MB.",
            },
        )
    # Pillow decoding can be CPU-heavy and may emit decompression-bomb errors;
    # keep both the event loop and the HTTP error mapping responsive.
    return await asyncio.to_thread(_decode_image_bytes, data, file.content_type)


def _inpaint_project(
    project_id: str,
    request: InpaintRequest,
    progress: ProgressCallback | None = None,
    cancelled: CancelCheck | None = None,
) -> ProjectPayload:
    logger.info(
        "inpaint started: project=%s layers=%s refinement=%s steps=%s",
        project_id,
        len(request.layerIds),
        request.refinement,
        request.steps,
    )
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
        logger.info(
            "inpaint committed: project=%s provider=%s",
            project_id,
            updated.inpaintProvider,
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422, detail={"code": "INPAINT_FAILED", "message": str(error)}
        ) from error


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
    logger.info(
        "target inpaint started: project=%s target=%s steps=%s",
        project_id,
        target_id,
        steps,
    )
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
        logger.info(
            "target inpaint committed: project=%s target=%s", project_id, target_id
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "LAYER_INPAINT_FAILED", "message": str(error)},
        ) from error


def _read_inpaint_history(project_id: str) -> list[InpaintHistoryPayload]:
    try:
        directory = store.directory(project_id)
        return inpaint_history(store.read(project_id), directory)
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error


def _restore_project_target_inpaint(
    project_id: str, target_id: str, action: str
) -> ProjectPayload:
    logger.info(
        "inpaint history requested: project=%s target=%s action=%s",
        project_id,
        target_id,
        action,
    )
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = restore_inpaint_history(project, directory, target_id, action)
        store.write(updated)
        logger.info(
            "inpaint history committed: project=%s target=%s action=%s",
            project_id,
            target_id,
            action,
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "INPAINT_HISTORY_FAILED", "message": str(error)},
        ) from error


def _read_mask_history(project_id: str) -> list[InpaintHistoryPayload]:
    try:
        directory = store.directory(project_id)
        return mask_history(store.read(project_id), directory)
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error


def _restore_project_mask(
    project_id: str, layer_id: str, action: str
) -> ProjectPayload:
    logger.info(
        "mask history requested: project=%s layer=%s action=%s",
        project_id,
        layer_id,
        action,
    )
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = restore_mask_history(project, directory, layer_id, action)
        store.write(updated)
        logger.info(
            "mask history committed: project=%s layer=%s action=%s",
            project_id,
            layer_id,
            action,
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "MASK_HISTORY_FAILED", "message": str(error)},
        ) from error


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
        updated = _pipeline().refine(
            project, directory, layer_id, progress=progress, cancelled=cancelled
        )
        if cancelled is not None:
            cancelled()
        store.write(updated)
        logger.info("refine committed: project=%s layer=%s", project_id, layer_id)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422, detail={"code": "REFINE_FAILED", "message": str(error)}
        ) from error


def _confirm_project_layer(project_id: str, layer_id: str) -> ProjectPayload:
    logger.info(
        "mask confirmation requested: project=%s layer=%s", project_id, layer_id
    )
    try:
        project = store.read(project_id)
        updated = confirm_layer_mask(project, layer_id)
        store.write(updated)
        logger.info("mask confirmed: project=%s layer=%s", project_id, layer_id)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "MASK_CONFIRM_FAILED", "message": str(error)},
        ) from error


def _create_project_layer(
    project_id: str, mask: Image.Image, name: str | None
) -> ProjectPayload:
    logger.info(
        "layer creation requested: project=%s size=%sx%s",
        project_id,
        mask.width,
        mask.height,
    )
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = create_layer_from_mask(project, directory, mask, name)
        store.write(updated)
        logger.info(
            "layer creation committed: project=%s layers=%s",
            project_id,
            len(updated.layers),
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "LAYER_CREATE_FAILED", "message": str(error)},
        ) from error


def _rename_project_layer(project_id: str, layer_id: str, name: str) -> ProjectPayload:
    logger.info("layer rename requested: project=%s layer=%s", project_id, layer_id)
    try:
        updated = rename_layer(store.read(project_id), layer_id, name)
        store.write(updated)
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "LAYER_RENAME_FAILED", "message": str(error)},
        ) from error


def _delete_project_layer(project_id: str, layer_id: str) -> ProjectPayload:
    logger.info("layer deletion requested: project=%s layer=%s", project_id, layer_id)
    try:
        directory = store.directory(project_id)
        updated = delete_layer(store.read(project_id), directory, layer_id)
        store.write(updated)
        logger.info(
            "layer deletion committed: project=%s remaining=%s",
            project_id,
            len(updated.layers),
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "LAYER_DELETE_FAILED", "message": str(error)},
        ) from error


def _merge_project_layers(project_id: str, layer_ids: list[str]) -> ProjectPayload:
    logger.info("layer merge requested: project=%s layers=%s", project_id, layer_ids)
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = merge_layer_masks(project, directory, layer_ids)
        store.write(updated)
        logger.info(
            "layer merge committed: project=%s layers=%s",
            project_id,
            len(updated.layers),
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "LAYER_MERGE_FAILED", "message": str(error)},
        ) from error


def _read_layer_merge_history(project_id: str) -> list[InpaintHistoryPayload]:
    try:
        directory = store.directory(project_id)
        return layer_merge_history(store.read(project_id), directory)
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error


def _restore_project_layer_merge(project_id: str, action: str) -> ProjectPayload:
    logger.info(
        "layer merge history requested: project=%s action=%s", project_id, action
    )
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = restore_layer_merge_history(project, directory, action)
        store.write(updated)
        logger.info(
            "layer merge history committed: project=%s action=%s layers=%s",
            project_id,
            action,
            len(updated.layers),
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "LAYER_MERGE_HISTORY_FAILED", "message": str(error)},
        ) from error


def _save_edited_mask(
    project_id: str, mask: Image.Image, layer_id: str | None = None
) -> ProjectPayload:
    logger.info(
        "mask save started: project=%s target=%s size=%sx%s",
        project_id,
        layer_id or "extra",
        mask.width,
        mask.height,
    )
    try:
        directory = store.directory(project_id)
        project = store.read(project_id)
        updated = (
            replace_layer_mask(project, directory, layer_id, mask)
            if layer_id is not None
            else save_extra_inpaint_mask(project, directory, mask)
        )
        store.write(updated)
        logger.info(
            "mask save committed: project=%s target=%s", project_id, layer_id or "extra"
        )
        return updated
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except PipelineError as error:
        raise HTTPException(
            status_code=422, detail={"code": "MASK_EDIT_FAILED", "message": str(error)}
        ) from error


def _error_message(error: Exception) -> str:
    if isinstance(error, HTTPException):
        detail = error.detail
        if isinstance(detail, dict):
            return " ".join(
                str(detail[key]) for key in ("message", "detail") if detail.get(key)
            )
        return str(detail)
    return str(error) or "Local processing failed."


def _run_job(
    job_id: str, operation: Callable[[ProgressCallback, CancelCheck], JobResult]
) -> None:
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
        with compute_scope(
            lambda status: jobs.set_compute(job_id, status),
            lambda: jobs.ensure_active(job_id),
            job_id=job_id,
        ):
            result = operation(report, lambda: jobs.ensure_active(job_id))
        jobs.ensure_active(job_id)
        jobs.complete(job_id, result)
        logger.info(
            "job worker completed: id=%s result=%s",
            job_id,
            type(result).__name__,
        )
    except JobCancelled:
        jobs.cancel(job_id)
        logger.info("job worker cancelled: id=%s", job_id)
    except Exception as error:
        jobs.fail(job_id, _error_message(error))
        logger.exception("job worker failed: id=%s error=%s", job_id, error)


# One job runs at a time, which is all a single local GPU allows. Making the
# queue explicit lets a waiting job report its position instead of silently
# occupying a request thread inside the pipeline lock.
job_queue = JobQueue(jobs, _run_job)


def _enqueue_job(
    kind: JobKind,
    operation: Callable[[ProgressCallback, CancelCheck], JobResult],
) -> ProcessingJobStart:
    """Persist a job and enqueue it as one failure-safe operation."""
    job_id = jobs.create(kind)
    try:
        job_queue.submit(job_id, operation)
    except RuntimeError as error:
        # A shutdown can race the final request. Do not leave a durable row
        # claiming work is queued when no worker can ever consume it.
        jobs.cancel(job_id)
        raise HTTPException(
            status_code=503,
            detail={
                "code": "SERVICE_SHUTTING_DOWN",
                "message": "The local service is shutting down. Try again shortly.",
            },
        ) from error
    return ProcessingJobStart(jobId=job_id)


def compute_health() -> HealthPayload:
    """Build the readiness payload. Pure enough to run on the watch thread."""
    # Provider readiness is an asset/module check, not proof that a full
    # inference has run. The renderer uses it to enable or disable controls.
    dependencies = ai_dependencies()
    engine = active_engine(dependencies)
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
        warning = getattr(dependency, "warning", None)
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
        return ProviderStatus(
            available=available,
            detail=detail,
            warning=warning,
            state=state,
            progress=progress,
        )

    if engine == "ai":
        missing = ", ".join(
            key for key in REQUIRED_PROVIDERS if not dependencies[key].available
        )
        message = (
            f"Local AI engine ready on {actual_device}. Inference stays on this machine."
            if not missing
            else startup_detail
            or f"Local AI engine is starting. Waiting for providers: {missing}."
        )
    elif MODE == "preview" and core_ready:
        message = "Preview engine selected by configuration. Set STEREOVISOR_MODE=ai to use the installed local models."
    else:
        missing = ", ".join(
            key for key, value in dependencies.items() if not value.available
        )
        message = (
            startup_detail
            or f"Preview engine active. Install the local AI stack for production processing: {missing}."
        )
    payload = HealthPayload(
        configuredMode=MODE,
        activeEngine=engine,
        device=actual_device,
        localOnly=not _remote_auth_required(),
        providers={
            key: provider_payload(key, value) for key, value in dependencies.items()
        },
        message=message,
        startupState=startup_state,
        startupDetail=startup_detail,
        startupProvider=bootstrap.provider,
        startupProgress=bootstrap.progress,
        activity=jobs.activity(worker_busy=job_queue.is_busy()),
    )
    return payload


@app.get("/api/health", response_model=HealthPayload)
def health() -> HealthPayload:
    payload = compute_health()
    logger.info(
        "health check: mode=%s engine=%s device=%s providers=%s",
        payload.configuredMode,
        payload.activeEngine,
        payload.device,
        {key: value.available for key, value in payload.providers.items()},
    )
    return payload


@app.websocket("/api/events")
async def service_events(websocket: WebSocket) -> None:
    """Push job and readiness transitions so clients need not poll for them.

    CORS middleware does not cover the WebSocket handshake, so the browser-sent
    Origin is checked against the same allowlist the HTTP routes use.
    """
    origin = websocket.headers.get("origin")
    if (
        origin is not None
        and "*" not in ALLOWED_ORIGINS
        and origin not in ALLOWED_ORIGINS
    ):
        logger.warning("event channel rejected: origin=%s", origin)
        await websocket.close(code=1008)
        return

    auth_protocol, auth_token = _websocket_auth(websocket)
    if _remote_auth_required() and not _token_matches(auth_token):
        logger.warning("remote event channel rejected: origin=%s", origin)
        await websocket.close(code=1008)
        return

    await websocket.accept(subprotocol=auth_protocol if auth_token else None)
    queue = events.register()
    logger.info("event channel opened: subscribers=%s", events.subscriber_count())
    sender: asyncio.Task[None] | None = None
    try:
        await websocket.send_json({"topic": "ready", "seq": 0})

        async def pump() -> None:
            while True:
                message = await queue.get()
                if (
                    message.get("topic") == "_control"
                    and message.get("code") == "overflow"
                ):
                    # The hub removed this subscriber after its bounded queue
                    # overflowed. Close cleanly so the sender task cannot leak.
                    await websocket.close(code=1013)
                    return
                await websocket.send_json(message)

        sender = asyncio.create_task(pump())
        while True:
            # Clients send nothing today. Reading is how a disconnect is noticed
            # promptly instead of on the next failed send.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - transport level
        logger.info("event channel closed early", exc_info=True)
    finally:
        if sender is not None:
            sender.cancel()
            try:
                await sender
            except (asyncio.CancelledError, Exception):  # pragma: no cover
                pass
        events.unregister(queue)
        logger.info("event channel closed: subscribers=%s", events.subscriber_count())


def _analysis_preview(image: Image.Image) -> ProcessingPreview:
    # Send a small, browser-readable preview once, without changing AI input.
    preview = ImageOps.exif_transpose(image).convert("RGB")
    preview.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    preview.save(output, format="JPEG", quality=80)
    return ProcessingPreview(
        sourceUrl="data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode("ascii"),
        width=preview.width,
        height=preview.height,
    )


@app.post("/api/jobs/analyze", response_model=ProcessingJobStart)
async def start_analyze_job(
    file: UploadFile = File(...),
    segmentation_density: SegmentationDensity = Form("balanced"),
    segmentation_labels: str = Form(""),
    use_vlm_vocabulary: bool = Form(False),
) -> ProcessingJobStart:
    _require_ready_for_ai_job()
    image = await _decode_upload(file)
    preview = _analysis_preview(image)
    logger.info(
        "job accepted: kind=analyze density=%s vlm_vocabulary=%s",
        segmentation_density,
        use_vlm_vocabulary,
    )
    job = _enqueue_job(
        "analyze",
        lambda progress, cancelled: _analyze_image(
            image,
            progress,
            cancelled,
            segmentation_density=segmentation_density,
            segmentation_labels=segmentation_labels,
            use_vlm_vocabulary=use_vlm_vocabulary,
        ),
    )
    return job.model_copy(update={"preview": preview})


@app.post("/api/jobs/sample", response_model=ProcessingJobStart)
def start_sample_job(
    segmentation_density: SegmentationDensity = "balanced",
    segmentation_labels: str = "",
    use_vlm_vocabulary: bool = False,
) -> ProcessingJobStart:
    _require_ready_for_ai_job()
    image = create_sample_image()
    preview = _analysis_preview(image)
    logger.info(
        "job accepted: kind=sample density=%s vlm_vocabulary=%s",
        segmentation_density,
        use_vlm_vocabulary,
    )
    job = _enqueue_job(
        "analyze",
        lambda progress, cancelled: _analyze_image(
            image,
            progress,
            cancelled,
            segmentation_density=segmentation_density,
            segmentation_labels=segmentation_labels,
            use_vlm_vocabulary=use_vlm_vocabulary,
        ),
    )
    return job.model_copy(update={"preview": preview})


@app.post("/api/jobs/projects/{project_id}/inpaint", response_model=ProcessingJobStart)
def start_inpaint_job(project_id: str, request: InpaintRequest) -> ProcessingJobStart:
    logger.info(
        "job accepted: kind=inpaint project=%s layers=%s",
        project_id,
        len(request.layerIds),
    )
    return _enqueue_job(
        "inpaint",
        lambda progress, cancelled: _inpaint_project(
            project_id, request, progress, cancelled
        ),
    )


@app.post(
    "/api/jobs/projects/{project_id}/layers/{layer_id}/refine",
    response_model=ProcessingJobStart,
)
def start_refine_job(project_id: str, layer_id: str) -> ProcessingJobStart:
    logger.info("job accepted: kind=refine project=%s layer=%s", project_id, layer_id)
    return _enqueue_job(
        "refine",
        lambda progress, cancelled: _refine_project(
            project_id, layer_id, progress, cancelled
        ),
    )


@app.post(
    "/api/jobs/projects/{project_id}/targets/{target_id}/inpaint",
    response_model=ProcessingJobStart,
)
async def start_target_inpaint_job(
    project_id: str,
    target_id: str,
    composition: UploadFile = File(...),
    mask: UploadFile = File(...),
    prompt: str | None = Form(default=None),
    steps: int = Form(default=25, ge=5, le=100),
) -> ProcessingJobStart:
    composition_image = await _decode_upload(composition)
    mask_image = await _decode_upload(mask)
    logger.info(
        "job accepted: kind=target-inpaint project=%s target=%s steps=%s",
        project_id,
        target_id,
        steps,
    )
    return _enqueue_job(
        "inpaint",
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


@app.get("/api/jobs/{job_id}", response_model=ProcessingJobPayload)
def processing_job(job_id: str) -> ProcessingJobPayload:
    try:
        return jobs.read(job_id)
    except KeyError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "JOB_NOT_FOUND",
                "message": "The processing job no longer exists.",
            },
        ) from error


@app.post("/api/jobs/{job_id}/cancel", response_model=ProcessingJobPayload)
def cancel_processing_job(job_id: str) -> ProcessingJobPayload:
    try:
        payload = jobs.cancel(job_id)
        job_queue.discard(job_id)
        logger.info("job cancellation response: id=%s state=%s", job_id, payload.state)
        return payload
    except KeyError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "JOB_NOT_FOUND",
                "message": "The processing job no longer exists.",
            },
        ) from error


@app.get(
    "/api/projects/{project_id}/inpaint-history",
    response_model=list[InpaintHistoryPayload],
)
def get_project_inpaint_history(project_id: str) -> list[InpaintHistoryPayload]:
    return _read_inpaint_history(project_id)


@app.post(
    "/api/projects/{project_id}/targets/{target_id}/undo-inpaint",
    response_model=ProjectPayload,
)
def undo_target_inpaint(project_id: str, target_id: str) -> ProjectPayload:
    return _restore_project_target_inpaint(project_id, target_id, "undo")


@app.post(
    "/api/projects/{project_id}/targets/{target_id}/redo-inpaint",
    response_model=ProjectPayload,
)
def redo_target_inpaint(project_id: str, target_id: str) -> ProjectPayload:
    return _restore_project_target_inpaint(project_id, target_id, "redo")


@app.get(
    "/api/projects/{project_id}/mask-history",
    response_model=list[InpaintHistoryPayload],
)
def get_project_mask_history(project_id: str) -> list[InpaintHistoryPayload]:
    return _read_mask_history(project_id)


@app.get(
    "/api/projects/{project_id}/layer-merge-history",
    response_model=list[InpaintHistoryPayload],
)
def get_layer_merge_history(project_id: str) -> list[InpaintHistoryPayload]:
    return _read_layer_merge_history(project_id)


@app.post("/api/projects/{project_id}/layers", response_model=ProjectPayload)
async def create_layer(
    project_id: str,
    file: UploadFile = File(...),
    name: str | None = Form(default=None),
) -> ProjectPayload:
    return _create_project_layer(project_id, await _decode_upload(file), name)


@app.post(
    "/api/projects/{project_id}/layers/{layer_id}/name", response_model=ProjectPayload
)
def rename_project_layer(
    project_id: str, layer_id: str, request: RenameLayerRequest
) -> ProjectPayload:
    return _rename_project_layer(project_id, layer_id, request.name)


# Deletion is a POST like every other mutation here: the local CORS policy
# allows GET and POST only, and the renderer is a cross-origin dev host.
@app.post(
    "/api/projects/{project_id}/layers/{layer_id}/delete", response_model=ProjectPayload
)
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


@app.post(
    "/api/projects/{project_id}/layers/{layer_id}/undo-refine",
    response_model=ProjectPayload,
)
def undo_layer_refine(project_id: str, layer_id: str) -> ProjectPayload:
    return _restore_project_mask(project_id, layer_id, "undo")


@app.post(
    "/api/projects/{project_id}/layers/{layer_id}/redo-refine",
    response_model=ProjectPayload,
)
def redo_layer_refine(project_id: str, layer_id: str) -> ProjectPayload:
    return _restore_project_mask(project_id, layer_id, "redo")


@app.post(
    "/api/projects/{project_id}/layers/{layer_id}/mask", response_model=ProjectPayload
)
async def update_layer_mask(
    project_id: str, layer_id: str, file: UploadFile = File(...)
) -> ProjectPayload:
    mask = await _decode_upload(file)
    return await asyncio.to_thread(_save_edited_mask, project_id, mask, layer_id)


@app.post(
    "/api/projects/{project_id}/layers/{layer_id}/confirm",
    response_model=ProjectPayload,
)
def confirm_mask(project_id: str, layer_id: str) -> ProjectPayload:
    return _confirm_project_layer(project_id, layer_id)


@app.post("/api/projects/{project_id}/extra-mask", response_model=ProjectPayload)
async def update_extra_mask(
    project_id: str, file: UploadFile = File(...)
) -> ProjectPayload:
    mask = await _decode_upload(file)
    return await asyncio.to_thread(_save_edited_mask, project_id, mask)


# An asset is mutable at a stable path - refining a mask overwrites its own
# file - so a client must revalidate before reusing one. It must not re-download
# one that has not changed: a single project is a quarter of a gigabyte of
# cutouts, and "no-store" made every reload transfer all of it again.
ASSET_CACHE_CONTROL = "no-cache"


def _asset_validators(stat_result: os.stat_result) -> dict[str, str]:
    """Cache validators for one asset file.

    The entity tag is built the way FileResponse builds its own, and computed
    here from a single stat so the conditional check and the response it guards
    can never disagree about which revision they describe.
    """
    tag = hashlib.md5(
        f"{stat_result.st_mtime}-{stat_result.st_size}".encode(),
        usedforsecurity=False,
    ).hexdigest()
    return {
        "Cache-Control": ASSET_CACHE_CONTROL,
        "ETag": f'"{tag}"',
        "Last-Modified": formatdate(stat_result.st_mtime, usegmt=True),
    }


def _asset_unchanged(request: Request, validators: dict[str, str]) -> bool:
    """RFC 9110 revalidation: the entity tag decides, the timestamp is fallback."""
    offered = request.headers.get("if-none-match")
    if offered:
        return any(
            candidate.strip().removeprefix("W/") == validators["ETag"]
            for candidate in offered.split(",")
        )
    since = parsedate(request.headers.get("if-modified-since", ""))
    modified = parsedate(validators["Last-Modified"])
    return bool(since and modified and since >= modified)


@app.get("/api/projects/{project_id}/assets/{name}")
def asset(project_id: str, name: str, request: Request) -> Response:
    try:
        path = store.asset(project_id, name)
        stat_result = path.stat()
    except OSError as error:
        # FileNotFoundError is an OSError; a vanished or unreadable asset is
        # the same answer to a client either way.
        raise HTTPException(
            status_code=404,
            detail={
                "code": "ASSET_NOT_FOUND",
                "message": "The project asset does not exist.",
            },
        ) from error
    validators = _asset_validators(stat_result)
    if _asset_unchanged(request, validators):
        return Response(status_code=304, headers=validators)
    return FileResponse(
        path,
        media_type="image/png",
        headers=validators,
        # Reuse the stat already taken rather than making FileResponse repeat it.
        stat_result=stat_result,
    )


@app.post("/api/projects/{project_id}/export")
def export_project(project_id: str, request: ProjectExportRequest) -> Response:
    logger.info(
        "project export started: project=%s layers=%s", project_id, len(request.layers)
    )
    try:
        package = store.export_package(project_id, request.camera, request.layers)
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "PROJECT_NOT_FOUND",
                "message": "The project no longer exists.",
            },
        ) from error
    except ProjectPackageError as error:
        logger.warning(
            "project export rejected: project=%s error=%s", project_id, error
        )
        raise HTTPException(
            status_code=422, detail={"code": "EXPORT_FAILED", "message": str(error)}
        ) from error
    logger.info(
        "project export completed: project=%s bytes=%s", project_id, len(package)
    )
    return Response(
        content=package,
        media_type="application/vnd.stereovisor.project+zip",
        headers={
            "Content-Disposition": f'attachment; filename="stereovisor-{project_id[:8]}.stereovisor"'
        },
    )


@app.post("/api/projects/import", response_model=ProjectImportPayload)
async def import_project(file: UploadFile = File(...)) -> ProjectImportPayload:
    # Package validation happens in ProjectStore before any staged files are
    # moved into the live project directory.
    data = await file.read(MAX_PROJECT_PACKAGE_BYTES + 1)
    if len(data) > MAX_PROJECT_PACKAGE_BYTES:
        logger.warning(
            "project import rejected: bytes=%s limit=%s",
            len(data),
            MAX_PROJECT_PACKAGE_BYTES,
        )
        raise HTTPException(
            status_code=413,
            detail={
                "code": "PROJECT_TOO_LARGE",
                "message": "Project packages are limited to 512 MB.",
            },
        )
    try:
        # Zip verification and image decoding can be substantial for a valid
        # package; do not monopolize the event loop while validating it.
        project, camera = await asyncio.to_thread(store.import_package, data)
    except ProjectPackageError as error:
        logger.warning("project import rejected: error=%s", error)
        raise HTTPException(
            status_code=422, detail={"code": "IMPORT_FAILED", "message": str(error)}
        ) from error
    logger.info(
        "project import completed: project=%s bytes=%s layers=%s",
        project.id,
        len(data),
        len(project.layers),
    )
    return ProjectImportPayload(project=project, camera=camera)


# --------------------------------------------------------------------------
#  Capability API
#
#  Each route is a thin front for one provider function in service.src.providers,
#  which in turn calls the same implementation the workflow uses. Adding a
#  capability must never mean adding a second copy of a pipeline stage.
# --------------------------------------------------------------------------


def _require_capability(capability_id: str) -> None:
    available, detail = capability_ready(capability_id)
    if available:
        return
    logger.warning("capability unavailable: id=%s detail=%s", capability_id, detail)
    raise HTTPException(
        status_code=503,
        detail={
            "code": "CAPABILITY_UNAVAILABLE",
            "message": f"{capability_id} is not available on this machine.",
            "detail": detail,
        },
    )


def _capability_failed(capability_id: str, error: Exception) -> HTTPException:
    logger.warning("capability failed: id=%s error=%s", capability_id, error)
    return HTTPException(
        status_code=422,
        detail={
            "code": "CAPABILITY_FAILED",
            "message": f"{capability_id} could not process this input.",
            "detail": str(error),
        },
    )


async def _capability_image(file: UploadFile) -> Image.Image:
    # Same normalization the workflow applies, so one upload yields identical
    # pixels whether it arrives here or through /api/jobs/analyze.
    decoded = await _decode_upload(file)
    return await asyncio.to_thread(
        lambda: _downsample_image(ImageOps.exif_transpose(decoded).convert("RGB"))
    )


async def _capability_mask(file: UploadFile, image: Image.Image) -> Image.Image:
    decoded = await _decode_upload(file)

    def normalize_mask() -> Image.Image:
        mask = decoded.convert("L")
        if mask.size == image.size:
            return mask
        # The image may have been bounded above; NEAREST keeps mask edges hard.
        return mask.resize(image.size, Image.Resampling.NEAREST)

    return await asyncio.to_thread(normalize_mask)


@app.get("/api/capabilities", response_model=CapabilityInventory)
def capabilities() -> CapabilityInventory:
    """Machine-readable inventory of every addressable AI component."""
    return CapabilityInventory(
        activeEngine=active_engine(),
        device=runtime_device(),
        capabilities=[
            CapabilityDescriptor(**entry) for entry in capability_inventory()
        ],
    )


def _enqueue_capability_job(
    capability_id: CapabilityJobKind,
    operation: Callable[[], JobResult],
) -> ProcessingJobStart:
    def run(
        progress: ProgressCallback,
        cancelled: CancelCheck,
    ) -> JobResult:
        progress(
            5,
            "Running capability",
            f"Running {capability_id} on the local AI worker.",
        )
        cancelled()
        try:
            result = operation()
        except (PipelineError, RuntimeError) as error:
            raise _capability_failed(capability_id, error) from error
        cancelled()
        return result

    logger.info("job accepted: kind=%s", capability_id)
    return _enqueue_job(capability_id, run)


@app.post(
    "/api/jobs/capabilities/segmentation:detect",
    response_model=ProcessingJobStart,
)
async def capability_segmentation_detect(
    file: UploadFile = File(...),
    density: SegmentationDensity = Form("balanced"),
    labels: str = Form(""),
) -> ProcessingJobStart:
    _require_capability("segmentation:detect")
    image = await _capability_image(file)

    def operation() -> SegmentationResult:
        instances, metrics = detect_instances(image, density, labels)
        return SegmentationResult(
            instances=[DetectedInstance(**instance) for instance in instances],
            vramPeaksMb=metrics,
        )

    return _enqueue_capability_job("segmentation:detect", operation)


@app.post(
    "/api/jobs/capabilities/depth:estimate",
    response_model=ProcessingJobStart,
)
async def capability_depth_estimate(file: UploadFile = File(...)) -> ProcessingJobStart:
    _require_capability("depth:estimate")
    image = await _capability_image(file)

    def operation() -> DepthResult:
        preview, metrics = estimate_depth(image)
        return DepthResult(depthPreviewPng=encode_png(preview), vramPeaksMb=metrics)

    return _enqueue_capability_job("depth:estimate", operation)


@app.post(
    "/api/jobs/capabilities/matting:refine",
    response_model=ProcessingJobStart,
)
async def capability_matting_refine(
    file: UploadFile = File(...),
    mask: UploadFile = File(...),
    kind: Literal["instance", "manual"] = Form("instance"),
) -> ProcessingJobStart:
    _require_capability("matting:refine")
    image = await _capability_image(file)
    alpha_mask = await _capability_mask(mask, image)

    def operation() -> MattingResult:
        alpha, metrics = refine_matte(image, alpha_mask, kind)
        return MattingResult(alphaPng=encode_png(alpha), vramPeaksMb=metrics)

    return _enqueue_capability_job("matting:refine", operation)


@app.post(
    "/api/jobs/capabilities/inpainting:fill",
    response_model=ProcessingJobStart,
)
async def capability_inpainting_fill(
    file: UploadFile = File(...),
    mask: UploadFile = File(...),
) -> ProcessingJobStart:
    _require_capability("inpainting:fill")
    image = await _capability_image(file)
    removal_mask = await _capability_mask(mask, image)

    def operation() -> InpaintingResult:
        filled, metrics = fill_region(image, removal_mask)
        return InpaintingResult(
            imagePng=encode_png(filled),
            provider="big-lama",
            vramPeaksMb=metrics,
        )

    return _enqueue_capability_job("inpainting:fill", operation)


@app.post(
    "/api/jobs/capabilities/vlm:vocabulary",
    response_model=ProcessingJobStart,
)
async def capability_vlm_vocabulary(
    file: UploadFile = File(...),
    density: SegmentationDensity = Form("balanced"),
) -> ProcessingJobStart:
    _require_capability("vlm:vocabulary")
    image = await _capability_image(file)

    def operation() -> VocabularyResult:
        labels, metrics = propose_vocabulary(image, density)
        return VocabularyResult(labels=labels, vramPeaksMb=metrics)

    return _enqueue_capability_job("vlm:vocabulary", operation)


@app.post(
    "/api/jobs/capabilities/vlm:caption",
    response_model=ProcessingJobStart,
)
async def capability_vlm_caption(file: UploadFile = File(...)) -> ProcessingJobStart:
    _require_capability("vlm:caption")
    image = await _capability_image(file)

    def operation() -> CaptionResult:
        prompt, metrics = caption_background(image)
        return CaptionResult(prompt=prompt, vramPeaksMb=metrics)

    return _enqueue_capability_job("vlm:caption", operation)
