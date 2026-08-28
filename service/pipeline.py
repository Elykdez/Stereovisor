from __future__ import annotations

import gc
import hashlib
import math
import os
import threading
import time
import urllib.request
import warnings
from collections import deque
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

from .ai_models import InstanceMask, begin_vram_stage, grounded_sam_instances, peak_vram_mb, verify_vram_peak
from .config import DEVICE, MODEL_ROOT
from .depth import depth_for_mask, depth_preview, estimate_near_map, foreground_depth_plane
from .refinement import generate_background_prompt, powerpaint_inpaint
from .schemas import LayerPayload, ProjectPayload
from .storage import asset_url


PIPELINE_LOCK = threading.Lock()
LAMA_URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
LAMA_MD5 = "e3aa4aaa15225a33ec84f9f4bc47e500"
INSPYRENET_MODEL_URL = "https://github.com/plemeri/transparent-background/releases/download/1.2.12/ckpt_base.pth"
INSPYRENET_MODEL_MD5 = "d692e3dd5fa1b9658949d452bebf1cda"


class PipelineError(RuntimeError):
    pass


class MatteRejected(PipelineError):
    """A single segmentation proposal did not contain a usable InSPyReNet subject."""


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
    cutout_name = f"{layer_id}-cutout.png"
    alpha_image = Image.fromarray(alpha.astype(np.uint8))
    rgba = image.convert("RGBA")
    rgba.putalpha(alpha_image)
    alpha_image.save(directory / mask_name)
    rgba.save(directory / cutout_name)
    return LayerPayload(
        id=layer_id,
        name=name or f"Object {index + 1:02d}",
        cutoutUrl=asset_url(project_id, cutout_name),
        maskUrl=asset_url(project_id, mask_name),
        depth=depth if depth is not None else _initial_depth(alpha),
        order=index,
        bounds=_bounds(alpha),
        kind=kind,
        confidence=round(float(confidence), 3),
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

    def analyze(self, image: Image.Image, directory: Path, project_id: str) -> ProjectPayload:
        masks = _filter_masks(preview_masks(image), image.width, image.height)
        if not masks:
            raise PipelineError(
                "The preview engine found no distinct color regions. Install the local AI stack for arbitrary photographs."
            )
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

    def inpaint(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_ids: list[str],
        refinement: str = "lama",
        prompt: str | None = None,
    ) -> ProjectPayload:
        source = Image.open(directory / "source.png").convert("RGB")
        union = build_union_mask(project, directory, layer_ids)
        union.save(directory / "union-mask.png")
        radius = max(10, round(min(source.size) / 24))
        synthesized = source.filter(ImageFilter.GaussianBlur(radius=radius))
        background = Image.composite(synthesized, source, union)
        background.save(directory / "background.png")
        return project.model_copy(
            update={
                "backgroundUrl": asset_url(project.id, "background.png"),
                "unionMaskUrl": asset_url(project.id, "union-mask.png"),
                "inpaintProvider": "preview",
            }
        )


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
    padding = max(8, round(max(x1 - x0, y1 - y0) * 0.08))
    crop_box = (
        max(0, x0 - padding),
        max(0, y0 - padding),
        min(image.width, x1 + padding),
        min(image.height, y1 + padding),
    )
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
    proposal = Image.fromarray(mask).crop(crop_box).filter(ImageFilter.MaxFilter(5))
    combined = np.minimum(matte, np.asarray(proposal, dtype=np.uint8))
    if np.count_nonzero(combined > 12) < max(16, combined.size * 0.002):
        raise MatteRejected("InSPyReNet could not produce a usable alpha matte for a proposed object")
    full = np.zeros((image.height, image.width), dtype=np.uint8)
    left, top, right, bottom = crop_box
    full[top:bottom, left:right] = combined
    return full


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

    def analyze(self, image: Image.Image, directory: Path, project_id: str) -> ProjectPayload:
        with PIPELINE_LOCK:
            try:
                instances, metrics = grounded_sam_instances(image)
            except RuntimeError as error:
                raise PipelineError(str(error)) from error
            if not instances:
                raise PipelineError(
                    "Grounding DINO-T found no supported foreground objects. "
                    "Add labels with STEREOVISOR_OBJECT_LABELS and retry."
                )
            mattes: list[tuple[InstanceMask, np.ndarray]] = []
            try:
                try:
                    import torch
                    begin_vram_stage(torch)
                except ImportError:
                    torch = None
                for instance in instances:
                    try:
                        matte = _matte_mask(image, instance.mask)
                    except MatteRejected:
                        # SAM remains a valid instance mask when salient-object matting is too strict.
                        matte = instance.mask
                    mattes.append((instance, matte))
                if torch is not None:
                    metrics["inspyrenet"] = verify_vram_peak("InSPyReNet", peak_vram_mb(torch))
            finally:
                _release_inspyrenet()
            if not mattes:
                raise PipelineError("InSPyReNet found no usable foreground objects in this image")
            try:
                near_map, depth_peak = estimate_near_map(image)
            except RuntimeError as error:
                raise PipelineError(str(error)) from error
            metrics["depthAnything3"] = depth_peak

        depth_preview(near_map).save(directory / "depth-map.png")
        layer_inputs: list[tuple[str, float, np.ndarray, str, float]] = []
        for instance, matte in mattes:
            base_name = instance.label.strip().title() or "Object"
            layer_inputs.append(
                (base_name, depth_for_mask(near_map, matte), matte, "instance", instance.score)
            )
        depth_plane = foreground_depth_plane(near_map, [matte for _, matte in mattes])
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

    def inpaint(
        self,
        project: ProjectPayload,
        directory: Path,
        layer_ids: list[str],
        refinement: str = "lama",
        prompt: str | None = None,
    ) -> ProjectPayload:
        source = Image.open(directory / "source.png").convert("RGB")
        union = build_union_mask(project, directory, layer_ids)
        union.save(directory / "union-mask.png")
        metrics = dict(project.vramPeaksMb)
        with PIPELINE_LOCK:
            if refinement == "powerpaint":
                try:
                    background_prompt = (prompt or "").strip()
                    if not background_prompt:
                        background_prompt, qwen_peak = generate_background_prompt(source)
                        metrics["qwen3Vl"] = qwen_peak
                    powerpaint_peak = powerpaint_inpaint(
                        directory / "source.png",
                        directory / "union-mask.png",
                        directory / "background.png",
                        background_prompt,
                    )
                    metrics["powerpaint"] = powerpaint_peak
                except RuntimeError as error:
                    raise PipelineError(str(error)) from error
                provider = "powerpaint"
            else:
                background_prompt = None
                background, lama_peak = _lama_inpaint(source, union)
                background.save(directory / "background.png")
                metrics["bigLama"] = lama_peak
                provider = "big-lama"
        return project.model_copy(
            update={
                "backgroundUrl": asset_url(project.id, "background.png"),
                "unionMaskUrl": asset_url(project.id, "union-mask.png"),
                "backgroundPrompt": background_prompt,
                "inpaintProvider": provider,
                "vramPeaksMb": metrics,
            }
        )


def build_union_mask(project: ProjectPayload, directory: Path, layer_ids: list[str]) -> Image.Image:
    known = {layer.id: layer for layer in project.layers}
    if any(layer_id not in known for layer_id in layer_ids):
        raise PipelineError("The inpaint request contains an unknown layer")
    arrays = [
        np.asarray(Image.open(directory / Path(known[layer_id].maskUrl).name).convert("L"), dtype=np.uint8)
        for layer_id in layer_ids
    ]
    union = np.maximum.reduce(arrays)
    binary = Image.fromarray((union > 8).astype(np.uint8) * 255)
    radius = max(3, round(min(project.width, project.height) * 0.008))
    kernel = radius * 2 + 1
    return binary.filter(ImageFilter.MaxFilter(kernel))


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
