from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

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
from .config import (
    POWERPAINT_PYTHON,
    POWERPAINT_VENDOR,
    WORKSPACE_ROOT,
    powerpaint_snapshot_ready,
    snapshot_ready,
)
from .compute import (
    check_compute_cancelled,
    clear_compute,
    publish_compute,
    report_compute,
)
from .jobs import JobCancelled

logger = logging.getLogger(__name__)


def _run_qwen(
    image: Image.Image, instruction: str, max_new_tokens: int, stage: str
) -> tuple[str, int]:
    # Qwen is a single-purpose stage. The caller receives CPU text and the
    # model is released before any detector or inpainter is allowed to load.
    if not snapshot_ready(QWEN_PATH, ("model.safetensors",)):
        raise RuntimeError(
            "Qwen3-VL weights are missing. Run scripts/ensure-ready.ps1."
        )
    try:
        import torch
        from transformers import (
            AutoProcessor,
            Qwen3VLForConditionalGeneration,
            StoppingCriteria,
            StoppingCriteriaList,
        )
    except ImportError as error:
        raise RuntimeError(
            "Qwen3-VL is unavailable. Run service/scripts/setup-ai.ps1."
        ) from error

    device = resolve_device(torch)
    logger.info(
        "%s started: size=%sx%s device=%s", stage, image.width, image.height, device
    )
    model = None
    processor = None
    inputs = None
    generated = None
    try:
        report_compute(torch, "Qwen3-VL", device, "loading")
        begin_vram_stage(torch)
        processor = AutoProcessor.from_pretrained(QWEN_PATH, local_files_only=True)
        model = (
            Qwen3VLForConditionalGeneration.from_pretrained(
                QWEN_PATH,
                local_files_only=True,
                dtype=torch.float16 if device == "cuda" else torch.float32,
                low_cpu_mem_usage=True,
            )
            .to(device)
            .eval()
        )
        report_compute(torch, "Qwen3-VL", device, "preparing")
        # Captioning needs a bounded visual-token budget, not full-size scene pixels.
        model_image = image.convert("RGB")
        model_image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": model_image},
                    {
                        "type": "text",
                        "text": instruction,
                    },
                ],
            }
        ]
        inputs = processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(device)
        input_length = inputs.input_ids.shape[-1]
        last_report_at = time.monotonic()
        last_reported_tokens = 0

        class ComputeProgress(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):
                nonlocal last_report_at, last_reported_tokens
                check_compute_cancelled()
                count = max(0, input_ids.shape[-1] - input_length)
                now = time.monotonic()
                if count == 1 or count >= max_new_tokens or now - last_report_at >= 1:
                    report_compute(
                        torch, "Qwen3-VL", device, "inference",
                        completed=count, total=max_new_tokens, unit="tokens",
                    )
                    last_report_at = now
                    last_reported_tokens = count
                return False

        report_compute(
            torch, "Qwen3-VL", device, "inference",
            completed=0, total=max_new_tokens, unit="tokens",
        )
        with torch.inference_mode():
            generated = model.generate(
                **inputs, max_new_tokens=max_new_tokens, do_sample=False,
                stopping_criteria=StoppingCriteriaList([ComputeProgress()]),
            )
        check_compute_cancelled()
        completed_tokens = max(0, generated.shape[-1] - input_length)
        if completed_tokens != last_reported_tokens:
            report_compute(
                torch, "Qwen3-VL", device, "inference",
                completed=completed_tokens, total=max_new_tokens, unit="tokens",
            )
        trimmed = [
            output[len(source) :] for source, output in zip(inputs.input_ids, generated)
        ]
        prompt = processor.batch_decode(trimmed, skip_special_tokens=True)[0].strip()
        if not prompt:
            raise RuntimeError(f"{stage} returned empty text")
        peak = verify_vram_peak("Qwen3-VL", peak_vram_mb(torch))
        logger.info(
            "%s completed: length=%s peak_mb=%s", stage, len(prompt[:500]), peak
        )
        return prompt[:500], peak
    except RuntimeError as error:
        if device == "cuda" and (
            "out of memory" in str(error).lower()
            or isinstance(error, getattr(torch.cuda, "OutOfMemoryError", ()))
        ):
            raise RuntimeError(
                "Qwen3-VL ran out of GPU memory. Close other GPU applications and retry, "
                "or run the service with STEREOVISOR_DEVICE=cpu. A manual background "
                "prompt or object vocabulary skips this model."
            ) from error
        raise
    finally:
        try:
            report_compute(torch, "Qwen3-VL", device, "cleanup")
        finally:
            try:
                del generated, inputs, processor, model
                release_cuda(torch)
            finally:
                clear_compute(torch)


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
    cleaned = re.sub(
        r"<think>.*?</think>", "", raw, flags=re.IGNORECASE | re.DOTALL
    ).strip()
    cleaned = cleaned.replace("```json", "").replace("```", "").strip()
    cleaned = re.sub(r"(?m)^\s*(?:[-*]|\d+[.)])\s*", "", cleaned)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        cleaned = ",".join(str(item) for item in parsed)
    elif isinstance(parsed, dict):
        values = (
            parsed.get("objects") or parsed.get("labels") or parsed.get("vocabulary")
        )
        if isinstance(values, list):
            cleaned = ",".join(str(item) for item in values)
    lines = cleaned.splitlines()
    first_line = lines[0] if lines else ""
    if ":" in first_line:
        prefix, remainder = first_line.split(":", 1)
        if prefix.strip().lower() in {
            "objects",
            "labels",
            "vocabulary",
            "object vocabulary",
        }:
            cleaned = ",".join([remainder, *lines[1:]])
    return normalize_segmentation_labels(cleaned)


def propose_object_vocabulary(
    image: Image.Image, density: str = "balanced"
) -> tuple[str, int]:
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
    runner = WORKSPACE_ROOT / "service" / "scripts" / "powerpaint-runner.py"
    if (
        not POWERPAINT_PYTHON.is_file()
        or not POWERPAINT_VENDOR.is_dir()
        or not powerpaint_snapshot_ready(POWERPAINT_PATH)
    ):
        raise RuntimeError(
            "PowerPaint v2.1 is not installed. Run scripts/ensure-ready.ps1."
        )
    environment = os.environ.copy()
    environment.update(
        {
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "DIFFUSERS_OFFLINE": "1",
            "PYTORCH_ALLOC_CONF": "expandable_segments:True",
        }
    )
    progress_path = output_path.with_name(".powerpaint-progress.json")
    log_path = output_path.with_name(".powerpaint-runner.log")
    progress_path.unlink(missing_ok=True)
    log_path.unlink(missing_ok=True)
    command = [
        str(POWERPAINT_PYTHON),
        str(runner),
        "--image",
        str(image_path),
        "--mask",
        str(mask_path),
        "--output",
        str(output_path),
        "--prompt",
        prompt,
        "--steps",
        str(max(5, min(100, int(steps)))),
        "--checkpoint",
        str(POWERPAINT_PATH),
        "--vendor",
        str(POWERPAINT_VENDOR),
        "--progress",
        str(progress_path),
    ]
    process: subprocess.Popen[str] | None = None
    reported_compute: dict | None = None
    retain_log = True
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
                if progress_path.is_file():
                    try:
                        report = json.loads(progress_path.read_text(encoding="utf-8"))
                        step = int(report["step"])
                        total = int(report["total"])
                        if step > reported_step:
                            if progress is not None:
                                progress(step, total)
                            reported_step = step
                        compute = report.get("compute")
                        if isinstance(compute, dict) and compute != reported_compute:
                            publish_compute(compute)
                            reported_compute = compute
                    except (
                        KeyError,
                        OSError,
                        TypeError,
                        ValueError,
                        json.JSONDecodeError,
                    ):
                        pass
                time.sleep(0.2)
            return_code = process.returncode

        output = log_path.read_text(encoding="utf-8", errors="replace")
        lines = output.strip().splitlines()
        if return_code != 0:
            detail = lines[-1] if lines else "unknown local runtime error"
            phase = (reported_compute or {}).get("phase", "loading")
            logger.warning("PowerPaint process failed: return_code=%s", return_code)
            if "out of memory" in output.lower():
                detail = (
                    "GPU or system memory was exhausted. Close other GPU applications "
                    "and retry, or use Big LaMa for this background."
                )
            raise RuntimeError(
                f"PowerPaint failed during {phase} (exit code {return_code}): {detail}"
            )
        for line in reversed(lines):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "peak_vram_mb" in payload:
                peak = verify_vram_peak("PowerPaint", int(payload["peak_vram_mb"]))
                logger.info("PowerPaint completed: peak_mb=%s", peak)
                retain_log = False
                return peak
        raise RuntimeError("PowerPaint completed without a valid runtime report")
    except JobCancelled:
        retain_log = False
        raise
    finally:
        try:
            if reported_compute is not None:
                cleanup = {
                    key: value for key, value in reported_compute.items()
                    if key not in {"completed", "total", "unit"}
                }
                publish_compute({**cleanup, "phase": "cleanup"})
        finally:
            try:
                if process is not None and process.poll() is None:
                    process.kill()
                    process.wait()
                progress_path.unlink(missing_ok=True)
                # Keep the failed run's diagnostics until the next attempt replaces them.
                if not retain_log:
                    log_path.unlink(missing_ok=True)
            finally:
                clear_compute()
