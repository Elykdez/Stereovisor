from __future__ import annotations

import gc
import hashlib
import json
import logging
import math
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
import uuid
import warnings
from collections import deque
from collections.abc import Callable, Iterable
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

from .ai_models import (
    CUSTOM_OBJECT_LABELS,
    DEFAULT_SEGMENTATION_DENSITY,
    InstanceMask,
    begin_vram_stage,
    grounded_sam_instances,
    normalize_segmentation_density,
    normalize_segmentation_labels,
    peak_vram_mb,
    verify_vram_peak,
)
from .config import DEVICE, MODEL_ROOT
from .depth import (
    depth_for_mask,
    depth_preview,
    estimate_near_map,
    foreground_depth_plane,
)
from .jobs import JobCancelled
from .refinement import (
    generate_background_prompt,
    powerpaint_inpaint,
    propose_object_vocabulary,
)
from .schemas import InpaintHistoryPayload, LayerPayload, ProjectPayload
from .storage import asset_url

logger = logging.getLogger(__name__)


PIPELINE_LOCK = threading.Lock()
INPAINT_HISTORY_LOCK = threading.Lock()
MASK_HISTORY_LOCK = threading.Lock()
MERGE_HISTORY_LOCK = threading.Lock()
ProgressCallback = Callable[[int, str, str], None]
CancellationCheck = Callable[[], None]
INPAINT_HISTORY_LIMIT = 20
MASK_HISTORY_LIMIT = 20
MERGE_HISTORY_LIMIT = 20
# Manual layer creation is user-driven, so both the count and the name it can
# store are bounded before they reach project storage and the export manifest.
MAX_LAYERS = 64
MAX_LAYER_NAME_LENGTH = 80
LAMA_URL = (
    "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
)
LAMA_MD5 = "e3aa4aaa15225a33ec84f9f4bc47e500"
INSPYRENET_MODEL_URL = "https://github.com/plemeri/transparent-background/releases/download/1.2.12/ckpt_base.pth"
INSPYRENET_MODEL_MD5 = "d692e3dd5fa1b9658949d452bebf1cda"


class PipelineError(RuntimeError):
    pass


class MatteRejected(PipelineError):
    """A single segmentation proposal did not contain a usable InSPyReNet subject."""


def _report(
    progress: ProgressCallback | None, percent: int, stage: str, message: str
) -> None:
    if progress is not None:
        progress(percent, stage, message)


def _check_cancelled(cancelled: CancellationCheck | None) -> None:
    if cancelled is not None:
        cancelled()


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _bounds(mask: np.ndarray) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask > 0)
    if len(xs) == 0:
        raise PipelineError("A segmentation proposal produced an empty mask")
    return int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)


def _initial_depth(mask: np.ndarray) -> float:
    height, width = mask.shape
    x0, y0, x1, y1 = _bounds(mask)
    bottom = y1 / height
    area = float(np.count_nonzero(mask)) / float(width * height)
    return round(_clamp(0.1 + 0.62 * bottom + 0.28 * math.sqrt(area), 0.12, 0.96), 3)


def _invalidate_background(project: ProjectPayload) -> ProjectPayload:
    return project.model_copy(
        update={
            "backgroundUrl": None,
            "unionMaskUrl": None,
            "backgroundPrompt": None,
            "inpaintProvider": None,
        }
    )


def _inpaint_target_path(
    project: ProjectPayload, directory: Path, target_id: str
) -> Path:
    if target_id == "background":
        if not project.backgroundUrl:
            raise PipelineError(
                "Build the scene before restoring layer inpaint history"
            )
        return directory / Path(project.backgroundUrl).name
    layer = next(
        (candidate for candidate in project.layers if candidate.id == target_id), None
    )
    if layer is None:
        raise PipelineError("The layer inpaint history selected an unknown target")
    return directory / Path(layer.cutoutUrl).name


def _inpaint_history_stack(directory: Path, target_id: str, stack: str) -> Path:
    target_key = hashlib.sha256(target_id.encode("utf-8")).hexdigest()
    return directory / ".inpaint-history" / target_key / stack


def _history_entries(directory: Path, target_id: str, stack: str) -> list[Path]:
    stack_directory = _inpaint_history_stack(directory, target_id, stack)
    return sorted(stack_directory.glob("*.png")) if stack_directory.is_dir() else []


def _push_inpaint_history(
    project: ProjectPayload, directory: Path, target_id: str, stack: str
) -> None:
    source = _inpaint_target_path(project, directory, target_id)
    stack_directory = _inpaint_history_stack(directory, target_id, stack)
    stack_directory.mkdir(parents=True, exist_ok=True)
    snapshot = stack_directory / f"{time.time_ns():020d}-{uuid.uuid4().hex}.png"
    shutil.copy2(source, snapshot)
    for stale in _history_entries(directory, target_id, stack)[:-INPAINT_HISTORY_LIMIT]:
        stale.unlink(missing_ok=True)


def _clear_inpaint_history(directory: Path, target_id: str, stack: str) -> None:
    for entry in _history_entries(directory, target_id, stack):
        entry.unlink(missing_ok=True)


def record_inpaint_history(
    project: ProjectPayload, directory: Path, target_id: str
) -> None:
    # Snapshot before overwrite and clear redo: this is the same ordering users
    # expect from a conventional undo stack.
    with INPAINT_HISTORY_LOCK:
        _push_inpaint_history(project, directory, target_id, "undo")
        _clear_inpaint_history(directory, target_id, "redo")
    logger.info("inpaint history recorded: project=%s target=%s", project.id, target_id)


def restore_inpaint_history(
    project: ProjectPayload,
    directory: Path,
    target_id: str,
    action: str,
) -> ProjectPayload:
    if action not in {"undo", "redo"}:
        logger.warning(
            "inpaint history rejected: project=%s target=%s action=%s",
            project.id,
            target_id,
            action,
        )
        raise PipelineError("The inpaint history action is invalid")
    opposite = "redo" if action == "undo" else "undo"
    with INPAINT_HISTORY_LOCK:
        entries = _history_entries(directory, target_id, action)
        if not entries:
            raise PipelineError(f"There is no {action} state for this layer")
        current = _inpaint_target_path(project, directory, target_id)
        _push_inpaint_history(project, directory, target_id, opposite)
        snapshot = entries[-1]
        shutil.copy2(snapshot, current)
        snapshot.unlink(missing_ok=True)
    logger.info(
        "inpaint history restored: project=%s target=%s action=%s",
        project.id,
        target_id,
        action,
    )
    return project


def inpaint_history(
    project: ProjectPayload, directory: Path
) -> list[InpaintHistoryPayload]:
    target_ids = ["background", *(layer.id for layer in project.layers)]
    return [
        InpaintHistoryPayload(
            targetId=target_id,
            canUndo=bool(_history_entries(directory, target_id, "undo")),
            canRedo=bool(_history_entries(directory, target_id, "redo")),
        )
        for target_id in target_ids
    ]


def _mask_history_stack(directory: Path, layer_id: str, stack: str) -> Path:
    target_key = hashlib.sha256(layer_id.encode("utf-8")).hexdigest()
    return directory / ".mask-history" / target_key / stack


def _mask_history_entries(directory: Path, layer_id: str, stack: str) -> list[Path]:
    stack_directory = _mask_history_stack(directory, layer_id, stack)
    return sorted(stack_directory.glob("*.png")) if stack_directory.is_dir() else []


def _layer_mask_path(project: ProjectPayload, directory: Path, layer_id: str) -> Path:
    layer = next(
        (candidate for candidate in project.layers if candidate.id == layer_id), None
    )
    if layer is None:
        raise PipelineError("The mask history selected an unknown layer")
    return directory / Path(layer.maskUrl).name


def _push_mask_history(
    project: ProjectPayload, directory: Path, layer_id: str, stack: str
) -> None:
    layer = next(
        (candidate for candidate in project.layers if candidate.id == layer_id), None
    )
    if layer is None:
        raise PipelineError("The mask history selected an unknown layer")
    source = _layer_mask_path(project, directory, layer_id)
    if not source.is_file():
        raise PipelineError("The layer mask is missing from this project")
    stack_directory = _mask_history_stack(directory, layer_id, stack)
    stack_directory.mkdir(parents=True, exist_ok=True)
    snapshot = stack_directory / f"{time.time_ns():020d}-{uuid.uuid4().hex}.png"
    shutil.copy2(source, snapshot)
    snapshot.with_suffix(".json").write_text(
        json.dumps(
            {"refinementState": layer.refinementState, "confirmed": layer.confirmed}
        ),
        encoding="utf-8",
    )
    for stale in _mask_history_entries(directory, layer_id, stack)[
        :-MASK_HISTORY_LIMIT
    ]:
        stale.unlink(missing_ok=True)
        stale.with_suffix(".json").unlink(missing_ok=True)


def _clear_mask_history(directory: Path, layer_id: str, stack: str) -> None:
    for entry in _mask_history_entries(directory, layer_id, stack):
        entry.unlink(missing_ok=True)
        entry.with_suffix(".json").unlink(missing_ok=True)


def record_mask_refine_history(
    project: ProjectPayload, directory: Path, layer_id: str
) -> None:
    # Mask history stores metadata beside each alpha snapshot so undo restores
    # both pixels and review state (rough/refined and confirmed).
    with MASK_HISTORY_LOCK:
        _push_mask_history(project, directory, layer_id, "undo")
        _clear_mask_history(directory, layer_id, "redo")
    logger.info("mask history recorded: project=%s layer=%s", project.id, layer_id)


def restore_mask_history(
    project: ProjectPayload,
    directory: Path,
    layer_id: str,
    action: str,
) -> ProjectPayload:
    if action not in {"undo", "redo"}:
        logger.warning(
            "mask history rejected: project=%s layer=%s action=%s",
            project.id,
            layer_id,
            action,
        )
        raise PipelineError("The mask history action is invalid")
    opposite = "redo" if action == "undo" else "undo"
    with MASK_HISTORY_LOCK:
        entries = _mask_history_entries(directory, layer_id, action)
        if not entries:
            raise PipelineError(f"There is no {action} mask state for this layer")
        current = _layer_mask_path(project, directory, layer_id)
        _push_mask_history(project, directory, layer_id, opposite)
        snapshot = entries[-1]
        shutil.copy2(snapshot, current)
        metadata_path = snapshot.with_suffix(".json")
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            metadata = {}
        snapshot.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)

        alpha = Image.open(current).convert("L")
        source = Image.open(directory / "source.png").convert("RGBA")
        cutout_path = (
            directory
            / Path(
                next(
                    layer for layer in project.layers if layer.id == layer_id
                ).cutoutUrl
            ).name
        )
        source.putalpha(alpha)
        source.save(cutout_path)
        binary = np.where(np.asarray(alpha, dtype=np.uint8) > 8, 255, 0).astype(
            np.uint8
        )
        restored_state = metadata.get("refinementState")
        if restored_state not in {"rough", "refined"}:
            restored_state = "rough"
        restored_confirmed = bool(metadata.get("confirmed", False))
        updated_layers = [
            (
                layer.model_copy(
                    update={
                        "bounds": _bounds(binary),
                        "refinementState": restored_state,
                        "confirmed": restored_confirmed,
                        "maskRevision": layer.maskRevision + 1,
                    }
                )
                if layer.id == layer_id
                else layer
            )
            for layer in project.layers
        ]
    logger.info(
        "mask history restored: project=%s layer=%s action=%s",
        project.id,
        layer_id,
        action,
    )
    return project.model_copy(update={"layers": updated_layers})


def mask_history(
    project: ProjectPayload, directory: Path
) -> list[InpaintHistoryPayload]:
    return [
        InpaintHistoryPayload(
            targetId=layer.id,
            canUndo=bool(_mask_history_entries(directory, layer.id, "undo")),
            canRedo=bool(_mask_history_entries(directory, layer.id, "redo")),
        )
        for layer in project.layers
    ]


def _merge_history_stack(directory: Path, stack: str) -> Path:
    return directory / ".layer-merge-history" / stack


def _merge_history_entries(directory: Path, stack: str) -> list[Path]:
    stack_directory = _merge_history_stack(directory, stack)
    return (
        sorted(
            (entry for entry in stack_directory.iterdir() if entry.is_dir()),
            key=lambda entry: entry.name,
        )
        if stack_directory.is_dir()
        else []
    )


def _push_merge_history(project: ProjectPayload, directory: Path, stack: str) -> None:
    snapshot = (
        _merge_history_stack(directory, stack)
        / f"{time.time_ns():020d}-{uuid.uuid4().hex}"
    )
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "project.json").write_text(
        project.model_dump_json(indent=2), encoding="utf-8"
    )
    for asset in directory.glob("*.png"):
        shutil.copy2(asset, snapshot / asset.name)
    for history_name in (".mask-history", ".inpaint-history"):
        history = directory / history_name
        if history.is_dir():
            shutil.copytree(history, snapshot / history_name)
    for stale in _merge_history_entries(directory, stack)[:-MERGE_HISTORY_LIMIT]:
        shutil.rmtree(stale, ignore_errors=True)


def _clear_merge_history(directory: Path, stack: str) -> None:
    for entry in _merge_history_entries(directory, stack):
        shutil.rmtree(entry, ignore_errors=True)


def record_layer_merge_history(project: ProjectPayload, directory: Path) -> None:
    # A merge replaces several layer assets and metadata, so keep one complete
    # project snapshot rather than trying to reconstruct removed layer files.
    with MERGE_HISTORY_LOCK:
        _push_merge_history(project, directory, "undo")
        _clear_merge_history(directory, "redo")
    logger.info("layer merge history recorded: project=%s", project.id)


def restore_layer_merge_history(
    project: ProjectPayload,
    directory: Path,
    action: str,
) -> ProjectPayload:
    if action not in {"undo", "redo"}:
        raise PipelineError("The layer merge history action is invalid")
    opposite = "redo" if action == "undo" else "undo"
    with MERGE_HISTORY_LOCK:
        entries = _merge_history_entries(directory, action)
        if not entries:
            raise PipelineError(f"There is no {action} layer merge state")
        _push_merge_history(project, directory, opposite)
        snapshot = entries[-1]
        snapshot_project = ProjectPayload.model_validate_json(
            (snapshot / "project.json").read_text(encoding="utf-8")
        )
        for asset in directory.glob("*.png"):
            asset.unlink(missing_ok=True)
        for asset in snapshot.glob("*.png"):
            shutil.copy2(asset, directory / asset.name)
        for history_name in (".mask-history", ".inpaint-history"):
            current_history = directory / history_name
            snapshot_history = snapshot / history_name
            if current_history.exists():
                shutil.rmtree(current_history, ignore_errors=True)
            if snapshot_history.is_dir():
                shutil.copytree(snapshot_history, current_history)
        shutil.rmtree(snapshot, ignore_errors=True)
    logger.info(
        "layer merge history restored: project=%s action=%s", project.id, action
    )
    return snapshot_project


def layer_merge_history(
    project: ProjectPayload, directory: Path
) -> list[InpaintHistoryPayload]:
    return [
        InpaintHistoryPayload(
            targetId="layers",
            canUndo=bool(_merge_history_entries(directory, "undo")),
            canRedo=bool(_merge_history_entries(directory, "redo")),
        )
    ]


def merge_layer_masks(
    project: ProjectPayload,
    directory: Path,
    layer_ids: list[str],
) -> ProjectPayload:
    unique_ids = list(dict.fromkeys(layer_ids))
    if len(unique_ids) < 2:
        raise PipelineError("Select at least two layers to merge")
    known = {layer.id: layer for layer in project.layers}
    if any(layer_id not in known for layer_id in unique_ids):
        raise PipelineError("The layer merge selected an unknown layer")

    # Use project order for a deterministic survivor and stable depth/order.
    selected = [layer for layer in project.layers if layer.id in unique_ids]
    source = Image.open(directory / "source.png").convert("RGB")
    masks = []
    for layer in selected:
        mask = Image.open(directory / Path(layer.maskUrl).name).convert("L")
        if mask.size != source.size:
            raise PipelineError(
                "The selected layer masks do not match the source image"
            )
        masks.append(np.asarray(mask, dtype=np.uint8))
    alpha = np.maximum.reduce(masks)
    if not np.count_nonzero(alpha > 8):
        raise PipelineError("The selected layer masks are empty")

    record_layer_merge_history(project, directory)
    for layer in selected:
        _clear_mask_history(directory, layer.id, "undo")
        _clear_mask_history(directory, layer.id, "redo")
    survivor = selected[0]
    mask_name = Path(survivor.maskUrl).name
    proposal_name = (
        Path(survivor.proposalMaskUrl).name
        if survivor.proposalMaskUrl
        else f"{survivor.id}-proposal-mask.png"
    )
    cutout_name = Path(survivor.cutoutUrl).name
    Image.fromarray(alpha).save(directory / mask_name)
    Image.fromarray(alpha).save(directory / proposal_name)
    cutout = source.convert("RGBA")
    cutout.putalpha(Image.fromarray(alpha))
    cutout.save(directory / cutout_name)

    removed_assets = (
        {Path(layer.cutoutUrl).name for layer in selected[1:]}
        | {Path(layer.maskUrl).name for layer in selected[1:]}
        | {
            Path(layer.proposalMaskUrl).name
            for layer in selected[1:]
            if layer.proposalMaskUrl
        }
    )
    for asset_name in removed_assets:
        (directory / asset_name).unlink(missing_ok=True)

    merged_layer = survivor.model_copy(
        update={
            "name": f"Merged ({len(selected)} objects)",
            "proposalMaskUrl": asset_url(project.id, proposal_name),
            "refinementState": "rough",
            "confirmed": False,
            "maskRevision": survivor.maskRevision + 1,
            "bounds": _bounds(np.where(alpha > 8, 255, 0).astype(np.uint8)),
            "selected": any(layer.selected for layer in selected),
            "visible": any(layer.visible for layer in selected),
            "confidence": round(max(layer.confidence for layer in selected), 3),
        }
    )
    updated_layers = [
        merged_layer if layer.id == survivor.id else layer
        for layer in project.layers
        if layer.id == survivor.id or layer.id not in unique_ids
    ]
    updated = _invalidate_background(
        project.model_copy(update={"layers": updated_layers})
    )
    logger.info(
        "layer masks merged: project=%s selected=%s survivor=%s",
        project.id,
        unique_ids,
        survivor.id,
    )
    return updated


def _save_layer(
    image: Image.Image,
    alpha: np.ndarray,
    directory: Path,
    project_id: str,
    index: int,
    name: str | None = None,
    depth: float | None = None,
    kind: str = "instance",
    confidence: float = 1.0,
) -> LayerPayload:
    layer_id = f"layer-{index + 1:02d}"
    mask_name = f"{layer_id}-mask.png"
    proposal_name = f"{layer_id}-proposal-mask.png"
    cutout_name = f"{layer_id}-cutout.png"
    alpha_image = Image.fromarray(alpha.astype(np.uint8))
    rgba = image.convert("RGBA")
    rgba.putalpha(alpha_image)
    alpha_image.save(directory / mask_name)
    alpha_image.save(directory / proposal_name)
    rgba.save(directory / cutout_name)
    return LayerPayload(
        id=layer_id,
        name=name or f"Object {index + 1:02d}",
        cutoutUrl=asset_url(project_id, cutout_name),
        maskUrl=asset_url(project_id, mask_name),
        proposalMaskUrl=asset_url(project_id, proposal_name),
        refinementState="rough",
        confirmed=False,
        depth=depth if depth is not None else _initial_depth(alpha),
        order=index,
        bounds=_bounds(alpha),
        kind=kind,
        confidence=round(float(confidence), 3),
    )


def replace_layer_mask(
    project: ProjectPayload,
    directory: Path,
    layer_id: str,
    mask: Image.Image,
    *,
    update_proposal: bool = True,
    clear_history: bool = True,
) -> ProjectPayload:
    # Threshold only for bounds/validation; the original alpha is retained for
    # soft edges in the cutout. A revision then tells the renderer to reload it.
    known = {layer.id: layer for layer in project.layers}
    if layer_id not in known:
        logger.warning(
            "mask replacement rejected: project=%s layer=%s unknown",
            project.id,
            layer_id,
        )
        raise PipelineError("The mask editor selected an unknown layer")
    source = Image.open(directory / "source.png").convert("RGB")
    if mask.size != source.size:
        logger.warning(
            "mask replacement rejected: project=%s layer=%s size=%s expected=%s",
            project.id,
            layer_id,
            mask.size,
            source.size,
        )
        raise PipelineError("The edited mask dimensions do not match the source image")
    alpha = np.asarray(mask.convert("L"), dtype=np.uint8)
    binary = np.where(alpha > 8, 255, 0).astype(np.uint8)
    if not np.count_nonzero(binary):
        logger.warning(
            "mask replacement rejected: project=%s layer=%s empty", project.id, layer_id
        )
        raise PipelineError("An object mask cannot be empty; disable the layer instead")

    layer = known[layer_id]
    mask_name = Path(layer.maskUrl).name
    cutout_name = Path(layer.cutoutUrl).name
    Image.fromarray(alpha).save(directory / mask_name)
    proposal_url = layer.proposalMaskUrl
    if update_proposal:
        proposal_name = (
            Path(proposal_url).name if proposal_url else f"{layer_id}-proposal-mask.png"
        )
        Image.fromarray(alpha).save(directory / proposal_name)
        proposal_url = asset_url(project.id, proposal_name)
    cutout = source.convert("RGBA")
    cutout.putalpha(Image.fromarray(alpha))
    cutout.save(directory / cutout_name)
    updated_layers = [
        (
            candidate.model_copy(
                update={
                    "bounds": _bounds(binary),
                    "confirmed": False,
                    "maskRevision": candidate.maskRevision + 1,
                    "proposalMaskUrl": proposal_url,
                }
            )
            if candidate.id == layer_id
            else candidate
        )
        for candidate in project.layers
    ]
    if clear_history:
        with MASK_HISTORY_LOCK:
            _clear_mask_history(directory, layer_id, "undo")
            _clear_mask_history(directory, layer_id, "redo")
    updated = _invalidate_background(
        project.model_copy(update={"layers": updated_layers})
    )
    logger.info(
        "mask replaced: project=%s layer=%s revision=%s pixels=%s",
        project.id,
        layer_id,
        known[layer_id].maskRevision + 1,
        int(np.count_nonzero(binary)),
    )
    return updated


def confirm_layer_mask(project: ProjectPayload, layer_id: str) -> ProjectPayload:
    if layer_id not in {layer.id for layer in project.layers}:
        logger.warning(
            "mask confirmation rejected: project=%s layer=%s unknown",
            project.id,
            layer_id,
        )
        raise PipelineError("The mask review selected an unknown layer")
    # Confirmation changes review metadata only; image assets remain untouched.
    logger.info("mask confirmed in pipeline: project=%s layer=%s", project.id, layer_id)
    return project.model_copy(
        update={
            "layers": [
                (
                    layer.model_copy(update={"confirmed": True})
                    if layer.id == layer_id
                    else layer
                )
                for layer in project.layers
            ]
        }
    )


def _next_layer_index(project: ProjectPayload) -> int:
    """Lowest free `layer-NN` slot so a new layer never reuses live assets."""
    used = {
        int(match.group(1))
        for match in (
            re.fullmatch(r"layer-(\d+)", layer.id) for layer in project.layers
        )
        if match
    }
    index = 0
    while index + 1 in used:
        index += 1
    return index


def clean_layer_name(name: str) -> str:
    # Collapse whitespace so a pasted multi-line name cannot break the layer
    # list or the exported manifest.
    cleaned = " ".join(name.split())
    if not cleaned:
        raise PipelineError("A layer name cannot be empty")
    return cleaned[:MAX_LAYER_NAME_LENGTH]


def create_layer_from_mask(
    project: ProjectPayload,
    directory: Path,
    mask: Image.Image,
    name: str | None = None,
) -> ProjectPayload:
    """Add a hand-brushed foreground layer to an already analyzed project."""
    if len(project.layers) >= MAX_LAYERS:
        raise PipelineError(f"A project is limited to {MAX_LAYERS} layers")
    source = Image.open(directory / "source.png").convert("RGB")
    if mask.size != source.size:
        raise PipelineError(
            "The new layer mask dimensions do not match the source image"
        )
    alpha = np.asarray(mask.convert("L"), dtype=np.uint8)
    if not np.count_nonzero(alpha > 8):
        raise PipelineError("Paint an area before adding it as a layer")

    index = _next_layer_index(project)
    # A brushed region is not a detector proposal, so it carries the manual kind:
    # refinement aligns it to image edges instead of assuming one salient subject.
    layer = _save_layer(
        source,
        alpha,
        directory,
        project.id,
        index,
        name=clean_layer_name(name) if name else f"Area {index + 1:02d}",
        kind="manual",
    )
    layer = layer.model_copy(
        update={
            "order": max((candidate.order for candidate in project.layers), default=-1)
            + 1
        }
    )
    # A new foreground invalidates any built plate: its pixels must be rebuilt.
    updated = _invalidate_background(
        project.model_copy(update={"layers": [*project.layers, layer]})
    )
    logger.info(
        "layer created: project=%s layer=%s pixels=%s layers=%s",
        project.id,
        layer.id,
        int(np.count_nonzero(alpha > 8)),
        len(updated.layers),
    )
    return updated


def rename_layer(project: ProjectPayload, layer_id: str, name: str) -> ProjectPayload:
    if layer_id not in {layer.id for layer in project.layers}:
        raise PipelineError("The rename request selected an unknown layer")
    cleaned = clean_layer_name(name)
    logger.info("layer renamed: project=%s layer=%s", project.id, layer_id)
    return project.model_copy(
        update={
            "layers": [
                (
                    layer.model_copy(update={"name": cleaned})
                    if layer.id == layer_id
                    else layer
                )
                for layer in project.layers
            ]
        }
    )


def delete_layer(
    project: ProjectPayload, directory: Path, layer_id: str
) -> ProjectPayload:
    known = {layer.id: layer for layer in project.layers}
    if layer_id not in known:
        raise PipelineError("The delete request selected an unknown layer")
    layer = known[layer_id]

    # Snapshot the whole layer set first. Deleting removes image assets that
    # cannot be reconstructed, so it shares the reversible layer history.
    record_layer_merge_history(project, directory)
    with MASK_HISTORY_LOCK:
        _clear_mask_history(directory, layer_id, "undo")
        _clear_mask_history(directory, layer_id, "redo")
    for asset in (layer.cutoutUrl, layer.maskUrl, layer.proposalMaskUrl):
        if asset:
            (directory / Path(asset).name).unlink(missing_ok=True)

    remaining = [candidate for candidate in project.layers if candidate.id != layer_id]
    updated = _invalidate_background(project.model_copy(update={"layers": remaining}))
    logger.info(
        "layer deleted: project=%s layer=%s remaining=%s",
        project.id,
        layer_id,
        len(remaining),
    )
    return updated


def save_extra_inpaint_mask(
    project: ProjectPayload,
    directory: Path,
    mask: Image.Image,
) -> ProjectPayload:
    source = Image.open(directory / "source.png")
    if mask.size != source.size:
        raise PipelineError(
            "The extra inpaint mask dimensions do not match the source image"
        )
    name = "extra-inpaint-mask.png"
    mask.convert("L").save(directory / name)
    return _invalidate_background(
        project.model_copy(update={"extraMaskUrl": asset_url(project.id, name)})
    )


def _connected_components(binary: np.ndarray) -> list[np.ndarray]:
    height, width = binary.shape
    visited = np.zeros_like(binary, dtype=bool)
    components: list[tuple[int, np.ndarray]] = []
    min_area = max(14, int(height * width * 0.004))
    max_area = int(height * width * 0.68)

    for start_y in range(height):
        for start_x in range(width):
            if not binary[start_y, start_x] or visited[start_y, start_x]:
                continue
            queue = deque([(start_x, start_y)])
            visited[start_y, start_x] = True
            pixels: list[tuple[int, int]] = []
            while queue:
                x, y = queue.popleft()
                pixels.append((x, y))
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if (
                        0 <= nx < width
                        and 0 <= ny < height
                        and binary[ny, nx]
                        and not visited[ny, nx]
                    ):
                        visited[ny, nx] = True
                        queue.append((nx, ny))
            if min_area <= len(pixels) <= max_area:
                component = np.zeros_like(binary, dtype=np.uint8)
                xs, ys = zip(*pixels)
                component[np.asarray(ys), np.asarray(xs)] = 255
                components.append((len(pixels), component))

    components.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in components[:8]]


def preview_masks(image: Image.Image) -> list[np.ndarray]:
    working = image.convert("RGB")
    scale = min(1.0, 320.0 / max(working.size))
    small_size = (
        max(1, round(working.width * scale)),
        max(1, round(working.height * scale)),
    )
    small = working.resize(small_size, Image.Resampling.LANCZOS)
    rgb = np.asarray(small, dtype=np.int16)
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]), axis=0)
    border_color = np.median(border, axis=0)
    distance = np.sqrt(np.square(rgb - border_color).sum(axis=2))
    channel_range = rgb.max(axis=2) - rgb.min(axis=2)
    binary = (distance > 48) & ((channel_range > 28) | (distance > 88))
    masks = _connected_components(binary)
    return [
        np.asarray(
            Image.fromarray(mask).resize(working.size, Image.Resampling.NEAREST),
            dtype=np.uint8,
        )
        for mask in masks
    ]


def _mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    intersection = np.count_nonzero((a > 0) & (b > 0))
    union = np.count_nonzero((a > 0) | (b > 0))
    return intersection / union if union else 0.0


def _filter_masks(
    masks: Iterable[np.ndarray], width: int, height: int
) -> list[np.ndarray]:
    total = width * height
    candidates: list[tuple[int, np.ndarray]] = []
    for raw in masks:
        mask = (raw > 0).astype(np.uint8) * 255
        area = int(np.count_nonzero(mask))
        ratio = area / total
        if 0.0075 <= ratio <= 0.72:
            candidates.append((area, mask))
    candidates.sort(key=lambda item: item[0], reverse=True)
    accepted: list[np.ndarray] = []
    for _, mask in candidates:
        if all(_mask_iou(mask, existing) < 0.82 for existing in accepted):
            accepted.append(mask)
        if len(accepted) == 8:
            break
    return accepted


class PreviewPipeline:
    engine = "preview"

    def analyze(
        self,
        image: Image.Image,
        directory: Path,
        project_id: str,
        segmentation_density: str = DEFAULT_SEGMENTATION_DENSITY,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
        *,
        segmentation_labels: str | None = None,
        use_vlm_vocabulary: bool = False,
    ) -> ProjectPayload:
        del segmentation_density, segmentation_labels, use_vlm_vocabulary
        # Preview segmentation is a deterministic color-region heuristic. It
        # keeps the workflow usable without model weights, but is not a claim
        # of production-quality semantic segmentation.
        logger.info(
            "preview analysis started: project=%s size=%sx%s",
            project_id,
            image.width,
            image.height,
        )
        _check_cancelled(cancelled)
        _report(
            progress, 12, "Segmenting objects", "Finding distinct foreground regions."
        )
        masks = _filter_masks(preview_masks(image), image.width, image.height)
        _check_cancelled(cancelled)
        if not masks:
            logger.warning("preview analysis produced no masks: project=%s", project_id)
            raise PipelineError(
                "The preview engine found no distinct color regions. Install the local AI stack for arbitrary photographs."
            )
        _report(
            progress,
            64,
            "Building layers",
            f"Creating {len(masks)} editable object layers.",
        )
        layers = [
            _save_layer(image, mask, directory, project_id, index)
            for index, mask in enumerate(masks)
        ]
        _check_cancelled(cancelled)
        project = ProjectPayload(
            id=project_id,
            width=image.width,
            height=image.height,
            sourceUrl=asset_url(project_id, "source.png"),
            engine=self.engine,
            layers=layers,
        )
        logger.info(
            "preview analysis completed: project=%s layers=%s", project_id, len(layers)
        )
        return project

    def refine(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_id: str,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
    ) -> ProjectPayload:
        _check_cancelled(cancelled)
        raise PipelineError(
            "Mask refinement requires the Local AI engine and InSPyReNet"
        )

    def inpaint(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_ids: list[str],
        refinement: str = "lama",
        prompt: str | None = None,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
        steps: int = 25,
    ) -> ProjectPayload:
        # The fallback rebuilds the union area with a blurred median-color plate;
        # it intentionally mirrors the production contract and metadata shape.
        logger.info(
            "preview inpaint started: project=%s layers=%s", project.id, len(layer_ids)
        )
        _check_cancelled(cancelled)
        _report(
            progress, 12, "Joining masks", "Combining the selected foreground mattes."
        )
        source = Image.open(directory / "source.png").convert("RGB")
        union = build_union_mask(project, directory, layer_ids)
        union.save(directory / "union-mask.png")
        inpaint_input = build_inpaint_input(source, union)
        inpaint_input.save(directory / "inpaint-input.png")
        radius = max(10, round(min(source.size) / 24))
        _report(
            progress,
            48,
            "Rebuilding background",
            "Synthesizing the hidden background plate.",
        )
        unmasked = np.asarray(source)[np.asarray(union) == 0]
        fill = (
            tuple(np.median(unmasked, axis=0).astype(np.uint8))
            if len(unmasked)
            else (0, 0, 0)
        )
        filled_input = Image.composite(
            Image.new("RGB", source.size, fill), inpaint_input, union
        )
        synthesized = filled_input.filter(ImageFilter.GaussianBlur(radius=radius))
        background = Image.composite(synthesized, source, union)
        _check_cancelled(cancelled)
        background.save(directory / "background.png")
        updated = project.model_copy(
            update={
                "backgroundUrl": asset_url(project.id, "background.png"),
                "unionMaskUrl": asset_url(project.id, "union-mask.png"),
                "inpaintProvider": "preview",
            }
        )
        logger.info("preview inpaint completed: project=%s", project.id)
        return updated

    def inpaint_target(
        self,
        project: ProjectPayload,
        directory: Path,
        target_id: str,
        composition: Image.Image,
        mask: Image.Image,
        prompt: str | None = None,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
        steps: int = 25,
    ) -> ProjectPayload:
        _check_cancelled(cancelled)
        raise PipelineError(
            "Layer inpainting requires the Local AI engine and PowerPaint"
        )


def _resolve_device(torch_module: object) -> str:
    cuda = getattr(torch_module, "cuda")
    if DEVICE == "cpu":
        return "cpu"
    if DEVICE == "cuda" and not cuda.is_available():
        raise PipelineError(
            "CUDA was requested but the managed Torch runtime cannot access the GPU"
        )
    return "cuda" if cuda.is_available() else "cpu"


def _release_cuda(torch_module: object) -> None:
    gc.collect()
    cuda = getattr(torch_module, "cuda")
    if cuda.is_available():
        synchronize = getattr(cuda, "synchronize", None)
        if callable(synchronize):
            synchronize()
        cuda.empty_cache()


_inspyrenet_remover: object | None = None


def _download_with_resume(
    url: str,
    target: Path,
    expected_md5: str,
    progress_callback: Callable[[int], None] | None = None,
) -> None:
    # Resume through a .part file, then verify the complete checksum before the
    # atomic rename. Partial or tampered model files never become loadable.
    logger.info("model download started: target=%s", target.name)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(f"{target.suffix}.part")
    last_error: Exception | None = None
    for attempt in range(8):
        offset = partial.stat().st_size if partial.is_file() else 0
        headers = {"User-Agent": "Stereovisor/0.1"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                status = getattr(response, "status", 200)
                if offset and status != 206:
                    partial.unlink(missing_ok=True)
                    continue
                content_range = response.headers.get("Content-Range", "")
                try:
                    total = (
                        int(content_range.rsplit("/", 1)[1])
                        if "/" in content_range
                        else offset + int(response.headers["Content-Length"])
                    )
                except (KeyError, TypeError, ValueError):
                    total = 0
                last_progress = -1
                with partial.open("ab" if offset else "wb") as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                        if progress_callback and total > 0:
                            progress = min(100, int(output.tell() * 100 / total))
                            if progress != last_progress:
                                progress_callback(progress)
                                last_progress = progress
            digest = hashlib.md5(partial.read_bytes()).hexdigest()
            if digest != expected_md5:
                # Resumed bytes that fail the checksum cannot be trusted, and a
                # full-length .part would make every later attempt ask for a
                # range past the end of the file. Discard it.
                partial.unlink(missing_ok=True)
                logger.warning(
                    "model checksum mismatch: target=%s attempt=%s",
                    target.name,
                    attempt + 1,
                )
                raise PipelineError(
                    f"Downloaded model failed its checksum: {target.name}"
                )
            partial.replace(target)
            logger.info(
                "model download verified: target=%s bytes=%s",
                target.name,
                target.stat().st_size,
            )
            return
        except PipelineError:
            raise
        except Exception as error:
            if isinstance(error, urllib.error.HTTPError) and error.code == 416:
                # The leftover .part is at or past the end of the remote file,
                # so no range request can extend it. Start the next attempt
                # from zero instead of asking for the same rejected range.
                partial.unlink(missing_ok=True)
            last_error = error
            logger.warning(
                "model download retry: target=%s attempt=%s error=%s",
                target.name,
                attempt + 1,
                error,
            )
            if attempt < 7:
                time.sleep(min(8, 2**attempt))
    raise PipelineError(
        f"Model download did not complete after retries: {target.name}"
    ) from last_error


def _ensure_inspyrenet_model() -> Path:
    model_directory = MODEL_ROOT / "inspyrenet"
    os.environ["TRANSPARENT_BACKGROUND_FILE_PATH"] = str(model_directory)
    model_path = model_directory / "ckpt_base.pth"
    if not model_path.is_file():
        _download_with_resume(INSPYRENET_MODEL_URL, model_path, INSPYRENET_MODEL_MD5)
    else:
        logger.info("InSPyReNet model cache hit: path=%s", model_path)
    return model_path


def _release_inspyrenet() -> None:
    global _inspyrenet_remover
    remover = _inspyrenet_remover
    _inspyrenet_remover = None
    if remover is None:
        return
    del remover
    try:
        import torch
    except ImportError:
        return
    _release_cuda(torch)


def _matte_mask(image: Image.Image, mask: np.ndarray) -> np.ndarray:
    global _inspyrenet_remover

    x0, y0, x1, y1 = _bounds(mask)
    crop_box = (x0, y0, x1, y1)
    # Background removal must see only the segmented object's AABB, not the full canvas.
    crop = image.crop(crop_box).convert("RGB")
    if _inspyrenet_remover is None:
        try:
            import torch

            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="Failed to import flet.*")
                from transparent_background import Remover
        except ImportError as error:
            raise PipelineError(
                "InSPyReNet is unavailable. Run service/scripts/setup-ai.ps1."
            ) from error
        model_path = _ensure_inspyrenet_model()
        device = _resolve_device(torch)
        _inspyrenet_remover = Remover(
            mode="base",
            jit=False,
            device=device,
            ckpt=str(model_path),
            resize="dynamic",
        )
    output = _inspyrenet_remover.process(crop, type="map")
    matte = np.asarray(output.convert("L"), dtype=np.uint8)
    proposal = np.asarray(Image.fromarray(mask).crop(crop_box), dtype=np.uint8) > 8
    candidate = matte > 12
    overlap = int(np.count_nonzero(candidate & proposal))
    if overlap < max(16, int(np.count_nonzero(proposal) * 0.02)):
        raise MatteRejected(
            "InSPyReNet could not produce a usable alpha matte for a proposed object"
        )
    # The edited mask is the user's object selection. Keep InSPyReNet's soft
    # edges, but never admit pixels outside the designated proposal.
    guided = proposal
    guided_matte = np.where(guided, matte, 0).astype(np.uint8)
    proposal_area = int(np.count_nonzero(proposal))
    guided_area = int(np.count_nonzero(guided_matte > 12))
    guided_overlap = int(np.count_nonzero((guided_matte > 12) & proposal))
    if guided_area < max(16, int(proposal_area * 0.25)) or guided_overlap < max(
        16, int(proposal_area * 0.25)
    ):
        # A repeated pass must not replace the user's selection with a tiny
        # salient fragment. Keep the stable edited proposal when confidence is low.
        matte = np.where(proposal, 255, 0).astype(np.uint8)
    else:
        matte = guided_matte
    full = np.zeros((image.height, image.width), dtype=np.uint8)
    left, top, right, bottom = crop_box
    full[top:bottom, left:right] = matte
    return full


def _guided_mask_refine(
    image: Image.Image, mask: np.ndarray, band_scale: float = 0.12
) -> np.ndarray:
    """Refine an arbitrary rough foreground mask without assuming it is one salient subject."""
    try:
        import cv2
    except ImportError as error:
        raise PipelineError(
            "OpenCV is unavailable. Run service/scripts/setup-ai.ps1."
        ) from error

    binary = (mask > 8).astype(np.uint8)
    area = int(np.count_nonzero(binary))
    if not area:
        raise PipelineError("The selected foreground mask is empty")
    # The band GrabCut is allowed to decide has to scale with the object, not
    # the canvas. A hand-brushed boundary is off by a share of the object's own
    # size, so a fixed few-pixel band leaves the mask essentially unchanged.
    radius = max(
        2, min(round(band_scale * math.sqrt(area)), round(min(binary.shape) * 0.08))
    )
    eroded = np.zeros_like(binary)
    while radius >= 2:
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1)
        )
        eroded = cv2.erode(binary, kernel, iterations=1)
        # A thin or wiry mask can erode away completely. Keep halving the band
        # until a definite-foreground core survives to seed the model.
        if np.count_nonzero(eroded):
            break
        radius //= 2
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (max(radius, 2) * 2 + 1, max(radius, 2) * 2 + 1)
    )
    dilated = cv2.dilate(binary, kernel, iterations=1)
    if not np.count_nonzero(eroded):
        eroded = binary.copy()

    trimap = np.full(binary.shape, cv2.GC_BGD, dtype=np.uint8)
    trimap[dilated > 0] = cv2.GC_PR_BGD
    trimap[binary > 0] = cv2.GC_PR_FGD
    trimap[eroded > 0] = cv2.GC_FGD
    background_model = np.zeros((1, 65), dtype=np.float64)
    foreground_model = np.zeros((1, 65), dtype=np.float64)
    rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    try:
        cv2.grabCut(
            rgb,
            trimap,
            None,
            background_model,
            foreground_model,
            5,
            cv2.GC_INIT_WITH_MASK,
        )
        refined = np.isin(trimap, (cv2.GC_FGD, cv2.GC_PR_FGD))
    except cv2.error:
        refined = binary > 0
    # GrabCut may mark nearby pixels as probable foreground. The edited mask
    # remains the hard boundary for this layer, just like InSPyReNet above.
    refined &= binary > 0
    refined[eroded > 0] = True

    proposal_area = int(np.count_nonzero(binary))
    refined_area = int(np.count_nonzero(refined))
    overlap = int(np.count_nonzero(refined & (binary > 0)))
    if refined_area < proposal_area * 0.25 or overlap < proposal_area * 0.25:
        refined = binary > 0
    alpha = np.asarray(
        Image.fromarray(refined.astype(np.uint8) * 255).filter(
            ImageFilter.GaussianBlur(radius=1.0)
        ),
        dtype=np.uint8,
    ).copy()
    alpha[binary == 0] = 0
    return alpha


def _download_lama(target: Path) -> None:
    _download_with_resume(LAMA_URL, target, LAMA_MD5)


def _pad_to_modulo(
    array: np.ndarray, modulo: int
) -> tuple[np.ndarray, tuple[int, int]]:
    height, width = array.shape[:2]
    padded_height = math.ceil(height / modulo) * modulo
    padded_width = math.ceil(width / modulo) * modulo
    if array.ndim == 3:
        padding = ((0, padded_height - height), (0, padded_width - width), (0, 0))
    else:
        padding = ((0, padded_height - height), (0, padded_width - width))
    return np.pad(array, padding, mode="reflect"), (height, width)


def _lama_inpaint(image: Image.Image, mask: Image.Image) -> tuple[Image.Image, int]:
    try:
        import torch
    except ImportError as error:
        raise PipelineError(
            "Torch is unavailable. Run service/scripts/setup-ai.ps1."
        ) from error

    model_path = MODEL_ROOT / "big-lama.pt"
    if not model_path.is_file():
        _download_lama(model_path)
    device = _resolve_device(torch)
    model = None
    image_tensor = None
    mask_tensor = None
    try:
        begin_vram_stage(torch)
        model = torch.jit.load(str(model_path), map_location=device).eval()
        rgb, original_size = _pad_to_modulo(
            np.asarray(image.convert("RGB"), dtype=np.float32), 8
        )
        binary, _ = _pad_to_modulo(np.asarray(mask.convert("L"), dtype=np.float32), 8)
        image_tensor = (
            torch.from_numpy(rgb.transpose(2, 0, 1) / 255.0).unsqueeze(0).to(device)
        )
        mask_tensor = (
            torch.from_numpy((binary > 0).astype(np.float32))
            .unsqueeze(0)
            .unsqueeze(0)
            .to(device)
        )
        with torch.inference_mode():
            output = model(image_tensor, mask_tensor)
        if isinstance(output, dict):
            output = output.get("inpainted", output.get("output"))
        result = output[0].permute(1, 2, 0).detach().float().cpu().numpy()
        height, width = original_size
        result = np.clip(result[:height, :width] * 255.0, 0, 255).astype(np.uint8)
        return Image.fromarray(result), verify_vram_peak(
            "Big LaMa", peak_vram_mb(torch)
        )
    finally:
        del model, image_tensor, mask_tensor
        _release_cuda(torch)


class ProductionPipeline:
    engine = "ai"

    def analyze(
        self,
        image: Image.Image,
        directory: Path,
        project_id: str,
        segmentation_density: str = DEFAULT_SEGMENTATION_DENSITY,
        segmentation_labels: str | None = None,
        use_vlm_vocabulary: bool = False,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
    ) -> ProjectPayload:
        logger.info(
            "AI analysis started: project=%s density=%s size=%sx%s",
            project_id,
            segmentation_density,
            image.width,
            image.height,
        )
        _check_cancelled(cancelled)
        # The lock serializes model loads and GPU allocations. Depth inference
        # follows segmentation so peak VRAM metrics describe each stage clearly.
        with PIPELINE_LOCK:
            resolved_labels = segmentation_labels
            manual_labels = normalize_segmentation_labels(segmentation_labels)
            environment_labels = normalize_segmentation_labels(CUSTOM_OBJECT_LABELS)
            if use_vlm_vocabulary and not manual_labels and not environment_labels:
                _report(
                    progress,
                    4,
                    "Describing objects",
                    "Qwen3-VL is proposing a scene vocabulary.",
                )
                try:
                    resolved_labels, qwen_peak = propose_object_vocabulary(
                        image,
                        normalize_segmentation_density(segmentation_density),
                    )
                except RuntimeError as error:
                    raise PipelineError(str(error)) from error
                metrics = {"qwen3VlVocabulary": qwen_peak}
                logger.info(
                    "AI vocabulary proposal complete: project=%s labels=%s peak_mb=%s",
                    project_id,
                    len(normalize_segmentation_labels(resolved_labels)),
                    qwen_peak,
                )
            else:
                metrics = {}
            _report(
                progress,
                8,
                "Segmenting objects",
                "Grounding DINO-B and SAM 2.1 are finding individual objects.",
            )
            try:
                instances, segmentation_metrics = grounded_sam_instances(
                    image,
                    normalize_segmentation_density(segmentation_density),
                    resolved_labels,
                )
                metrics.update(segmentation_metrics)
            except RuntimeError as error:
                raise PipelineError(str(error)) from error
            _check_cancelled(cancelled)
            if not instances:
                raise PipelineError(
                    "Grounding DINO-B found no supported foreground objects. "
                    "Edit the segmentation vocabulary or set STEREOVISOR_OBJECT_LABELS and retry."
                )
            _report(
                progress,
                48,
                "Estimating depth",
                "Depth Anything 3 is mapping near and distant regions.",
            )
            try:
                near_map, depth_peak = estimate_near_map(image)
            except RuntimeError as error:
                raise PipelineError(str(error)) from error
            _check_cancelled(cancelled)
            metrics["depthAnything3"] = depth_peak
            logger.info(
                "AI analysis inference complete: project=%s instances=%s metrics=%s",
                project_id,
                len(instances),
                metrics,
            )

        _report(
            progress,
            79,
            "Building layers",
            "Preparing depth ordering and transparent cutouts.",
        )
        _check_cancelled(cancelled)
        depth_preview(near_map).save(directory / "depth-map.png")
        layer_inputs: list[tuple[str, float, np.ndarray, str, float]] = []
        for instance in instances:
            base_name = instance.label.strip().title() or "Object"
            layer_inputs.append(
                (
                    base_name,
                    depth_for_mask(near_map, instance.mask),
                    instance.mask,
                    "instance",
                    instance.score,
                )
            )
        depth_plane = foreground_depth_plane(
            near_map, [instance.mask for instance in instances]
        )
        if depth_plane is not None:
            layer_inputs.append(
                (
                    "Foreground depth plane",
                    depth_for_mask(near_map, depth_plane),
                    depth_plane,
                    "depth-plane",
                    1.0,
                )
            )
            logger.info(
                "AI analysis added foreground depth plane: project=%s", project_id
            )
        layer_inputs.sort(key=lambda item: item[1])
        label_totals: dict[str, int] = {}
        for name, _, _, kind, _ in layer_inputs:
            if kind == "instance":
                label_totals[name] = label_totals.get(name, 0) + 1
        label_indices: dict[str, int] = {}
        layers: list[LayerPayload] = []
        for index, (name, depth, alpha, kind, confidence) in enumerate(layer_inputs):
            _check_cancelled(cancelled)
            _report(
                progress,
                82 + round(index * 14 / max(1, len(layer_inputs))),
                "Building layers",
                f"Saving layer {index + 1} of {len(layer_inputs)}.",
            )
            display_name = name
            if kind == "instance" and label_totals[name] > 1:
                label_indices[name] = label_indices.get(name, 0) + 1
                display_name = f"{name} {label_indices[name]:02d}"
            layers.append(
                _save_layer(
                    image,
                    alpha,
                    directory,
                    project_id,
                    index,
                    name=display_name,
                    depth=depth,
                    kind=kind,
                    confidence=confidence,
                )
            )
        result = ProjectPayload(
            id=project_id,
            width=image.width,
            height=image.height,
            sourceUrl=asset_url(project_id, "source.png"),
            depthMapUrl=asset_url(project_id, "depth-map.png"),
            engine=self.engine,
            layers=layers,
            vramPeaksMb=metrics,
        )
        logger.info(
            "AI analysis completed: project=%s layers=%s metrics=%s",
            project_id,
            len(layers),
            metrics,
        )
        return result

    def refine(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_id: str,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
    ) -> ProjectPayload:
        logger.info("AI refine started: project=%s layer=%s", project.id, layer_id)
        _check_cancelled(cancelled)
        known = {layer.id: layer for layer in project.layers}
        layer = known.get(layer_id)
        if layer is None:
            raise PipelineError("The refine request selected an unknown layer")

        source = Image.open(directory / "source.png").convert("RGB")
        mask = np.asarray(
            Image.open(directory / Path(layer.maskUrl).name).convert("L"),
            dtype=np.uint8,
        )
        guidance_mask = mask
        proposal_path = (
            directory / Path(layer.proposalMaskUrl).name
            if layer.proposalMaskUrl
            else None
        )
        if proposal_path is not None and proposal_path.is_file():
            guidance_mask = np.asarray(
                Image.open(proposal_path).convert("L"), dtype=np.uint8
            )
        else:
            # Projects created before stable proposals were introduced have no
            # proposal asset. Preserve their current edited mask before the
            # first refine so later passes cannot drift to another subject.
            proposal_name = f"{layer_id}-proposal-mask.png"
            Image.fromarray(guidance_mask).save(directory / proposal_name)
            proposal_url = asset_url(project.id, proposal_name)
            project = project.model_copy(
                update={
                    "layers": [
                        (
                            candidate.model_copy(
                                update={"proposalMaskUrl": proposal_url}
                            )
                            if candidate.id == layer_id
                            else candidate
                        )
                        for candidate in project.layers
                    ]
                }
            )
            layer = next(
                candidate for candidate in project.layers if candidate.id == layer_id
            )
            logger.info(
                "AI refine backfilled legacy proposal: project=%s layer=%s",
                project.id,
                layer_id,
            )
        _report(
            progress,
            12,
            "Preparing refinement",
            f"Cropping the original image around {layer.name}.",
        )
        _check_cancelled(cancelled)
        metrics = dict(project.vramPeaksMb)
        with PIPELINE_LOCK:
            if layer.kind == "instance":
                try:
                    try:
                        import torch

                        begin_vram_stage(torch)
                    except ImportError:
                        torch = None
                    _report(
                        progress,
                        36,
                        "Refining mask",
                        "InSPyReNet is removing the local background and resolving soft edges.",
                    )
                    matte = _matte_mask(source, guidance_mask)
                    _check_cancelled(cancelled)
                    if torch is not None:
                        metrics["inspyrenet"] = verify_vram_peak(
                            "InSPyReNet", peak_vram_mb(torch)
                        )
                finally:
                    _release_inspyrenet()
            else:
                _report(
                    progress,
                    36,
                    "Refining mask",
                    "Local mask-guided segmentation is aligning this foreground layer to image edges.",
                )
                matte = _guided_mask_refine(source, guidance_mask)
                _check_cancelled(cancelled)

        _report(
            progress,
            84,
            "Saving refined mask",
            "Updating this layer's alpha and foreground cutout.",
        )
        _check_cancelled(cancelled)
        record_mask_refine_history(project, directory, layer_id)
        updated = replace_layer_mask(
            project,
            directory,
            layer_id,
            Image.fromarray(matte),
            update_proposal=False,
            clear_history=False,
        )
        refined_layers = [
            (
                candidate.model_copy(update={"refinementState": "refined"})
                if candidate.id == layer_id
                else candidate
            )
            for candidate in updated.layers
        ]
        result = updated.model_copy(
            update={"layers": refined_layers, "vramPeaksMb": metrics}
        )
        logger.info(
            "AI refine completed: project=%s layer=%s metrics=%s",
            project.id,
            layer_id,
            metrics,
        )
        return result

    def inpaint(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_ids: list[str],
        refinement: str = "lama",
        prompt: str | None = None,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
        steps: int = 25,
    ) -> ProjectPayload:
        logger.info(
            "AI inpaint started: project=%s layers=%s refinement=%s steps=%s",
            project.id,
            len(layer_ids),
            refinement,
            steps,
        )
        _check_cancelled(cancelled)
        _report(
            progress,
            10,
            "Joining masks",
            "Combining selected objects into the inpainting mask.",
        )
        source = Image.open(directory / "source.png").convert("RGB")
        union = build_union_mask(project, directory, layer_ids)
        union.save(directory / "union-mask.png")
        inpaint_input = build_inpaint_input(source, union)
        inpaint_input_path = directory / "inpaint-input.png"
        inpaint_input.save(inpaint_input_path)
        metrics = dict(project.vramPeaksMb)
        with PIPELINE_LOCK:
            if refinement == "powerpaint":
                logger.info(
                    "AI inpaint provider selected: project=%s provider=powerpaint",
                    project.id,
                )
                try:
                    background_prompt = (prompt or "").strip()
                    if not background_prompt:
                        _report(
                            progress,
                            24,
                            "Describing background",
                            "Qwen3-VL is creating a local background prompt.",
                        )
                        background_prompt, qwen_peak = generate_background_prompt(
                            source
                        )
                        metrics["qwen3Vl"] = qwen_peak
                    _report(
                        progress,
                        42,
                        "Loading PowerPaint",
                        "Loading local checkpoints and preparing CPU/GPU offload before the first denoising step.",
                    )
                    powerpaint_peak = powerpaint_inpaint(
                        inpaint_input_path,
                        directory / "union-mask.png",
                        directory / "background.png",
                        background_prompt,
                        steps=steps,
                        progress=lambda step, total: _report(
                            progress,
                            42 + round(step * 50 / max(1, total)),
                            "Redrawing background",
                            f"PowerPaint denoising step {step} of {total}.",
                        ),
                        cancelled=cancelled,
                    )
                    metrics["powerpaint"] = powerpaint_peak
                except JobCancelled:
                    raise
                except RuntimeError as error:
                    raise PipelineError(str(error)) from error
                provider = "powerpaint"
            else:
                logger.info(
                    "AI inpaint provider selected: project=%s provider=big-lama",
                    project.id,
                )
                background_prompt = None
                _report(
                    progress,
                    34,
                    "Rebuilding background",
                    "Big LaMa is filling the masked structure.",
                )
                generated, lama_peak = _lama_inpaint(inpaint_input, union)
                _check_cancelled(cancelled)
                background = Image.composite(generated, source, union)
                background.save(directory / "background.png")
                metrics["bigLama"] = lama_peak
                provider = "big-lama"
        _report(
            progress,
            94,
            "Finalizing plate",
            "Saving the rebuilt background and scene metadata.",
        )
        _check_cancelled(cancelled)
        result = project.model_copy(
            update={
                "backgroundUrl": asset_url(project.id, "background.png"),
                "unionMaskUrl": asset_url(project.id, "union-mask.png"),
                "backgroundPrompt": background_prompt,
                "inpaintProvider": provider,
                "vramPeaksMb": metrics,
            }
        )
        logger.info(
            "AI inpaint completed: project=%s provider=%s metrics=%s",
            project.id,
            provider,
            metrics,
        )
        return result

    def inpaint_target(
        self,
        project: ProjectPayload,
        directory: Path,
        target_id: str,
        composition: Image.Image,
        mask: Image.Image,
        prompt: str | None = None,
        progress: ProgressCallback | None = None,
        cancelled: CancellationCheck | None = None,
        steps: int = 25,
    ) -> ProjectPayload:
        logger.info(
            "AI target inpaint started: project=%s target=%s steps=%s",
            project.id,
            target_id,
            steps,
        )
        _check_cancelled(cancelled)
        if not project.backgroundUrl:
            raise PipelineError("Build the scene before inpainting an individual layer")
        known = {layer.id: layer for layer in project.layers}
        if target_id != "background" and target_id not in known:
            logger.warning(
                "AI target inpaint rejected: project=%s target=%s unknown",
                project.id,
                target_id,
            )
            raise PipelineError("The layer inpaint request selected an unknown target")
        expected_size = (project.width, project.height)
        if composition.size != expected_size or mask.size != expected_size:
            logger.warning(
                "AI target inpaint rejected: project=%s target=%s dimensions",
                project.id,
                target_id,
            )
            raise PipelineError(
                "The composition and inpaint mask must match the project dimensions"
            )
        alpha = mask.convert("L")
        if not np.count_nonzero(np.asarray(alpha, dtype=np.uint8) > 0):
            logger.warning(
                "AI target inpaint rejected: project=%s target=%s empty mask",
                project.id,
                target_id,
            )
            raise PipelineError("Paint an inpaint area before running PowerPaint")

        source_path = directory / ".layer-inpaint-composition.png"
        mask_path = directory / ".layer-inpaint-mask.png"
        output_path = directory / ".layer-inpaint-result.png"
        composition.convert("RGB").save(source_path)
        alpha.save(mask_path)
        target_name = (
            "Background" if target_id == "background" else known[target_id].name
        )
        resolved_prompt = (
            prompt or ""
        ).strip() or "seamless continuation of the surrounding composition"
        metrics = dict(project.vramPeaksMb)
        try:
            # Temporary composition/mask/result files are private to this
            # operation and are always removed in finally below.
            _report(
                progress,
                18,
                "Preparing layer inpaint",
                f"Using the full composition as context for {target_name}.",
            )
            with PIPELINE_LOCK:
                _report(
                    progress,
                    42,
                    "Loading PowerPaint",
                    "Loading local checkpoints and preparing CPU/GPU offload before the first denoising step.",
                )
                try:
                    peak = powerpaint_inpaint(
                        source_path,
                        mask_path,
                        output_path,
                        resolved_prompt,
                        steps=steps,
                        progress=lambda step, total: _report(
                            progress,
                            42 + round(step * 50 / max(1, total)),
                            "Inpainting layer",
                            f"PowerPaint full-redraw step {step} of {total} for {target_name}.",
                        ),
                        cancelled=cancelled,
                    )
                except JobCancelled:
                    raise
                except RuntimeError as error:
                    raise PipelineError(str(error)) from error
            metrics["powerpaint"] = peak
            _check_cancelled(cancelled)
            generated = Image.open(output_path).convert("RGB")
            if target_id == "background":
                background_path = directory / Path(project.backgroundUrl).name
                background = Image.open(background_path).convert("RGB")
                record_inpaint_history(project, directory, target_id)
                Image.composite(generated, background, alpha).save(background_path)
                result = project.model_copy(
                    update={"inpaintProvider": "powerpaint", "vramPeaksMb": metrics}
                )
                logger.info(
                    "AI target inpaint completed: project=%s target=background",
                    project.id,
                )
                return result

            target = known[target_id]
            cutout_path = directory / Path(target.cutoutUrl).name
            cutout = Image.open(cutout_path).convert("RGBA")
            updated_rgb = Image.composite(generated, cutout.convert("RGB"), alpha)
            updated_alpha = ImageChops.lighter(cutout.getchannel("A"), alpha)
            updated_cutout = updated_rgb.convert("RGBA")
            updated_cutout.putalpha(updated_alpha)
            record_inpaint_history(project, directory, target_id)
            updated_cutout.save(cutout_path)
            result = project.model_copy(update={"vramPeaksMb": metrics})
            logger.info(
                "AI target inpaint completed: project=%s target=%s",
                project.id,
                target_id,
            )
            return result
        finally:
            source_path.unlink(missing_ok=True)
            mask_path.unlink(missing_ok=True)
            output_path.unlink(missing_ok=True)


def build_union_mask(
    project: ProjectPayload, directory: Path, layer_ids: list[str]
) -> Image.Image:
    # Build masks only from known, confirmed layers and the optional extra mask.
    # A small dilation closes edge gaps before the inpainting model sees them.
    known = {layer.id: layer for layer in project.layers}
    if any(layer_id not in known for layer_id in layer_ids):
        logger.warning("union mask rejected: project=%s unknown layer", project.id)
        raise PipelineError("The inpaint request contains an unknown layer")
    unconfirmed = [
        known[layer_id].name for layer_id in layer_ids if not known[layer_id].confirmed
    ]
    if unconfirmed:
        logger.warning(
            "union mask rejected: project=%s unconfirmed=%s",
            project.id,
            len(unconfirmed),
        )
        raise PipelineError(
            f"Confirm every selected mask before inpainting: {', '.join(unconfirmed)}"
        )
    arrays = [
        np.asarray(
            Image.open(directory / Path(known[layer_id].maskUrl).name).convert("L"),
            dtype=np.uint8,
        )
        for layer_id in layer_ids
    ]
    if project.extraMaskUrl:
        arrays.append(
            np.asarray(
                Image.open(directory / Path(project.extraMaskUrl).name).convert("L"),
                dtype=np.uint8,
            )
        )
    union = np.maximum.reduce(arrays)
    binary = Image.fromarray((union > 8).astype(np.uint8) * 255)
    radius = max(3, round(min(project.width, project.height) * 0.008))
    kernel = radius * 2 + 1
    return binary.filter(ImageFilter.MaxFilter(kernel))


def build_inpaint_input(source: Image.Image, mask: Image.Image) -> Image.Image:
    rgb = np.asarray(source.convert("RGB"), dtype=np.uint8).copy()
    rgb[np.asarray(mask.convert("L"), dtype=np.uint8) > 0] = 0
    return Image.fromarray(rgb)


def create_sample_image() -> Image.Image:
    width, height = 1080, 680
    image = Image.new("RGB", (width, height), "#d8d2bd")
    pixels = np.asarray(image, dtype=np.uint8).copy()
    for y in range(height):
        blend = y / height
        pixels[y, :, 0] = np.clip(218 - blend * 38, 0, 255)
        pixels[y, :, 1] = np.clip(214 - blend * 45, 0, 255)
        pixels[y, :, 2] = np.clip(194 - blend * 34, 0, 255)
    image = Image.fromarray(pixels)
    draw = ImageDraw.Draw(image)
    draw.ellipse((90, 245, 410, 610), fill="#bc4f3c")
    draw.rounded_rectangle((655, 160, 980, 570), radius=42, fill="#264b56")
    draw.polygon(((410, 590), (575, 255), (735, 590)), fill="#d7a83e")
    draw.ellipse((468, 338, 655, 525), fill="#6f7f4d")
    draw.line((0, 615, width, 615), fill="#a7a188", width=8)
    return ImageEnhance.Contrast(image).enhance(1.04)
