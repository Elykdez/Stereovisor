from __future__ import annotations

import gc
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from .config import DEVICE, MODEL_ROOT


GROUNDING_DINO_ID = "IDEA-Research/grounding-dino-tiny"
SAM2_ID = "facebook/sam2.1-hiera-small"
DA3_ID = "depth-anything/DA3-SMALL"
QWEN_ID = "Qwen/Qwen3-VL-2B-Instruct"

GROUNDING_DINO_PATH = MODEL_ROOT / "grounding-dino-tiny"
SAM2_PATH = MODEL_ROOT / "sam2.1-hiera-small"
DA3_PATH = MODEL_ROOT / "da3-small"
QWEN_PATH = MODEL_ROOT / "qwen3-vl-2b-instruct"
POWERPAINT_PATH = MODEL_ROOT / "powerpaint-v2-1"

CUSTOM_OBJECT_LABELS = os.environ.get("STEREOVISOR_OBJECT_LABELS", "").strip()
DEFAULT_OBJECT_LABELS = tuple(
    label.strip()
    for label in (CUSTOM_OBJECT_LABELS or "person").split(",")
    if label.strip()
)
FALLBACK_OBJECT_LABELS = ("animal", "character", "vehicle", "furniture", "plant", "foreground object")
MAX_INSTANCE_LAYERS = 24
VRAM_BUDGET_MB = 8192


@dataclass(frozen=True)
class InstanceMask:
    label: str
    score: float
    mask: np.ndarray


def resolve_device(torch_module: object) -> str:
    cuda = getattr(torch_module, "cuda")
    if DEVICE == "cpu":
        return "cpu"
    if DEVICE == "cuda" and not cuda.is_available():
        raise RuntimeError("CUDA was requested but the managed Torch runtime cannot access the GPU")
    return "cuda" if cuda.is_available() else "cpu"


def release_cuda(torch_module: object) -> None:
    gc.collect()
    cuda = getattr(torch_module, "cuda")
    if cuda.is_available():
        cuda.empty_cache()


def begin_vram_stage(torch_module: object) -> None:
    cuda = getattr(torch_module, "cuda")
    if cuda.is_available():
        cuda.reset_peak_memory_stats()


def peak_vram_mb(torch_module: object) -> int:
    cuda = getattr(torch_module, "cuda")
    if not cuda.is_available():
        return 0
    return round(cuda.max_memory_allocated() / (1024 * 1024))


def verify_vram_peak(stage: str, peak_mb: int) -> int:
    if peak_mb > VRAM_BUDGET_MB:
        raise RuntimeError(f"{stage} exceeded the {VRAM_BUDGET_MB} MB VRAM budget ({peak_mb} MB)")
    return peak_mb


def _require_model(path: Path, label: str) -> None:
    if not path.is_dir():
        raise RuntimeError(f"{label} weights are missing. Run scripts/ensure-ready.ps1.")


def _box_iou(a: np.ndarray, b: np.ndarray) -> float:
    left = max(float(a[0]), float(b[0]))
    top = max(float(a[1]), float(b[1]))
    right = min(float(a[2]), float(b[2]))
    bottom = min(float(a[3]), float(b[3]))
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    area_a = max(0.0, float(a[2] - a[0])) * max(0.0, float(a[3] - a[1]))
    area_b = max(0.0, float(b[2] - b[0])) * max(0.0, float(b[3] - b[1]))
    union = area_a + area_b - intersection
    return intersection / union if union else 0.0


def _mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    intersection = np.count_nonzero((a > 0) & (b > 0))
    union = np.count_nonzero((a > 0) | (b > 0))
    return intersection / union if union else 0.0


def _deduplicate_detections(
    boxes: np.ndarray,
    scores: np.ndarray,
    labels: list[str],
    width: int,
    height: int,
) -> tuple[list[np.ndarray], list[float], list[str]]:
    image_area = width * height
    ranked = sorted(range(len(boxes)), key=lambda index: float(scores[index]), reverse=True)
    accepted_boxes: list[np.ndarray] = []
    accepted_scores: list[float] = []
    accepted_labels: list[str] = []
    for index in ranked:
        box = boxes[index].astype(np.float32)
        box[0::2] = np.clip(box[0::2], 0, width)
        box[1::2] = np.clip(box[1::2], 0, height)
        area = max(0.0, float(box[2] - box[0])) * max(0.0, float(box[3] - box[1]))
        if area < image_area * 0.001 or area > image_area * 0.92:
            continue
        if any(_box_iou(box, existing) >= 0.84 for existing in accepted_boxes):
            continue
        accepted_boxes.append(box)
        accepted_scores.append(float(scores[index]))
        accepted_labels.append(str(labels[index]).strip().lower() or "object")
        if len(accepted_boxes) == MAX_INSTANCE_LAYERS:
            break
    return accepted_boxes, accepted_scores, accepted_labels


def grounded_sam_instances(image: Image.Image) -> tuple[list[InstanceMask], dict[str, int]]:
    try:
        import torch
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model, Sam2Processor
    except ImportError as error:
        raise RuntimeError("Grounding DINO and SAM 2.1 are unavailable. Run scripts/setup-ai.ps1.") from error

    _require_model(GROUNDING_DINO_PATH, "Grounding DINO-T")
    _require_model(SAM2_PATH, "SAM 2.1 Small")
    device = resolve_device(torch)
    metrics: dict[str, int] = {}

    detector = None
    detector_processor = None
    inputs = None
    outputs = None
    try:
        begin_vram_stage(torch)
        detector_processor = AutoProcessor.from_pretrained(GROUNDING_DINO_PATH, local_files_only=True)
        detector = AutoModelForZeroShotObjectDetection.from_pretrained(
            GROUNDING_DINO_PATH,
            local_files_only=True,
            dtype=torch.float16 if device == "cuda" else torch.float32,
        ).to(device)
        def detect(label_set: tuple[str, ...]) -> tuple[list[np.ndarray], list[float], list[str]]:
            nonlocal inputs, outputs
            inputs = detector_processor(
                images=image.convert("RGB"),
                text=[list(label_set)],
                return_tensors="pt",
            ).to(device)
            with torch.inference_mode(), torch.autocast(
                device_type=device,
                dtype=torch.float16,
                enabled=device == "cuda",
            ):
                outputs = detector(**inputs)
            result = detector_processor.post_process_grounded_object_detection(
                outputs,
                inputs.input_ids,
                threshold=0.198,
                text_threshold=0.15,
                target_sizes=[image.size[::-1]],
                text_labels=[list(label_set)],
            )[0]
            raw_labels = result["text_labels"] if "text_labels" in result else result["labels"]
            return _deduplicate_detections(
                result["boxes"].detach().float().cpu().numpy(),
                result["scores"].detach().float().cpu().numpy(),
                [str(label) for label in raw_labels],
                image.width,
                image.height,
            )

        boxes, scores, labels = detect(DEFAULT_OBJECT_LABELS)
        if not boxes and not CUSTOM_OBJECT_LABELS:
            boxes, scores, labels = detect(FALLBACK_OBJECT_LABELS)
        metrics["groundingDino"] = verify_vram_peak("Grounding DINO-T", peak_vram_mb(torch))
    finally:
        del outputs, inputs, detector, detector_processor
        release_cuda(torch)

    if not boxes:
        return [], metrics

    segmenter = None
    segmenter_processor = None
    sam_inputs = None
    sam_outputs = None
    try:
        begin_vram_stage(torch)
        segmenter_processor = Sam2Processor.from_pretrained(SAM2_PATH, local_files_only=True)
        segmenter = Sam2Model.from_pretrained(SAM2_PATH, local_files_only=True).to(device).eval()
        sam_inputs = segmenter_processor(
            images=image.convert("RGB"),
            input_boxes=[[box.tolist() for box in boxes]],
            return_tensors="pt",
        ).to(device)
        autocast_dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float16
        with torch.inference_mode(), torch.autocast(
            device_type=device,
            dtype=autocast_dtype,
            enabled=device == "cuda",
        ):
            sam_outputs = segmenter(**sam_inputs, multimask_output=False)
        masks = segmenter_processor.post_process_masks(
            sam_outputs.pred_masks.detach().cpu(),
            sam_inputs["original_sizes"].detach().cpu(),
            binarize=True,
            apply_non_overlapping_constraints=False,
        )[0]
        masks_np = masks[:, 0].numpy()
        instances: list[InstanceMask] = []
        for label, score, raw_mask in zip(labels, scores, masks_np):
            mask = (raw_mask > 0).astype(np.uint8) * 255
            if np.count_nonzero(mask) < max(20, int(image.width * image.height * 0.001)):
                continue
            if any(_mask_iou(mask, existing.mask) >= 0.65 for existing in instances):
                continue
            instances.append(InstanceMask(label=label, score=score, mask=mask))
        metrics["sam2"] = verify_vram_peak("SAM 2.1 Small", peak_vram_mb(torch))
        return instances, metrics
    finally:
        del sam_outputs, sam_inputs, segmenter, segmenter_processor
        release_cuda(torch)
