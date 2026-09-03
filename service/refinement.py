from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Callable

from PIL import Image

from .ai_models import (
    POWERPAINT_PATH,
    QWEN_PATH,
    begin_vram_stage,
    normalize_segmentation_labels,
    peak_vram_mb,
    release_cuda,
    resolve_device,
    verify_vram_peak,
)
from .config import POWERPAINT_PYTHON, POWERPAINT_VENDOR, WORKSPACE_ROOT, powerpaint_snapshot_ready, snapshot_ready


logger = logging.getLogger(__name__)


def _run_qwen(image: Image.Image, instruction: str, max_new_tokens: int, stage: str) -> tuple[str, int]:
    # Qwen is a single-purpose stage. The caller receives CPU text and the
    # model is released before any detector or inpainter is allowed to load.
    if not snapshot_ready(QWEN_PATH, ("model.safetensors",)):
        raise RuntimeError("Qwen3-VL weights are missing. Run scripts/ensure-ready.ps1.")
    try:
        import torch
        from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
    except ImportError as error:
        raise RuntimeError("Qwen3-VL is unavailable. Run scripts/setup-ai.ps1.") from error

    device = resolve_device(torch)
    logger.info("%s started: size=%sx%s device=%s", stage, image.width, image.height, device)
    model = None
    processor = None
    inputs = None
    generated = None
    try:
        begin_vram_stage(torch)
        processor = AutoProcessor.from_pretrained(QWEN_PATH, local_files_only=True)
        model = Qwen3VLForConditionalGeneration.from_pretrained(
            QWEN_PATH,
            local_files_only=True,
            dtype=torch.float16 if device == "cuda" else torch.float32,
            low_cpu_mem_usage=True,
        ).to(device).eval()
        messages = [{
            "role": "user",
            "content": [
                {"type": "image", "image": image.convert("RGB")},
                {
                    "type": "text",
                    "text": instruction,
                },
            ],
        }]
        inputs = processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(device)
        with torch.inference_mode():
            generated = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
        trimmed = [output[len(source):] for source, output in zip(inputs.input_ids, generated)]
        prompt = processor.batch_decode(trimmed, skip_special_tokens=True)[0].strip()
        if not prompt:
            raise RuntimeError(f"{stage} returned empty text")
        peak = verify_vram_peak("Qwen3-VL", peak_vram_mb(torch))
        logger.info("%s completed: length=%s peak_mb=%s", stage, len(prompt[:500]), peak)
        return prompt[:500], peak
    finally:
        del generated, inputs, processor, model
        release_cuda(torch)


def generate_background_prompt(image: Image.Image) -> tuple[str, int]:
    # Captioning is local-only and optional: callers may supply a prompt when
    # Qwen3-VL is unavailable, but never silently download or call a service.
    prompt, peak = _run_qwen(
        image,
        (
            "Describe only the unobstructed background, materials, lighting, and perspective "
            "for an image inpainting model. Do not mention people, characters, text, logos, "
            "foreground objects, or the act of removal. Return one concise English prompt."
        ),
        max_new_tokens=96,
        stage="background prompt generation",
    )
    return prompt, peak


def _parse_object_vocabulary(raw: str) -> tuple[str, ...]:
    cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.IGNORECASE | re.DOTALL).strip()
    cleaned = cleaned.replace("```json", "").replace("```", "").strip()
    cleaned = re.sub(r"(?m)^\s*(?:[-*]|\d+[.)])\s*", "", cleaned)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        cleaned = ",".join(str(item) for item in parsed)
    elif isinstance(parsed, dict):
        values = parsed.get("objects") or parsed.get("labels") or parsed.get("vocabulary")
        if isinstance(values, list):
            cleaned = ",".join(str(item) for item in values)
    lines = cleaned.splitlines()
    first_line = lines[0] if lines else ""
    if ":" in first_line:
        prefix, remainder = first_line.split(":", 1)
        if prefix.strip().lower() in {"objects", "labels", "vocabulary", "object vocabulary"}:
            cleaned = ",".join([remainder, *lines[1:]])
    return normalize_segmentation_labels(cleaned)


def propose_object_vocabulary(image: Image.Image, density: str = "balanced") -> tuple[str, int]:
    raw, peak = _run_qwen(
        image,
        (
            "List the visible foreground objects that are useful as open-vocabulary detection labels "
            f"for a {density} image segmentation pass. Return only a comma-separated list of 5 to 24 "
            "short English nouns or noun phrases. Include distinct small salient objects, but exclude "
            "background regions, lighting, shadows, textures, abstract concepts, body parts, text, and logos."
        ),
        max_new_tokens=64,
        stage="object vocabulary proposal",
    )
    labels = _parse_object_vocabulary(raw)
    if not labels:
        logger.warning("object vocabulary proposal returned no usable labels")
        return "", peak
    return ", ".join(labels), peak


def powerpaint_inpaint(
    image_path: Path,
    mask_path: Path,
    output_path: Path,
    prompt: str,
    progress: Callable[[int, int], None] | None = None,
    cancelled: Callable[[], None] | None = None,
    steps: int = 25,
) -> int:
    # PowerPaint runs in its pinned Python environment. The sidecar JSON is the
    # only progress channel; the runner log remains temporary diagnostic data.
    logger.info("PowerPaint preflight: steps=%s output=%s", steps, output_path.name)
    runner = WORKSPACE_ROOT / "scripts" / "powerpaint-runner.py"
    if not POWERPAINT_PYTHON.is_file() or not POWERPAINT_VENDOR.is_dir() or not powerpaint_snapshot_ready(POWERPAINT_PATH):
        raise RuntimeError("PowerPaint v2.1 is not installed. Run scripts/ensure-ready.ps1.")
    environment = os.environ.copy()
    environment.update({
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DIFFUSERS_OFFLINE": "1",
        "PYTORCH_ALLOC_CONF": "expandable_segments:True",
    })
    progress_path = output_path.with_name(".powerpaint-progress.json")
    log_path = output_path.with_name(".powerpaint-runner.log")
    progress_path.unlink(missing_ok=True)
    log_path.unlink(missing_ok=True)
    command = [
        str(POWERPAINT_PYTHON),
        str(runner),
        "--image", str(image_path),
        "--mask", str(mask_path),
        "--output", str(output_path),
        "--prompt", prompt,
        "--steps", str(max(5, min(100, int(steps)))),
        "--checkpoint", str(POWERPAINT_PATH),
        "--vendor", str(POWERPAINT_VENDOR),
        "--progress", str(progress_path),
    ]
    process: subprocess.Popen[str] | None = None
    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            process = subprocess.Popen(
                command,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=environment,
            )
            logger.info("PowerPaint process started: pid=%s", process.pid)
            deadline = time.monotonic() + 900
            reported_step = 0
            while process.poll() is None:
                if cancelled is not None:
                    cancelled()
                if time.monotonic() >= deadline:
                    process.kill()
                    process.wait()
                    raise RuntimeError("PowerPaint timed out after 15 minutes")
                if progress is not None and progress_path.is_file():
                    try:
                        report = json.loads(progress_path.read_text(encoding="utf-8"))
                        step = int(report["step"])
                        total = int(report["total"])
                        if step > reported_step:
                            progress(step, total)
                            reported_step = step
                    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
                        pass
                time.sleep(0.2)
            return_code = process.returncode

        output = log_path.read_text(encoding="utf-8", errors="replace")
        lines = output.strip().splitlines()
        if return_code != 0:
            detail = lines[-1] if lines else "unknown local runtime error"
            logger.warning("PowerPaint process failed: return_code=%s", return_code)
            raise RuntimeError(f"PowerPaint failed: {detail}")
        for line in reversed(lines):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "peak_vram_mb" in payload:
                peak = verify_vram_peak("PowerPaint", int(payload["peak_vram_mb"]))
                logger.info("PowerPaint completed: peak_mb=%s", peak)
                return peak
        raise RuntimeError("PowerPaint completed without a valid runtime report")
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        progress_path.unlink(missing_ok=True)
        log_path.unlink(missing_ok=True)
