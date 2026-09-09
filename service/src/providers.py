"""Named single-stage AI providers.

Every function here is a thin adapter over the exact implementation the
workflow pipeline already calls. Nothing in this module re-implements a stage:
the capability routes and the workflow routes must never be able to drift.
"""

from __future__ import annotations

import base64
import io
import logging

import numpy as np
from PIL import Image

from .ai_models import (
    DEFAULT_SEGMENTATION_DENSITY,
    SEGMENTATION_PROFILES,
    VRAM_BUDGET_MB,
    grounded_sam_instances,
    normalize_segmentation_density,
)
from .config import MODEL_ROOT, ai_dependencies, runtime_device
from .depth import depth_preview, estimate_near_map
from .pipeline import (
    PIPELINE_LOCK,
    PipelineError,
    _bounds,
    _guided_mask_refine,
    _lama_inpaint,
    _matte_mask,
    _release_inspyrenet,
)
from .refinement import generate_background_prompt, propose_object_vocabulary

logger = logging.getLogger(__name__)


def encode_png(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _mask_array(mask: Image.Image, expected: tuple[int, int]) -> np.ndarray:
    if mask.size != expected:
        raise PipelineError("The mask dimensions do not match the image")
    array = np.asarray(mask.convert("L"), dtype=np.uint8)
    if not np.count_nonzero(array > 8):
        raise PipelineError("The mask is empty")
    return array


# ---------------------------------------------------------------- inventory

# Each entry names the /api/health provider key that gates it, so capability
# readiness and startup readiness keep exactly one source of truth.
CAPABILITY_SPECS: tuple[dict, ...] = (
    {
        "id": "segmentation:detect",
        "provider": "segmentation",
        "model": "Grounding DINO-B + SAM 2.1 Small",
        "summary": "Propose foreground instances with masks, labels, and scores.",
        "endpoint": "/api/jobs/capabilities/segmentation:detect",
        "parameters": [
            {
                "name": "density",
                "type": "enum",
                "default": DEFAULT_SEGMENTATION_DENSITY,
                "options": sorted(SEGMENTATION_PROFILES),
            },
            {"name": "labels", "type": "string", "default": ""},
        ],
    },
    {
        "id": "depth:estimate",
        "provider": "depth",
        "model": "Depth Anything 3 Small",
        "summary": "Estimate a relative near-map for layer ordering.",
        "endpoint": "/api/jobs/capabilities/depth:estimate",
        "parameters": [],
    },
    {
        "id": "matting:refine",
        "provider": "matting",
        "model": "InSPyReNet base / mask-guided GrabCut",
        "summary": "Tighten a rough mask into a soft alpha matte.",
        "endpoint": "/api/jobs/capabilities/matting:refine",
        "parameters": [
            {
                "name": "kind",
                "type": "enum",
                "default": "instance",
                "options": ["instance", "manual"],
            }
        ],
    },
    {
        "id": "inpainting:fill",
        "provider": "inpainting",
        "model": "Big LaMa",
        "summary": "Structural fill of a masked region in one pass.",
        "endpoint": "/api/jobs/capabilities/inpainting:fill",
        "parameters": [],
    },
    {
        "id": "vlm:vocabulary",
        "provider": "prompting",
        "model": "Qwen3-VL 2B Instruct",
        "summary": "Propose an open-vocabulary detection label set for a scene.",
        "endpoint": "/api/jobs/capabilities/vlm:vocabulary",
        "parameters": [
            {
                "name": "density",
                "type": "enum",
                "default": DEFAULT_SEGMENTATION_DENSITY,
                "options": sorted(SEGMENTATION_PROFILES),
            }
        ],
    },
    {
        "id": "vlm:caption",
        "provider": "prompting",
        "model": "Qwen3-VL 2B Instruct",
        "summary": "Describe the unobstructed background for an inpainting prompt.",
        "endpoint": "/api/jobs/capabilities/vlm:caption",
        "parameters": [],
    },
    {
        "id": "inpainting:redraw",
        "provider": "refinement",
        "model": "PowerPaint v2.1",
        "summary": "Full diffusion redraw of a masked region.",
        # The standalone contract does not yet carry PowerPaint's project and
        # prompt controls. It remains reachable through workflow job routes.
        "endpoint": None,
        "parameters": [],
    },
)


def capability_inventory() -> list[dict]:
    dependencies = ai_dependencies()
    device = runtime_device()
    inventory: list[dict] = []
    for spec in CAPABILITY_SPECS:
        status = dependencies.get(spec["provider"])
        inventory.append(
            {
                **spec,
                "available": bool(status and status.available),
                "detail": status.detail if status else "Unknown provider",
                "vramBudgetMb": VRAM_BUDGET_MB,
                "modelRoot": str(MODEL_ROOT),
                "device": device,
            }
        )
    return inventory


def capability_ready(capability_id: str) -> tuple[bool, str]:
    for entry in capability_inventory():
        if entry["id"] == capability_id:
            return entry["available"], entry["detail"]
    return False, "Unknown capability"


# ---------------------------------------------------------------- providers
# The pipeline lock is held for the same reason the workflow holds it: model
# loads and GPU allocations stay serialized against the shared VRAM budget.


def detect_instances(
    image: Image.Image,
    density: str = DEFAULT_SEGMENTATION_DENSITY,
    labels: str = "",
) -> tuple[list[dict], dict[str, int]]:
    with PIPELINE_LOCK:
        instances, metrics = grounded_sam_instances(
            image, normalize_segmentation_density(density), labels or None
        )
    return (
        [
            {
                "label": instance.label,
                "score": round(float(instance.score), 3),
                "bounds": _bounds(instance.mask),
                "maskPng": encode_png(Image.fromarray(instance.mask)),
            }
            for instance in instances
        ],
        metrics,
    )


def estimate_depth(image: Image.Image) -> tuple[Image.Image, dict[str, int]]:
    with PIPELINE_LOCK:
        near_map, peak = estimate_near_map(image)
    return depth_preview(near_map), {"depthAnything3": peak}


def refine_matte(
    image: Image.Image,
    mask: Image.Image,
    kind: str = "instance",
) -> tuple[Image.Image, dict[str, int]]:
    array = _mask_array(mask, image.size)
    with PIPELINE_LOCK:
        if kind == "manual":
            return Image.fromarray(_guided_mask_refine(image, array)), {}
        try:
            return Image.fromarray(_matte_mask(image, array)), {}
        finally:
            _release_inspyrenet()


def fill_region(
    image: Image.Image,
    mask: Image.Image,
) -> tuple[Image.Image, dict[str, int]]:
    array = _mask_array(mask, image.size)
    binary = Image.fromarray(np.where(array > 8, 255, 0).astype(np.uint8))
    with PIPELINE_LOCK:
        generated, peak = _lama_inpaint(image, binary)
    # Composite so unmasked pixels come back untouched, matching what the
    # workflow inpaint stage commits to the background plate.
    return Image.composite(generated, image.convert("RGB"), binary), {"bigLama": peak}


def propose_vocabulary(
    image: Image.Image,
    density: str = DEFAULT_SEGMENTATION_DENSITY,
) -> tuple[list[str], dict[str, int]]:
    with PIPELINE_LOCK:
        labels, peak = propose_object_vocabulary(
            image, normalize_segmentation_density(density)
        )
    parsed = [label.strip() for label in labels.split(",") if label.strip()]
    return parsed, {"qwen3VlVocabulary": peak}


def caption_background(image: Image.Image) -> tuple[str, dict[str, int]]:
    with PIPELINE_LOCK:
        prompt, peak = generate_background_prompt(image)
    return prompt, {"qwen3Vl": peak}
