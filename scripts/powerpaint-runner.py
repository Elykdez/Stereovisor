from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image


def fit_size(size: tuple[int, int]) -> tuple[int, int]:
    width, height = size
    scale = max(640.0 / min(width, height), 1.0)
    if max(width, height) * scale > 1024:
        scale = 1024.0 / max(width, height)
    return max(8, round(width * scale / 8) * 8), max(8, round(height * scale / 8) * 8)


def composite_full_redraw(generated: Image.Image, source: Image.Image, mask: Image.Image) -> Image.Image:
    binary = mask.convert("L").point(lambda value: 255 if value > 0 else 0)
    return Image.composite(generated, source, binary)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--mask", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--vendor", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.vendor))

    from diffusers import UniPCMultistepScheduler
    from safetensors.torch import load_model
    from transformers import CLIPTextModel

    from powerpaint.models.BrushNet_CA import BrushNetModel
    from powerpaint.models.unet_2d_condition import UNet2DConditionModel
    from powerpaint.pipelines.pipeline_PowerPaint_Brushnet_CA import StableDiffusionPowerPaintBrushNetPipeline
    from powerpaint.utils.utils import TokenizerWrapper, add_tokens

    if not torch.cuda.is_available():
        raise RuntimeError("PowerPaint requires the local CUDA runtime")
    torch.set_grad_enabled(False)
    torch.cuda.reset_peak_memory_stats()
    dtype = torch.float16
    base = args.checkpoint / "realisticVisionV60B1_v51VAE"
    brush_checkpoint = args.checkpoint / "PowerPaint_Brushnet"

    unet = UNet2DConditionModel.from_pretrained(
        base, subfolder="unet", torch_dtype=dtype, local_files_only=True
    )
    text_encoder_brushnet = CLIPTextModel.from_pretrained(
        base, subfolder="text_encoder", torch_dtype=dtype, local_files_only=True
    )
    brushnet = BrushNetModel.from_unet(unet)
    pipe = StableDiffusionPowerPaintBrushNetPipeline.from_pretrained(
        base,
        brushnet=brushnet,
        text_encoder_brushnet=text_encoder_brushnet,
        torch_dtype=dtype,
        low_cpu_mem_usage=False,
        safety_checker=None,
        local_files_only=True,
    )
    pipe.unet = UNet2DConditionModel.from_pretrained(
        base, subfolder="unet", torch_dtype=dtype, local_files_only=True
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
    load_model(pipe.brushnet, str(brush_checkpoint / "diffusion_pytorch_model.safetensors"))
    pipe.text_encoder_brushnet.load_state_dict(
        torch.load(brush_checkpoint / "pytorch_model.bin", map_location="cpu", weights_only=True),
        strict=False,
    )
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
    pipe.vae.enable_tiling()
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
    generator = torch.Generator(device="cuda").manual_seed(42)
    result = pipe(
        promptA=" P_ctxt",
        promptB=" P_ctxt",
        promptU=prompt,
        tradoff=1.0,
        tradoff_nag=1.0,
        image=conditioned,
        mask=mask_rgb,
        num_inference_steps=45,
        generator=generator,
        brushnet_conditioning_scale=1.0,
        negative_promptA=f"{negative} P_obj",
        negative_promptB=f"{negative} P_obj",
        negative_promptU=negative,
        guidance_scale=7.5,
        width=working_size[0],
        height=working_size[1],
    ).images[0]
    generated = result.resize(source.size, Image.Resampling.LANCZOS)
    final = composite_full_redraw(generated, source, mask_original)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    final.save(args.output)
    print(json.dumps({"peak_vram_mb": round(torch.cuda.max_memory_allocated() / 1048576)}))


if __name__ == "__main__":
    main()
