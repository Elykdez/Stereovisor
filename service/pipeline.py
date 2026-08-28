from __future__ import annotations

import gc
import hashlib
import math
import os
import shutil
import threading
import time
import urllib.request
import uuid
import warnings
from collections import deque
from pathlib import Path
from typing import Callable, Iterable

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

from .ai_models import InstanceMask, begin_vram_stage, grounded_sam_instances, peak_vram_mb, verify_vram_peak
from .config import DEVICE, MODEL_ROOT
from .depth import depth_for_mask, depth_preview, estimate_near_map, foreground_depth_plane
from .refinement import generate_background_prompt, powerpaint_inpaint
from .schemas import InpaintHistoryPayload, LayerPayload, ProjectPayload
from .storage import asset_url


PIPELINE_LOCK = threading.Lock()
INPAINT_HISTORY_LOCK = threading.Lock()
ProgressCallback = Callable[[int, str, str], None]
INPAINT_HISTORY_LIMIT = 20
LAMA_URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
LAMA_MD5 = "e3aa4aaa15225a33ec84f9f4bc47e500"
INSPYRENET_MODEL_URL = "https://github.com/plemeri/transparent-background/releases/download/1.2.12/ckpt_base.pth"
INSPYRENET_MODEL_MD5 = "d692e3dd5fa1b9658949d452bebf1cda"


class PipelineError(RuntimeError):
    pass


class MatteRejected(PipelineError):
    """A single segmentation proposal did not contain a usable InSPyReNet subject."""


def _report(progress: ProgressCallback | None, percent: int, stage: str, message: str) -> None:
    if progress is not None:
        progress(percent, stage, message)


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


def _inpaint_target_path(project: ProjectPayload, directory: Path, target_id: str) -> Path:
    if target_id == "background":
        if not project.backgroundUrl:
            raise PipelineError("Build the scene before restoring layer inpaint history")
        return directory / Path(project.backgroundUrl).name
    layer = next((candidate for candidate in project.layers if candidate.id == target_id), None)
    if layer is None:
        raise PipelineError("The layer inpaint history selected an unknown target")
    return directory / Path(layer.cutoutUrl).name


def _inpaint_history_stack(directory: Path, target_id: str, stack: str) -> Path:
    target_key = hashlib.sha256(target_id.encode("utf-8")).hexdigest()
    return directory / ".inpaint-history" / target_key / stack


def _history_entries(directory: Path, target_id: str, stack: str) -> list[Path]:
    stack_directory = _inpaint_history_stack(directory, target_id, stack)
    return sorted(stack_directory.glob("*.png")) if stack_directory.is_dir() else []


def _push_inpaint_history(project: ProjectPayload, directory: Path, target_id: str, stack: str) -> None:
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


def record_inpaint_history(project: ProjectPayload, directory: Path, target_id: str) -> None:
    with INPAINT_HISTORY_LOCK:
        _push_inpaint_history(project, directory, target_id, "undo")
        _clear_inpaint_history(directory, target_id, "redo")


def restore_inpaint_history(
    project: ProjectPayload,
    directory: Path,
    target_id: str,
    action: str,
) -> ProjectPayload:
    if action not in {"undo", "redo"}:
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
    return project


def inpaint_history(project: ProjectPayload, directory: Path) -> list[InpaintHistoryPayload]:
    target_ids = ["background", *(layer.id for layer in project.layers)]
    return [
        InpaintHistoryPayload(
            targetId=target_id,
            canUndo=bool(_history_entries(directory, target_id, "undo")),
            canRedo=bool(_history_entries(directory, target_id, "redo")),
        )
        for target_id in target_ids
    ]


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
) -> ProjectPayload:
    known = {layer.id: layer for layer in project.layers}
    if layer_id not in known:
        raise PipelineError("The mask editor selected an unknown layer")
    source = Image.open(directory / "source.png").convert("RGB")
    if mask.size != source.size:
        raise PipelineError("The edited mask dimensions do not match the source image")
    alpha = np.asarray(mask.convert("L"), dtype=np.uint8)
    binary = np.where(alpha > 8, 255, 0).astype(np.uint8)
    if not np.count_nonzero(binary):
        raise PipelineError("An object mask cannot be empty; disable the layer instead")

    layer = known[layer_id]
    mask_name = Path(layer.maskUrl).name
    cutout_name = Path(layer.cutoutUrl).name
    Image.fromarray(alpha).save(directory / mask_name)
    cutout = source.convert("RGBA")
    cutout.putalpha(Image.fromarray(alpha))
    cutout.save(directory / cutout_name)
    updated_layers = [
        candidate.model_copy(
            update={
                "bounds": _bounds(binary),
                "confirmed": False,
                "maskRevision": candidate.maskRevision + 1,
            }
        ) if candidate.id == layer_id else candidate
        for candidate in project.layers
    ]
    return _invalidate_background(project.model_copy(update={"layers": updated_layers}))


def confirm_layer_mask(project: ProjectPayload, layer_id: str) -> ProjectPayload:
    if layer_id not in {layer.id for layer in project.layers}:
        raise PipelineError("The mask review selected an unknown layer")
    return project.model_copy(
        update={
            "layers": [
                layer.model_copy(update={"confirmed": True}) if layer.id == layer_id else layer
                for layer in project.layers
            ]
        }
    )


def save_extra_inpaint_mask(
    project: ProjectPayload,
    directory: Path,
    mask: Image.Image,
) -> ProjectPayload:
    source = Image.open(directory / "source.png")
    if mask.size != source.size:
        raise PipelineError("The extra inpaint mask dimensions do not match the source image")
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
                    if 0 <= nx < width and 0 <= ny < height and binary[ny, nx] and not visited[ny, nx]:
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
    small_size = (max(1, round(working.width * scale)), max(1, round(working.height * scale)))
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


def _filter_masks(masks: Iterable[np.ndarray], width: int, height: int) -> list[np.ndarray]:
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
        progress: ProgressCallback | None = None,
    ) -> ProjectPayload:
        _report(progress, 12, "Segmenting objects", "Finding distinct foreground regions.")
        masks = _filter_masks(preview_masks(image), image.width, image.height)
        if not masks:
            raise PipelineError(
                "The preview engine found no distinct color regions. Install the local AI stack for arbitrary photographs."
            )
        _report(progress, 64, "Building layers", f"Creating {len(masks)} editable object layers.")
        layers = [_save_layer(image, mask, directory, project_id, index) for index, mask in enumerate(masks)]
        project = ProjectPayload(
            id=project_id,
            width=image.width,
            height=image.height,
            sourceUrl=asset_url(project_id, "source.png"),
            engine=self.engine,
            layers=layers,
        )
        return project

    def refine(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_id: str,
        progress: ProgressCallback | None = None,
    ) -> ProjectPayload:
        raise PipelineError("Mask refinement requires the Local AI engine and InSPyReNet")

    def inpaint(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_ids: list[str],
        refinement: str = "lama",
        prompt: str | None = None,
        progress: ProgressCallback | None = None,
    ) -> ProjectPayload:
        _report(progress, 12, "Joining masks", "Combining the selected foreground mattes.")
        source = Image.open(directory / "source.png").convert("RGB")
        union = build_union_mask(project, directory, layer_ids)
        union.save(directory / "union-mask.png")
        inpaint_input = build_inpaint_input(source, union)
        inpaint_input.save(directory / "inpaint-input.png")
        radius = max(10, round(min(source.size) / 24))
        _report(progress, 48, "Rebuilding background", "Synthesizing the hidden background plate.")
        unmasked = np.asarray(source)[np.asarray(union) == 0]
        fill = tuple(np.median(unmasked, axis=0).astype(np.uint8)) if len(unmasked) else (0, 0, 0)
        filled_input = Image.composite(Image.new("RGB", source.size, fill), inpaint_input, union)
        synthesized = filled_input.filter(ImageFilter.GaussianBlur(radius=radius))
        background = Image.composite(synthesized, source, union)
        background.save(directory / "background.png")
        return project.model_copy(
            update={
                "backgroundUrl": asset_url(project.id, "background.png"),
                "unionMaskUrl": asset_url(project.id, "union-mask.png"),
                "inpaintProvider": "preview",
            }
        )

    def inpaint_target(
        self,
        project: ProjectPayload,
        directory: Path,
        target_id: str,
        composition: Image.Image,
        mask: Image.Image,
        prompt: str | None = None,
        progress: ProgressCallback | None = None,
    ) -> ProjectPayload:
        raise PipelineError("Layer inpainting requires the Local AI engine and PowerPaint")


def _resolve_device(torch_module: object) -> str:
    cuda = getattr(torch_module, "cuda")
    if DEVICE == "cpu":
        return "cpu"
    if DEVICE == "cuda" and not cuda.is_available():
        raise PipelineError("CUDA was requested but the managed Torch runtime cannot access the GPU")
    return "cuda" if cuda.is_available() else "cpu"


def _release_cuda(torch_module: object) -> None:
    gc.collect()
    cuda = getattr(torch_module, "cuda")
    if cuda.is_available():
        cuda.empty_cache()


_inspyrenet_remover: object | None = None


def _download_with_resume(url: str, target: Path, expected_md5: str) -> None:
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
                with partial.open("ab" if offset else "wb") as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
            digest = hashlib.md5(partial.read_bytes()).hexdigest()
            if digest != expected_md5:
                raise PipelineError(f"Downloaded model failed its checksum: {target.name}")
            partial.replace(target)
            return
        except PipelineError:
            raise
        except Exception as error:
            last_error = error
            if attempt < 7:
                time.sleep(min(8, 2**attempt))
    raise PipelineError(f"Model download did not complete after retries: {target.name}") from last_error


def _ensure_inspyrenet_model() -> Path:
    model_directory = MODEL_ROOT / "inspyrenet"
    os.environ["TRANSPARENT_BACKGROUND_FILE_PATH"] = str(model_directory)
    model_path = model_directory / "ckpt_base.pth"
    if not model_path.is_file():
        _download_with_resume(INSPYRENET_MODEL_URL, model_path, INSPYRENET_MODEL_MD5)
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
    crop = image.crop(crop_box).convert("RGB")
    if _inspyrenet_remover is None:
        try:
            import torch
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message="Failed to import flet.*")
                from transparent_background import Remover
        except ImportError as error:
            raise PipelineError("InSPyReNet is unavailable. Run scripts/setup-ai.ps1.") from error
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
        raise MatteRejected("InSPyReNet could not produce a usable alpha matte for a proposed object")
    full = np.zeros((image.height, image.width), dtype=np.uint8)
    left, top, right, bottom = crop_box
    full[top:bottom, left:right] = matte
    return full


def _guided_mask_refine(image: Image.Image, mask: np.ndarray) -> np.ndarray:
    """Refine an arbitrary rough foreground mask without assuming it is one salient subject."""
    try:
        import cv2
    except ImportError as error:
        raise PipelineError("OpenCV is unavailable. Run scripts/setup-ai.ps1.") from error

    binary = (mask > 8).astype(np.uint8)
    if not np.count_nonzero(binary):
        raise PipelineError("The selected foreground mask is empty")
    radius = max(2, round(min(binary.shape) * 0.006))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))
    eroded = cv2.erode(binary, kernel, iterations=1)
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
        cv2.grabCut(rgb, trimap, None, background_model, foreground_model, 5, cv2.GC_INIT_WITH_MASK)
        refined = np.isin(trimap, (cv2.GC_FGD, cv2.GC_PR_FGD))
    except cv2.error:
        refined = binary > 0
    refined[eroded > 0] = True

    proposal_area = int(np.count_nonzero(binary))
    refined_area = int(np.count_nonzero(refined))
    overlap = int(np.count_nonzero(refined & (binary > 0)))
    if refined_area < proposal_area * 0.25 or overlap < proposal_area * 0.25:
        refined = binary > 0
    alpha = Image.fromarray(refined.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(radius=1.0))
    return np.asarray(alpha, dtype=np.uint8)


def _download_lama(target: Path) -> None:
    _download_with_resume(LAMA_URL, target, LAMA_MD5)


def _pad_to_modulo(array: np.ndarray, modulo: int) -> tuple[np.ndarray, tuple[int, int]]:
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
        raise PipelineError("Torch is unavailable. Run scripts/setup-ai.ps1.") from error

    model_path = MODEL_ROOT / "big-lama.pt"
    if not model_path.is_file():
        _download_lama(model_path)
    device = _resolve_device(torch)
    begin_vram_stage(torch)
    model = torch.jit.load(str(model_path), map_location=device).eval()
    rgb, original_size = _pad_to_modulo(np.asarray(image.convert("RGB"), dtype=np.float32), 8)
    binary, _ = _pad_to_modulo(np.asarray(mask.convert("L"), dtype=np.float32), 8)
    image_tensor = torch.from_numpy(rgb.transpose(2, 0, 1) / 255.0).unsqueeze(0).to(device)
    mask_tensor = torch.from_numpy((binary > 0).astype(np.float32)).unsqueeze(0).unsqueeze(0).to(device)
    try:
        with torch.inference_mode():
            output = model(image_tensor, mask_tensor)
        if isinstance(output, dict):
            output = output.get("inpainted", output.get("output"))
        result = output[0].permute(1, 2, 0).detach().float().cpu().numpy()
        height, width = original_size
        result = np.clip(result[:height, :width] * 255.0, 0, 255).astype(np.uint8)
        return Image.fromarray(result), verify_vram_peak("Big LaMa", peak_vram_mb(torch))
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
        progress: ProgressCallback | None = None,
    ) -> ProjectPayload:
        with PIPELINE_LOCK:
            _report(progress, 8, "Segmenting objects", "Grounding DINO-T and SAM 2.1 are finding individual objects.")
            try:
                instances, metrics = grounded_sam_instances(image)
            except RuntimeError as error:
                raise PipelineError(str(error)) from error
            if not instances:
                raise PipelineError(
                    "Grounding DINO-T found no supported foreground objects. "
                    "Add labels with STEREOVISOR_OBJECT_LABELS and retry."
                )
            _report(progress, 48, "Estimating depth", "Depth Anything 3 is mapping near and distant regions.")
            try:
                near_map, depth_peak = estimate_near_map(image)
            except RuntimeError as error:
                raise PipelineError(str(error)) from error
            metrics["depthAnything3"] = depth_peak

        _report(progress, 79, "Building layers", "Preparing depth ordering and transparent cutouts.")
        depth_preview(near_map).save(directory / "depth-map.png")
        layer_inputs: list[tuple[str, float, np.ndarray, str, float]] = []
        for instance in instances:
            base_name = instance.label.strip().title() or "Object"
            layer_inputs.append(
                (base_name, depth_for_mask(near_map, instance.mask), instance.mask, "instance", instance.score)
            )
        depth_plane = foreground_depth_plane(near_map, [instance.mask for instance in instances])
        if depth_plane is not None:
            layer_inputs.append(
                ("Foreground depth plane", depth_for_mask(near_map, depth_plane), depth_plane, "depth-plane", 1.0)
            )
        layer_inputs.sort(key=lambda item: item[1])
        label_totals: dict[str, int] = {}
        for name, _, _, kind, _ in layer_inputs:
            if kind == "instance":
                label_totals[name] = label_totals.get(name, 0) + 1
        label_indices: dict[str, int] = {}
        layers: list[LayerPayload] = []
        for index, (name, depth, alpha, kind, confidence) in enumerate(layer_inputs):
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
            layers.append(_save_layer(
                image,
                alpha,
                directory,
                project_id,
                index,
                name=display_name,
                depth=depth,
                kind=kind,
                confidence=confidence,
            ))
        return ProjectPayload(
            id=project_id,
            width=image.width,
            height=image.height,
            sourceUrl=asset_url(project_id, "source.png"),
            depthMapUrl=asset_url(project_id, "depth-map.png"),
            engine=self.engine,
            layers=layers,
            vramPeaksMb=metrics,
        )

    def refine(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_id: str,
        progress: ProgressCallback | None = None,
    ) -> ProjectPayload:
        known = {layer.id: layer for layer in project.layers}
        layer = known.get(layer_id)
        if layer is None:
            raise PipelineError("The refine request selected an unknown layer")

        source = Image.open(directory / "source.png").convert("RGB")
        mask = np.asarray(Image.open(directory / Path(layer.maskUrl).name).convert("L"), dtype=np.uint8)
        _report(progress, 12, "Preparing refinement", f"Cropping the original image around {layer.name}.")
        metrics = dict(project.vramPeaksMb)
        with PIPELINE_LOCK:
            if layer.kind == "instance":
                try:
                    try:
                        import torch
                        begin_vram_stage(torch)
                    except ImportError:
                        torch = None
                    _report(progress, 36, "Refining mask", "InSPyReNet is removing the local background and resolving soft edges.")
                    matte = _matte_mask(source, mask)
                    if torch is not None:
                        metrics["inspyrenet"] = verify_vram_peak("InSPyReNet", peak_vram_mb(torch))
                finally:
                    _release_inspyrenet()
            else:
                _report(progress, 36, "Refining mask", "Local mask-guided segmentation is aligning this foreground layer to image edges.")
                matte = _guided_mask_refine(source, mask)

        _report(progress, 84, "Saving refined mask", "Updating this layer's alpha and foreground cutout.")
        updated = replace_layer_mask(project, directory, layer_id, Image.fromarray(matte))
        refined_layers = [
            candidate.model_copy(update={"refinementState": "refined"})
            if candidate.id == layer_id else candidate
            for candidate in updated.layers
        ]
        return updated.model_copy(update={"layers": refined_layers, "vramPeaksMb": metrics})

    def inpaint(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_ids: list[str],
        refinement: str = "lama",
        prompt: str | None = None,
        progress: ProgressCallback | None = None,
    ) -> ProjectPayload:
        _report(progress, 10, "Joining masks", "Combining selected objects into the inpainting mask.")
        source = Image.open(directory / "source.png").convert("RGB")
        union = build_union_mask(project, directory, layer_ids)
        union.save(directory / "union-mask.png")
        inpaint_input = build_inpaint_input(source, union)
        inpaint_input_path = directory / "inpaint-input.png"
        inpaint_input.save(inpaint_input_path)
        metrics = dict(project.vramPeaksMb)
        with PIPELINE_LOCK:
            if refinement == "powerpaint":
                try:
                    background_prompt = (prompt or "").strip()
                    if not background_prompt:
                        _report(progress, 24, "Describing background", "Qwen3-VL is creating a local background prompt.")
                        background_prompt, qwen_peak = generate_background_prompt(source)
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
                        progress=lambda step, total: _report(
                            progress,
                            42 + round(step * 50 / max(1, total)),
                            "Redrawing background",
                            f"PowerPaint denoising step {step} of {total}.",
                        ),
                    )
                    metrics["powerpaint"] = powerpaint_peak
                except RuntimeError as error:
                    raise PipelineError(str(error)) from error
                provider = "powerpaint"
            else:
                background_prompt = None
                _report(progress, 34, "Rebuilding background", "Big LaMa is filling the masked structure.")
                generated, lama_peak = _lama_inpaint(inpaint_input, union)
                background = Image.composite(generated, source, union)
                background.save(directory / "background.png")
                metrics["bigLama"] = lama_peak
                provider = "big-lama"
        _report(progress, 94, "Finalizing plate", "Saving the rebuilt background and scene metadata.")
        return project.model_copy(
            update={
                "backgroundUrl": asset_url(project.id, "background.png"),
                "unionMaskUrl": asset_url(project.id, "union-mask.png"),
                "backgroundPrompt": background_prompt,
                "inpaintProvider": provider,
                "vramPeaksMb": metrics,
            }
        )

    def inpaint_target(
        self,
        project: ProjectPayload,
        directory: Path,
        target_id: str,
        composition: Image.Image,
        mask: Image.Image,
        prompt: str | None = None,
        progress: ProgressCallback | None = None,
    ) -> ProjectPayload:
        if not project.backgroundUrl:
            raise PipelineError("Build the scene before inpainting an individual layer")
        known = {layer.id: layer for layer in project.layers}
        if target_id != "background" and target_id not in known:
            raise PipelineError("The layer inpaint request selected an unknown target")
        expected_size = (project.width, project.height)
        if composition.size != expected_size or mask.size != expected_size:
            raise PipelineError("The composition and inpaint mask must match the project dimensions")
        alpha = mask.convert("L")
        if not np.count_nonzero(np.asarray(alpha, dtype=np.uint8) > 0):
            raise PipelineError("Paint an inpaint area before running PowerPaint")

        source_path = directory / ".layer-inpaint-composition.png"
        mask_path = directory / ".layer-inpaint-mask.png"
        output_path = directory / ".layer-inpaint-result.png"
        composition.convert("RGB").save(source_path)
        alpha.save(mask_path)
        target_name = "Background" if target_id == "background" else known[target_id].name
        resolved_prompt = (prompt or "").strip() or "seamless continuation of the surrounding composition"
        metrics = dict(project.vramPeaksMb)
        try:
            _report(progress, 18, "Preparing layer inpaint", f"Using the full composition as context for {target_name}.")
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
                        progress=lambda step, total: _report(
                            progress,
                            42 + round(step * 50 / max(1, total)),
                            "Inpainting layer",
                            f"PowerPaint full-redraw step {step} of {total} for {target_name}.",
                        ),
                    )
                except RuntimeError as error:
                    raise PipelineError(str(error)) from error
            metrics["powerpaint"] = peak
            generated = Image.open(output_path).convert("RGB")
            if target_id == "background":
                background_path = directory / Path(project.backgroundUrl).name
                background = Image.open(background_path).convert("RGB")
                record_inpaint_history(project, directory, target_id)
                Image.composite(generated, background, alpha).save(background_path)
                return project.model_copy(
                    update={"inpaintProvider": "powerpaint", "vramPeaksMb": metrics}
                )

            target = known[target_id]
            cutout_path = directory / Path(target.cutoutUrl).name
            cutout = Image.open(cutout_path).convert("RGBA")
            updated_rgb = Image.composite(generated, cutout.convert("RGB"), alpha)
            updated_alpha = ImageChops.lighter(cutout.getchannel("A"), alpha)
            updated_cutout = updated_rgb.convert("RGBA")
            updated_cutout.putalpha(updated_alpha)
            record_inpaint_history(project, directory, target_id)
            updated_cutout.save(cutout_path)
            return project.model_copy(update={"vramPeaksMb": metrics})
        finally:
            source_path.unlink(missing_ok=True)
            mask_path.unlink(missing_ok=True)
            output_path.unlink(missing_ok=True)


def build_union_mask(project: ProjectPayload, directory: Path, layer_ids: list[str]) -> Image.Image:
    known = {layer.id: layer for layer in project.layers}
    if any(layer_id not in known for layer_id in layer_ids):
        raise PipelineError("The inpaint request contains an unknown layer")
    unconfirmed = [known[layer_id].name for layer_id in layer_ids if not known[layer_id].confirmed]
    if unconfirmed:
        raise PipelineError(f"Confirm every selected mask before inpainting: {', '.join(unconfirmed)}")
    arrays = [
        np.asarray(Image.open(directory / Path(known[layer_id].maskUrl).name).convert("L"), dtype=np.uint8)
        for layer_id in layer_ids
    ]
    if project.extraMaskUrl:
        arrays.append(
            np.asarray(Image.open(directory / Path(project.extraMaskUrl).name).convert("L"), dtype=np.uint8)
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
