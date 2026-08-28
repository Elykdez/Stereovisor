from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from service import pipeline
from service.ai_models import InstanceMask
from service.depth import foreground_depth_plane, normalize_depth


def proposal(left: int, top: int, right: int, bottom: int) -> np.ndarray:
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[top:bottom, left:right] = 255
    return mask


def test_preview_pipeline_builds_layered_sample(tmp_path: Path) -> None:
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")

    result = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")

    assert len(result.layers) >= 2
    assert all((tmp_path / f"layer-{index:02d}-mask.png").is_file() for index in range(1, len(result.layers) + 1))
    assert all((tmp_path / f"layer-{index:02d}-cutout.png").is_file() for index in range(1, len(result.layers) + 1))


def test_joined_mask_and_preview_inpaint_preserve_unmasked_pixels(tmp_path: Path) -> None:
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")
    selected = [layer.id for layer in project.layers[:2]]

    result = pipeline.PreviewPipeline().inpaint(project, tmp_path, selected)
    source = np.asarray(image.convert("RGB"))
    background = np.asarray(Image.open(tmp_path / "background.png").convert("RGB"))
    union = np.asarray(Image.open(tmp_path / "union-mask.png").convert("L"))

    assert result.backgroundUrl is not None
    assert result.unionMaskUrl is not None
    assert np.count_nonzero(union) > 0
    assert np.array_equal(background[union == 0], source[union == 0])


def test_union_rejects_unknown_layers(tmp_path: Path) -> None:
    image = pipeline.create_sample_image()
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")

    with pytest.raises(pipeline.PipelineError, match="unknown layer"):
        pipeline.build_union_mask(project, tmp_path, ["missing-layer"])


def test_production_pipeline_keeps_sam_mask_when_matte_is_rejected(monkeypatch, tmp_path: Path) -> None:
    rejected = proposal(5, 5, 35, 35)
    accepted = proposal(55, 55, 90, 90)

    monkeypatch.setattr(
        pipeline,
        "grounded_sam_instances",
        lambda _image: ([
            InstanceMask("person", 0.9, rejected),
            InstanceMask("person", 0.8, accepted),
        ], {"groundingDino": 100, "sam2": 200}),
    )
    monkeypatch.setattr(pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300))
    monkeypatch.setattr(pipeline, "foreground_depth_plane", lambda _depth, _masks: None)

    def matte(_image: Image.Image, mask: np.ndarray) -> np.ndarray:
        if np.array_equal(mask, rejected):
            raise pipeline.MatteRejected("not a usable InSPyReNet subject")
        return mask

    monkeypatch.setattr(pipeline, "_matte_mask", matte)

    result = pipeline.ProductionPipeline().analyze(
        Image.new("RGB", (100, 100), "white"),
        tmp_path,
        "project-id",
    )

    assert len(result.layers) == 2
    assert (tmp_path / "layer-01-mask.png").is_file()
    assert result.layers[0].name == "Person 01"
    assert result.layers[1].name == "Person 02"
    assert result.vramPeaksMb["depthAnything3"] == 300


def test_production_pipeline_keeps_runtime_matting_failures_explicit(monkeypatch, tmp_path: Path) -> None:
    mask = proposal(10, 10, 50, 50)
    monkeypatch.setattr(
        pipeline,
        "grounded_sam_instances",
        lambda _image: ([InstanceMask("person", 0.9, mask)], {}),
    )
    monkeypatch.setattr(
        pipeline,
        "_matte_mask",
        lambda _image, _mask: (_ for _ in ()).throw(pipeline.PipelineError("InSPyReNet runtime failed")),
    )

    with pytest.raises(pipeline.PipelineError, match="InSPyReNet runtime failed"):
        pipeline.ProductionPipeline().analyze(
            Image.new("RGB", (100, 100), "white"),
            tmp_path,
            "project-id",
        )


def test_matting_uses_inspyrenet_soft_map(monkeypatch) -> None:
    class FakeRemover:
        def __init__(self) -> None:
            self.requested_types: list[str] = []

        def process(self, crop: Image.Image, type: str) -> Image.Image:
            self.requested_types.append(type)
            return Image.new("L", crop.size, 255)

    remover = FakeRemover()
    monkeypatch.setattr(pipeline, "_inspyrenet_remover", remover)
    mask = proposal(25, 25, 75, 75)

    matte = pipeline._matte_mask(Image.new("RGB", (100, 100), "white"), mask)

    assert remover.requested_types == ["map"]
    assert matte.shape == mask.shape
    assert np.count_nonzero(matte) >= np.count_nonzero(mask)


def test_depth_normalization_converts_far_depth_to_low_parallax() -> None:
    raw = np.asarray([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)

    near = normalize_depth(raw, (2, 2))

    assert near[0, 0] > near[-1, -1]
    assert 0.0 <= near.min() <= near.max() <= 1.0


def test_depth_plane_excludes_semantic_instance() -> None:
    near = np.full((100, 100), 0.2, dtype=np.float32)
    near[60:100, :] = 0.95
    semantic = proposal(40, 65, 60, 95)

    plane = foreground_depth_plane(near, [semantic])

    assert plane is not None
    assert np.count_nonzero(plane[semantic > 0]) == 0
    assert np.count_nonzero(plane) > 100


def test_powerpaint_mode_generates_local_prompt_and_records_provider(monkeypatch, tmp_path: Path) -> None:
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")
    selected = [project.layers[0].id]
    monkeypatch.setattr(pipeline, "generate_background_prompt", lambda _image: ("weathered stone wall", 321))

    def fake_powerpaint(source: Path, _mask: Path, output: Path, prompt: str) -> int:
        assert source == tmp_path / "source.png"
        assert prompt == "weathered stone wall"
        Image.open(source).save(output)
        return 654

    monkeypatch.setattr(pipeline, "powerpaint_inpaint", fake_powerpaint)

    result = pipeline.ProductionPipeline().inpaint(
        project,
        tmp_path,
        selected,
        refinement="powerpaint",
    )

    assert result.inpaintProvider == "powerpaint"
    assert result.backgroundPrompt == "weathered stone wall"
    assert result.vramPeaksMb["qwen3Vl"] == 321
    assert result.vramPeaksMb["powerpaint"] == 654
    assert (tmp_path / "background.png").is_file()
