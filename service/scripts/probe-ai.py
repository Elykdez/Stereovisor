from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from service.src.pipeline import ProductionPipeline, create_sample_image  # noqa: E402


def main() -> None:
    import torch

    parser = argparse.ArgumentParser()
    parser.add_argument("source", nargs="?", type=Path)
    args = parser.parse_args()
    if args.source:
        image = Image.open(args.source).convert("RGB")
        image.thumbnail((640, 640), Image.Resampling.LANCZOS)
    else:
        image = create_sample_image().resize((640, 403))
    pipeline = ProductionPipeline()
    with tempfile.TemporaryDirectory(prefix="stereovisor-ai-probe-") as temporary:
        directory = Path(temporary)
        image.save(directory / "source.png")
        analysis_started = time.perf_counter()
        project = pipeline.analyze(image, directory, "d" * 32)
        analysis_seconds = time.perf_counter() - analysis_started
        selected = [layer.id for layer in project.layers[: min(3, len(project.layers))]]
        inpaint_started = time.perf_counter()
        updated = pipeline.inpaint(project, directory, selected)
        inpaint_seconds = time.perf_counter() - inpaint_started
        output = {
            "cuda": torch.cuda.is_available(),
            "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
            "layers": len(project.layers),
            "layer_names": [layer.name for layer in project.layers],
            "layer_kinds": [layer.kind for layer in project.layers],
            "layer_depths": [layer.depth for layer in project.layers],
            "analysis_seconds": round(analysis_seconds, 2),
            "inpaint_seconds": round(inpaint_seconds, 2),
            "background_created": bool(updated.backgroundUrl and (directory / "background.png").is_file()),
            "union_mask_created": bool(updated.unionMaskUrl and (directory / "union-mask.png").is_file()),
            "cuda_allocated_after_mb": round(torch.cuda.memory_allocated() / 1048576, 1) if torch.cuda.is_available() else 0,
            "vram_peaks_mb": updated.vramPeaksMb,
            "within_8gb_budget": max(updated.vramPeaksMb.values(), default=0) <= 8192,
        }
        print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
