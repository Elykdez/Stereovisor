from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter

from .ai_models import DA3_PATH, begin_vram_stage, peak_vram_mb, release_cuda, resolve_device, verify_vram_peak


def _resize_array(array: np.ndarray, size: tuple[int, int], resample: Image.Resampling) -> np.ndarray:
    image = Image.fromarray(array.astype(np.float32))
    return np.asarray(image.resize(size, resample), dtype=np.float32)


def normalize_depth(depth: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    squeezed = np.asarray(depth, dtype=np.float32).squeeze()
    if squeezed.ndim != 2:
        raise RuntimeError(f"Depth Anything 3 returned an unexpected depth shape: {squeezed.shape}")
    if squeezed.shape != (size[1], size[0]):
        squeezed = _resize_array(squeezed, size, Image.Resampling.BILINEAR)
    finite = np.isfinite(squeezed)
    if not finite.any():
        raise RuntimeError("Depth Anything 3 returned no finite depth values")
    low, high = np.percentile(squeezed[finite], (2.0, 98.0))
    if high - low < 1e-6:
        return np.full(squeezed.shape, 0.5, dtype=np.float32)
    normalized = np.clip((squeezed - low) / (high - low), 0.0, 1.0)
    # DA3 monocular depth grows with distance; the renderer uses 1.0 for nearest.
    return (1.0 - normalized).astype(np.float32)


def estimate_near_map(image: Image.Image) -> tuple[np.ndarray, int]:
    if not DA3_PATH.is_dir():
        raise RuntimeError("Depth Anything 3 weights are missing. Run scripts/ensure-ready.ps1.")
    try:
        import torch
        from depth_anything_3.api import DepthAnything3
    except ImportError as error:
        raise RuntimeError("Depth Anything 3 is unavailable. Run scripts/setup-ai.ps1.") from error

    device = resolve_device(torch)
    model = None
    prediction = None
    try:
        begin_vram_stage(torch)
        model = DepthAnything3.from_pretrained(str(DA3_PATH), local_files_only=True).to(device).eval()
        with torch.inference_mode():
            prediction = model.inference([image.convert("RGB")], process_res=504)
        near = normalize_depth(prediction.depth, image.size)
        return near, verify_vram_peak("Depth Anything 3", peak_vram_mb(torch))
    finally:
        del prediction, model
        release_cuda(torch)


def depth_for_mask(near_map: np.ndarray, mask: np.ndarray) -> float:
    values = near_map[mask > 8]
    if not values.size:
        return 0.5
    return round(float(np.clip(np.median(values), 0.05, 1.0)), 3)


def depth_preview(near_map: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(near_map * 255.0, 0, 255).astype(np.uint8))


def _largest_components(binary: np.ndarray, minimum_area: int, maximum_area: int) -> np.ndarray:
    try:
        import cv2
    except ImportError as error:
        raise RuntimeError("OpenCV is unavailable. Run scripts/setup-ai.ps1.") from error

    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary.astype(np.uint8), connectivity=8)
    candidates: list[tuple[int, int]] = []
    for label in range(1, count):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if minimum_area <= area <= maximum_area:
            candidates.append((area, label))
    candidates.sort(reverse=True)
    selected = np.zeros(binary.shape, dtype=np.uint8)
    for _, label in candidates[:4]:
        selected[labels == label] = 255
    return selected


def foreground_depth_plane(near_map: np.ndarray, instance_masks: list[np.ndarray]) -> np.ndarray | None:
    height, width = near_map.shape
    image_area = height * width
    union = np.zeros((height, width), dtype=np.uint8)
    for mask in instance_masks:
        union = np.maximum(union, (mask > 8).astype(np.uint8) * 255)

    # Dense group portraits already have semantic layers; an extra plane would duplicate them.
    if np.count_nonzero(union) / image_area >= 0.45:
        return None

    exclusion = Image.fromarray(union).filter(ImageFilter.MaxFilter(15))
    available = np.asarray(exclusion, dtype=np.uint8) < 8
    values = near_map[available]
    if values.size < image_area * 0.08:
        return None

    threshold = max(0.58, float(np.quantile(values, 0.82)))
    candidate = (available & (near_map >= threshold)).astype(np.uint8)
    try:
        import cv2
    except ImportError as error:
        raise RuntimeError("OpenCV is unavailable. Run scripts/setup-ai.ps1.") from error
    kernel = np.ones((7, 7), dtype=np.uint8)
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, kernel)
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_OPEN, np.ones((3, 3), dtype=np.uint8))
    plane = _largest_components(
        candidate,
        minimum_area=max(64, int(image_area * 0.008)),
        maximum_area=int(image_area * 0.50),
    )
    if np.count_nonzero(plane) < image_area * 0.008:
        return None
    return np.asarray(
        Image.fromarray(plane).filter(ImageFilter.GaussianBlur(radius=1.2)),
        dtype=np.uint8,
    )
