from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter


DEFAULT_INFERENCE_STEPS = 25


def write_progress(
    path: Path | None,
    phase: str,
    step: int,
    total: int,
    torch_module=None,
    *,
    cuda_available: bool = False,
) -> None:
    if path is None:
        return
    compute = {
        "model": "PowerPaint",
        "device": "hybrid" if cuda_available else "cpu",
        "phase": phase,
        "reason": "offloading" if cuda_available else "cuda_unavailable",
    }
    if phase == "inference":
        compute.update(completed=step, total=total, unit="steps")
    if torch_module is not None and cuda_available:
        try:
            free, capacity = torch_module.cuda.mem_get_info()
            compute.update(
                gpuName=torch_module.cuda.get_device_name(),
                vramUsedMb=round((capacity - free) / 1048576),
                vramTotalMb=round(capacity / 1048576),
            )
        except Exception:
            # Telemetry is optional when a driver cannot expose memory usage.
            pass
    path.write_text(
        json.dumps({"step": step, "total": total, "compute": compute}),
        encoding="utf-8",
    )


def fit_size(size: tuple[int, int]) -> tuple[int, int]:
    width, height = size
    scale = max(640.0 / min(width, height), 1.0)
    if max(width, height) * scale > 1024:
        scale = 1024.0 / max(width, height)
    return max(8, round(width * scale / 8) * 8), max(8, round(height * scale / 8) * 8)


def composite_full_redraw(generated: Image.Image, source: Image.Image, mask: Image.Image) -> Image.Image:
    binary = mask.convert("L").point(lambda value: 255 if value > 0 else 0)
    feather_radius = max(1, round(min(source.size) * 0.004))
    feathered = ImageChops.lighter(binary, binary.filter(ImageFilter.GaussianBlur(feather_radius)))
    return Image.composite(generated, source, feathered)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--mask", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--steps", type=int, default=DEFAULT_INFERENCE_STEPS)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--vendor", type=Path, required=True)
    parser.add_argument("--progress", type=Path)
    args = parser.parse_args()
    inference_steps = max(5, min(100, args.steps))
    sys.path.insert(0, str(args.vendor))
    write_progress(args.progress, "loading", 0, inference_steps)

    import numpy as np
    import torch
    from diffusers import UniPCMultistepScheduler
    from safetensors.torch import load_file
    from transformers import CLIPTextModel

    from powerpaint.models.BrushNet_CA import BrushNetModel
    from powerpaint.models.unet_2d_condition import UNet2DConditionModel
    from powerpaint.pipelines.pipeline_PowerPaint_Brushnet_CA import StableDiffusionPowerPaintBrushNetPipeline
    from powerpaint.utils.utils import TokenizerWrapper, add_tokens

    cuda_available = bool(torch.cuda.is_available())
    write_progress(
        args.progress,
        "loading",
        0,
        inference_steps,
        torch,
        cuda_available=cuda_available,
    )
    torch.set_grad_enabled(False)
    if cuda_available:
        torch.cuda.reset_peak_memory_stats()
    dtype = torch.float16 if cuda_available else torch.float32
    base = args.checkpoint / "realisticVisionV60B1_v51VAE"
    brush_checkpoint = args.checkpoint / "PowerPaint_Brushnet"

    unet = UNet2DConditionModel.from_pretrained(
        base, subfolder="unet", torch_dtype=dtype, local_files_only=True
    )
    text_encoder_brushnet = CLIPTextModel.from_pretrained(
        base, subfolder="text_encoder", torch_dtype=dtype, local_files_only=True
    )
    # The complete BrushNet checkpoint replaces these weights; copying them
    # would also alias its input bias to the UNet that the pipeline reuses.
    brushnet = BrushNetModel.from_unet(unet, load_weights_from_unet=False)
    pipe = StableDiffusionPowerPaintBrushNetPipeline.from_pretrained(
        base,
        unet=unet,
        brushnet=brushnet,
        text_encoder_brushnet=text_encoder_brushnet,
        torch_dtype=dtype,
        low_cpu_mem_usage=False,
        safety_checker=None,
        local_files_only=True,
    )
    pipe.tokenizer = TokenizerWrapper(
        from_pretrained=base,
        subfolder="tokenizer",
        revision=None,
        torch_type=dtype,
        local_files_only=True,
    )
    add_tokens(
        tokenizer=pipe.tokenizer,
        text_encoder=pipe.text_encoder_brushnet,
        placeholder_tokens=["P_ctxt", "P_shape", "P_obj"],
        initialize_tokens=["a", "a", "a"],
        num_vectors_per_token=10,
    )
    brushnet_state = load_file(str(brush_checkpoint / "diffusion_pytorch_model.safetensors"), device="cpu")
    pipe.brushnet.load_state_dict(brushnet_state, strict=True)
    del brushnet_state
    pipe.text_encoder_brushnet.load_state_dict(
        torch.load(brush_checkpoint / "pytorch_model.bin", map_location="cpu", weights_only=True),
        strict=False,
    )
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
    pipe.vae.enable_tiling()
    write_progress(
        args.progress,
        "preparing",
        0,
        inference_steps,
        torch,
        cuda_available=cuda_available,
    )
    # Include both PowerPaint additions and release the VAE after encoding;
    # the upstream sequence leaves BrushNet resident on the GPU.
    if cuda_available:
        pipe.model_cpu_offload_seq = "text_encoder_brushnet->text_encoder->image_encoder->vae->brushnet->unet"
        pipe.enable_model_cpu_offload()

    source = Image.open(args.image).convert("RGB")
    mask_original = Image.open(args.mask).convert("L")
    working_size = fit_size(source.size)
    image = source.resize(working_size, Image.Resampling.LANCZOS)
    mask = mask_original.resize(working_size, Image.Resampling.NEAREST)
    mask_rgb = mask.convert("RGB")
    image_array = np.asarray(image, dtype=np.uint8)
    mask_array = np.asarray(mask_rgb, dtype=np.float32) / 255.0
    conditioned = Image.fromarray((image_array * (1.0 - mask_array)).astype(np.uint8))
    prompt = f"{args.prompt.strip()} empty scene blur".strip()
    negative = "people, person, character, object, text, logo, low quality, blurry artifacts"
    generator = torch.Generator(device="cuda" if cuda_available else "cpu").manual_seed(42)

    def report_progress(_pipeline, step: int, _timestep, callback_kwargs):
        # The next step starts with BrushNet, so finish the offload cycle here.
        if cuda_available:
            _pipeline.unet.to("cpu")
        write_progress(
            args.progress,
            "inference",
            step + 1,
            inference_steps,
            torch,
            cuda_available=cuda_available,
        )
        return callback_kwargs

    write_progress(
        args.progress,
        "inference",
        0,
        inference_steps,
        torch,
        cuda_available=cuda_available,
    )
    result = pipe(
        promptA=" P_ctxt",
        promptB=" P_ctxt",
        promptU=prompt,
        tradoff=1.0,
        tradoff_nag=1.0,
        image=conditioned,
        mask=mask_rgb,
        num_inference_steps=inference_steps,
        generator=generator,
        brushnet_conditioning_scale=1.0,
        negative_promptA=f"{negative} P_obj",
        negative_promptB=f"{negative} P_obj",
        negative_promptU=negative,
        guidance_scale=7.5,
        width=working_size[0],
        height=working_size[1],
        callback_on_step_end=report_progress,
    ).images[0]
    write_progress(
        args.progress,
        "cleanup",
        inference_steps,
        inference_steps,
        torch,
        cuda_available=cuda_available,
    )
    generated = result.resize(source.size, Image.Resampling.LANCZOS)
    final = composite_full_redraw(generated, source, mask_original)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    final.save(args.output)
    peak_vram_mb = (
        round(torch.cuda.max_memory_allocated() / 1048576) if cuda_available else 0
    )
    print(json.dumps({"peak_vram_mb": peak_vram_mb}))


if __name__ == "__main__":
    main()
