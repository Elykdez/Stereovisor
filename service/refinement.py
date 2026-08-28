from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from PIL import Image

from .ai_models import (
    POWERPAINT_PATH,
    QWEN_PATH,
    begin_vram_stage,
    peak_vram_mb,
    release_cuda,
    resolve_device,
    verify_vram_peak,
)
from .config import POWERPAINT_PYTHON, POWERPAINT_VENDOR, WORKSPACE_ROOT, snapshot_ready


def generate_background_prompt(image: Image.Image) -> tuple[str, int]:
    if not snapshot_ready(QWEN_PATH, ("model.safetensors",)):
        raise RuntimeError("Qwen3-VL weights are missing. Run scripts/ensure-ready.ps1.")
    try:
        import torch
        from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
    except ImportError as error:
        raise RuntimeError("Qwen3-VL is unavailable. Run scripts/setup-ai.ps1.") from error

    device = resolve_device(torch)
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
                    "text": (
                        "Describe only the unobstructed background, materials, lighting, and perspective "
                        "for an image inpainting model. Do not mention people, characters, text, logos, "
                        "foreground objects, or the act of removal. Return one concise English prompt."
                    ),
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
            generated = model.generate(**inputs, max_new_tokens=96, do_sample=False)
        trimmed = [output[len(source):] for source, output in zip(inputs.input_ids, generated)]
        prompt = processor.batch_decode(trimmed, skip_special_tokens=True)[0].strip()
        if not prompt:
            raise RuntimeError("Qwen3-VL returned an empty background prompt")
        return prompt[:500], verify_vram_peak("Qwen3-VL", peak_vram_mb(torch))
    finally:
        del generated, inputs, processor, model
        release_cuda(torch)


def powerpaint_inpaint(
    image_path: Path,
    mask_path: Path,
    output_path: Path,
    prompt: str,
) -> int:
    runner = WORKSPACE_ROOT / "scripts" / "powerpaint-runner.py"
    required = (
        "PowerPaint_Brushnet/diffusion_pytorch_model.safetensors",
        "PowerPaint_Brushnet/pytorch_model.bin",
        "realisticVisionV60B1_v51VAE/unet/diffusion_pytorch_model.safetensors",
    )
    if not POWERPAINT_PYTHON.is_file() or not POWERPAINT_VENDOR.is_dir() or not snapshot_ready(POWERPAINT_PATH, required):
        raise RuntimeError("PowerPaint v2.1 is not installed. Run scripts/ensure-ready.ps1.")
    environment = os.environ.copy()
    environment.update({
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "DIFFUSERS_OFFLINE": "1",
        "PYTORCH_ALLOC_CONF": "expandable_segments:True",
    })
    command = [
        str(POWERPAINT_PYTHON),
        str(runner),
        "--image", str(image_path),
        "--mask", str(mask_path),
        "--output", str(output_path),
        "--prompt", prompt,
        "--checkpoint", str(POWERPAINT_PATH),
        "--vendor", str(POWERPAINT_VENDOR),
    ]
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=environment,
        timeout=900,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().splitlines()[-1:]
        raise RuntimeError(f"PowerPaint failed: {detail[0] if detail else 'unknown local runtime error'}")
    try:
        payload = json.loads(completed.stdout.strip().splitlines()[-1])
        return verify_vram_peak("PowerPaint", int(payload.get("peak_vram_mb", 0)))
    except (IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("PowerPaint completed without a valid runtime report") from error
