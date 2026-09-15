import hashlib
import urllib.error
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from service.src import pipeline
from service.src.ai_models import InstanceMask
from service.src.depth import foreground_depth_plane, normalize_depth


def proposal(left: int, top: int, right: int, bottom: int) -> np.ndarray:
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[top:bottom, left:right] = 255
    return mask


def test_preview_pipeline_builds_layered_sample(tmp_path: Path) -> None:
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")
    progress: list[tuple[int, str]] = []

    result = pipeline.PreviewPipeline().analyze(
        image,
        tmp_path,
        "project-id",
        progress=lambda percent, stage, _message: progress.append((percent, stage)),
    )

    assert len(result.layers) >= 2
    assert all(
        (tmp_path / f"layer-{index:02d}-mask.png").is_file()
        for index in range(1, len(result.layers) + 1)
    )
    assert all(
        (tmp_path / f"layer-{index:02d}-proposal-mask.png").is_file()
        for index in range(1, len(result.layers) + 1)
    )
    assert all(
        (tmp_path / f"layer-{index:02d}-cutout.png").is_file()
        for index in range(1, len(result.layers) + 1)
    )
    assert all(
        not layer.confirmed and layer.refinementState == "rough"
        for layer in result.layers
    )
    assert progress == [(12, "Segmenting objects"), (64, "Building layers")]


def test_joined_mask_and_preview_inpaint_preserve_unmasked_pixels(
    tmp_path: Path,
) -> None:
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")
    selected = [layer.id for layer in project.layers[:2]]
    for layer_id in selected:
        project = pipeline.confirm_layer_mask(project, layer_id)

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


def test_union_rejects_unconfirmed_layers(tmp_path: Path) -> None:
    image = pipeline.create_sample_image()
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")

    with pytest.raises(pipeline.PipelineError, match="Confirm every selected mask"):
        pipeline.build_union_mask(project, tmp_path, [project.layers[0].id])


def test_layer_mask_merge_round_trips_with_undo_and_redo(tmp_path: Path) -> None:
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")
    selected = project.layers[:2]
    expected = np.maximum.reduce(
        [
            np.asarray(
                Image.open(tmp_path / Path(layer.maskUrl).name).convert("L"),
                dtype=np.uint8,
            )
            for layer in selected
        ]
    )

    merged = pipeline.merge_layer_masks(
        project, tmp_path, [layer.id for layer in selected]
    )
    assert len(merged.layers) == len(project.layers) - 1
    assert merged.layers[0].id == selected[0].id
    assert merged.layers[0].name == "Merged (2 objects)"
    assert merged.layers[0].confirmed is False
    assert np.array_equal(
        np.asarray(
            Image.open(tmp_path / Path(merged.layers[0].maskUrl).name).convert("L")
        ),
        expected,
    )
    assert pipeline.layer_merge_history(merged, tmp_path)[0].canUndo

    undone = pipeline.restore_layer_merge_history(merged, tmp_path, "undo")
    assert len(undone.layers) == len(project.layers)
    assert all(
        (tmp_path / Path(layer.maskUrl).name).is_file() for layer in undone.layers
    )
    assert pipeline.layer_merge_history(undone, tmp_path)[0].canRedo

    redone = pipeline.restore_layer_merge_history(undone, tmp_path, "redo")
    assert len(redone.layers) == len(merged.layers)
    assert redone.layers[0].name == "Merged (2 objects)"


def test_inpaint_input_erases_every_masked_source_pixel() -> None:
    source = Image.new("RGB", (3, 1))
    source.putdata([(10, 20, 30), (40, 50, 60), (70, 80, 90)])
    mask = Image.new("L", source.size)
    mask.putdata([0, 1, 255])

    result = pipeline.build_inpaint_input(source, mask)

    assert np.array_equal(
        np.asarray(result),
        np.asarray([[(10, 20, 30), (0, 0, 0), (0, 0, 0)]], dtype=np.uint8),
    )


def test_production_analysis_keeps_rough_sam_masks_without_running_inspyrenet(
    monkeypatch, tmp_path: Path
) -> None:
    rejected = proposal(5, 5, 35, 35)
    accepted = proposal(55, 55, 90, 90)

    monkeypatch.setattr(
        pipeline,
        "grounded_sam_instances",
        lambda _image, _density="balanced", _labels=None: (
            [
                InstanceMask("person", 0.9, rejected),
                InstanceMask("person", 0.8, accepted),
            ],
            {"groundingDino": 100, "sam2": 200},
        ),
    )
    monkeypatch.setattr(
        pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300)
    )
    monkeypatch.setattr(pipeline, "foreground_depth_plane", lambda _depth, _masks: None)

    matte = pytest.fail
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
    assert all(
        layer.refinementState == "rough" and not layer.confirmed
        for layer in result.layers
    )
    assert result.vramPeaksMb["depthAnything3"] == 300


def test_production_analysis_forwards_segmentation_options(
    monkeypatch, tmp_path: Path
) -> None:
    seen: dict[str, object] = {}
    mask = proposal(10, 10, 50, 50)

    def fake_instances(_image, density="balanced", labels=None):
        seen.update({"density": density, "labels": labels})
        return [InstanceMask("person", 0.9, mask)], {"groundingDino": 100, "sam2": 200}

    monkeypatch.setattr(pipeline, "grounded_sam_instances", fake_instances)
    monkeypatch.setattr(pipeline, "propose_object_vocabulary", pytest.fail)
    monkeypatch.setattr(
        pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300)
    )
    monkeypatch.setattr(pipeline, "foreground_depth_plane", lambda _depth, _masks: None)

    pipeline.ProductionPipeline().analyze(
        Image.new("RGB", (100, 100), "white"),
        tmp_path,
        "project-id",
        segmentation_density="dense",
        segmentation_labels="person, keyboard",
        use_vlm_vocabulary=True,
    )

    assert seen == {"density": "dense", "labels": "person, keyboard"}


def test_production_analysis_uses_vlm_vocabulary_before_detection(
    monkeypatch, tmp_path: Path
) -> None:
    seen: list[str] = []
    mask = proposal(10, 10, 50, 50)

    def fake_proposer(_image, density="balanced"):
        seen.append(f"vlm:{density}")
        return "person, keyboard", 321

    def fake_instances(_image, density="balanced", labels=None):
        seen.append(f"detector:{density}:{labels}")
        return [InstanceMask("person", 0.9, mask)], {"groundingDino": 100, "sam2": 200}

    monkeypatch.setattr(pipeline, "propose_object_vocabulary", fake_proposer)
    monkeypatch.setattr(pipeline, "grounded_sam_instances", fake_instances)
    monkeypatch.setattr(
        pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300)
    )
    monkeypatch.setattr(pipeline, "foreground_depth_plane", lambda _depth, _masks: None)

    result = pipeline.ProductionPipeline().analyze(
        Image.new("RGB", (100, 100), "white"),
        tmp_path,
        "project-id",
        segmentation_density="dense",
        use_vlm_vocabulary=True,
    )

    assert seen == ["vlm:dense", "detector:dense:person, keyboard"]
    assert result.vramPeaksMb["qwen3VlVocabulary"] == 321


def test_production_refine_keeps_runtime_matting_failures_explicit(
    monkeypatch, tmp_path: Path
) -> None:
    mask = proposal(10, 10, 50, 50)
    monkeypatch.setattr(
        pipeline,
        "grounded_sam_instances",
        lambda _image, _density="balanced", _labels=None: (
            [InstanceMask("person", 0.9, mask)],
            {},
        ),
    )
    monkeypatch.setattr(
        pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300)
    )
    monkeypatch.setattr(pipeline, "foreground_depth_plane", lambda _depth, _masks: None)
    project = pipeline.ProductionPipeline().analyze(
        Image.new("RGB", (100, 100), "white"), tmp_path, "project-id"
    )
    Image.new("RGB", (100, 100), "white").save(tmp_path / "source.png")
    monkeypatch.setattr(
        pipeline,
        "_matte_mask",
        lambda _image, _mask: (_ for _ in ()).throw(
            pipeline.PipelineError("InSPyReNet runtime failed")
        ),
    )

    with pytest.raises(pipeline.PipelineError, match="InSPyReNet runtime failed"):
        pipeline.ProductionPipeline().refine(project, tmp_path, project.layers[0].id)


def test_production_refine_updates_only_the_requested_layer(
    monkeypatch, tmp_path: Path
) -> None:
    first = proposal(10, 10, 40, 40)
    second = proposal(60, 60, 90, 90)
    image = Image.new("RGB", (100, 100), "white")
    image.save(tmp_path / "source.png")
    monkeypatch.setattr(
        pipeline,
        "grounded_sam_instances",
        lambda _image, _density="balanced", _labels=None: (
            [InstanceMask("person", 0.9, first), InstanceMask("person", 0.8, second)],
            {},
        ),
    )
    monkeypatch.setattr(
        pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300)
    )
    monkeypatch.setattr(pipeline, "foreground_depth_plane", lambda _depth, _masks: None)
    project = pipeline.ProductionPipeline().analyze(image, tmp_path, "project-id")
    second_before = (tmp_path / "layer-02-mask.png").read_bytes()
    refined = proposal(5, 5, 45, 45)
    monkeypatch.setattr(pipeline, "_matte_mask", lambda _image, _mask: refined)

    result = pipeline.ProductionPipeline().refine(
        project, tmp_path, project.layers[0].id
    )

    assert result.layers[0].refinementState == "refined"
    assert result.layers[0].confirmed is False
    assert result.layers[0].maskRevision == 1
    assert result.layers[1].refinementState == "rough"
    assert (tmp_path / "layer-02-mask.png").read_bytes() == second_before


def test_production_refine_supports_depth_plane_layers(
    monkeypatch, tmp_path: Path
) -> None:
    person = proposal(35, 20, 65, 80)
    depth_plane = proposal(5, 60, 95, 95)
    image = Image.new("RGB", (100, 100), "white")
    image.save(tmp_path / "source.png")
    monkeypatch.setattr(
        pipeline,
        "grounded_sam_instances",
        lambda _image, _density="balanced", _labels=None: (
            [InstanceMask("person", 0.9, person)],
            {},
        ),
    )
    monkeypatch.setattr(
        pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300)
    )
    monkeypatch.setattr(
        pipeline, "foreground_depth_plane", lambda _depth, _masks: depth_plane
    )
    project = pipeline.ProductionPipeline().analyze(image, tmp_path, "project-id")
    target = next(layer for layer in project.layers if layer.kind == "depth-plane")
    guided = proposal(8, 62, 92, 93)
    monkeypatch.setattr(pipeline, "_guided_mask_refine", lambda _image, _mask: guided)
    monkeypatch.setattr(pipeline, "_matte_mask", pytest.fail)

    result = pipeline.ProductionPipeline().refine(project, tmp_path, target.id)
    refined = next(layer for layer in result.layers if layer.id == target.id)

    assert refined.refinementState == "refined"
    assert refined.confirmed is False
    assert refined.maskRevision == 1
    assert np.array_equal(
        np.asarray(Image.open(tmp_path / Path(refined.maskUrl).name)), guided
    )


def test_refine_uses_stable_edited_proposal_after_previous_refinement(
    monkeypatch, tmp_path: Path
) -> None:
    image = Image.new("RGB", (100, 100), "white")
    image.save(tmp_path / "source.png")
    rough = proposal(20, 20, 70, 80)
    monkeypatch.setattr(
        pipeline,
        "grounded_sam_instances",
        lambda _image, _density="balanced", _labels=None: (
            [InstanceMask("person", 0.9, rough)],
            {},
        ),
    )
    monkeypatch.setattr(
        pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300)
    )
    monkeypatch.setattr(pipeline, "foreground_depth_plane", lambda _depth, _masks: None)
    project = pipeline.ProductionPipeline().analyze(image, tmp_path, "project-id")
    edited = proposal(10, 10, 85, 90)
    project = pipeline.replace_layer_mask(
        project, tmp_path, project.layers[0].id, Image.fromarray(edited)
    )
    seen: list[np.ndarray] = []
    refined = proposal(15, 15, 80, 85)
    monkeypatch.setattr(
        pipeline,
        "_matte_mask",
        lambda _image, mask: (seen.append(mask.copy()) or refined),
    )

    pipeline.ProductionPipeline().refine(project, tmp_path, project.layers[0].id)

    assert np.array_equal(seen[0], edited)


def test_refine_backfills_a_missing_proposal_for_legacy_projects(
    monkeypatch, tmp_path: Path
) -> None:
    image = Image.new("RGB", (100, 100), "white")
    image.save(tmp_path / "source.png")
    rough = proposal(20, 20, 70, 80)
    monkeypatch.setattr(
        pipeline,
        "grounded_sam_instances",
        lambda _image, _density="balanced", _labels=None: (
            [InstanceMask("person", 0.9, rough)],
            {},
        ),
    )
    monkeypatch.setattr(
        pipeline, "estimate_near_map", lambda _image: (np.full((100, 100), 0.6), 300)
    )
    monkeypatch.setattr(pipeline, "foreground_depth_plane", lambda _depth, _masks: None)
    project = pipeline.ProductionPipeline().analyze(image, tmp_path, "project-id")
    legacy = project.model_copy(
        update={
            "layers": [project.layers[0].model_copy(update={"proposalMaskUrl": None})]
        }
    )
    seen: list[np.ndarray] = []
    monkeypatch.setattr(
        pipeline,
        "_matte_mask",
        lambda _image, mask: (seen.append(mask.copy()) or rough),
    )

    result = pipeline.ProductionPipeline().refine(legacy, tmp_path, legacy.layers[0].id)

    assert np.array_equal(seen[0], rough)
    assert result.layers[0].proposalMaskUrl is not None
    assert (tmp_path / Path(result.layers[0].proposalMaskUrl).name).is_file()


def test_mask_refine_history_round_trips_layer_mask_and_state(tmp_path: Path) -> None:
    image = Image.new("RGB", (100, 100), "#202020")
    ImageDraw.Draw(image).rectangle((20, 20, 79, 79), fill="#d06030")
    image.save(tmp_path / "source.png")
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")
    layer = project.layers[0]
    original = np.asarray(Image.open(tmp_path / Path(layer.maskUrl).name).convert("L"))
    changed = proposal(25, 25, 75, 75)
    pipeline.record_mask_refine_history(project, tmp_path, layer.id)
    updated = pipeline.replace_layer_mask(
        project,
        tmp_path,
        layer.id,
        Image.fromarray(changed),
        update_proposal=False,
        clear_history=False,
    ).model_copy(
        update={"layers": [layer.model_copy(update={"refinementState": "refined"})]}
    )

    undone = pipeline.restore_mask_history(updated, tmp_path, layer.id, "undo")
    undone_layer = undone.layers[0]
    assert np.array_equal(
        np.asarray(Image.open(tmp_path / Path(undone_layer.maskUrl).name).convert("L")),
        original,
    )
    assert undone_layer.refinementState == "rough"
    assert undone_layer.confirmed is False

    redone = pipeline.restore_mask_history(undone, tmp_path, layer.id, "redo")
    assert np.array_equal(
        np.asarray(
            Image.open(tmp_path / Path(redone.layers[0].maskUrl).name).convert("L")
        ),
        changed,
    )
    assert redone.layers[0].refinementState == "refined"


def test_guided_mask_refine_preserves_foreground_and_rejects_distant_pixels() -> None:
    pytest.importorskip("cv2", reason="OpenCV ships with the local AI runtime")
    pixels = np.full((100, 100, 3), 235, dtype=np.uint8)
    pixels[30:80, 20:80] = (35, 90, 130)
    rough = proposal(15, 25, 85, 85)

    refined = pipeline._guided_mask_refine(Image.fromarray(pixels), rough)

    assert refined.shape == rough.shape
    assert refined[50, 50] > 200
    assert refined[5, 5] == 0
    assert np.count_nonzero((refined > 0) & (rough == 0)) == 0
    assert np.count_nonzero(refined) > 0


def test_matting_uses_inspyrenet_soft_map(monkeypatch) -> None:
    class FakeRemover:
        def __init__(self) -> None:
            self.requested_types: list[str] = []
            self.crop_sizes: list[tuple[int, int]] = []

        def process(self, crop: Image.Image, type: str) -> Image.Image:
            self.requested_types.append(type)
            self.crop_sizes.append(crop.size)
            return Image.new("L", crop.size, 255)

    remover = FakeRemover()
    monkeypatch.setattr(pipeline, "_inspyrenet_remover", remover)
    mask = proposal(25, 25, 75, 75)

    matte = pipeline._matte_mask(Image.new("RGB", (100, 100), "white"), mask)

    assert remover.requested_types == ["map"]
    assert remover.crop_sizes == [(50, 50)]
    assert matte.shape == mask.shape
    assert np.count_nonzero(matte) == 50 * 50
    assert np.count_nonzero(matte[:25, :]) == 0
    assert np.count_nonzero(matte[75:, :]) == 0
    assert np.count_nonzero(matte[:, :25]) == 0
    assert np.count_nonzero(matte[:, 75:]) == 0


def test_matting_keeps_saliency_inside_the_edited_mask_guidance(monkeypatch) -> None:
    class BroadSaliency:
        def process(self, crop: Image.Image, type: str) -> Image.Image:
            assert type == "map"
            return Image.new("L", crop.size, 255)

    monkeypatch.setattr(pipeline, "_inspyrenet_remover", BroadSaliency())
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[10:30, 30:70] = 255
    # A small second stroke gives the edited mask an AABB containing an
    # unrelated gap, which the saliency model must not fill.
    mask[70:72, 30:70] = 255

    matte = pipeline._matte_mask(Image.new("RGB", (100, 100), "white"), mask)

    assert np.count_nonzero(matte[10:30, 30:70]) > 0
    assert np.count_nonzero(matte[35:65, 30:70]) == 0
    assert np.count_nonzero(matte[70:72, 30:70]) > 0
    assert np.count_nonzero((matte > 0) & (mask == 0)) == 0


def test_matting_falls_back_to_the_edited_mask_when_saliency_collapses(
    monkeypatch,
) -> None:
    class TinySaliency:
        def process(self, crop: Image.Image, type: str) -> Image.Image:
            assert type == "map"
            output = Image.new("L", crop.size)
            for y in range(crop.height // 2 - 5, crop.height // 2 + 5):
                for x in range(crop.width // 2 - 5, crop.width // 2 + 5):
                    output.putpixel((x, y), 255)
            return output

    monkeypatch.setattr(pipeline, "_inspyrenet_remover", TinySaliency())
    mask = proposal(20, 20, 80, 80)

    matte = pipeline._matte_mask(Image.new("RGB", (100, 100), "white"), mask)

    assert np.array_equal(matte, mask)


def test_depth_normalization_converts_far_depth_to_low_parallax() -> None:
    raw = np.asarray([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)

    near = normalize_depth(raw, (2, 2))

    assert near[0, 0] > near[-1, -1]
    assert 0.0 <= near.min() <= near.max() <= 1.0


def test_depth_plane_excludes_semantic_instance() -> None:
    pytest.importorskip("cv2", reason="OpenCV ships with the local AI runtime")
    near = np.full((100, 100), 0.2, dtype=np.float32)
    near[60:100, :] = 0.95
    semantic = proposal(40, 65, 60, 95)

    plane = foreground_depth_plane(near, [semantic])

    assert plane is not None
    assert np.count_nonzero(plane[semantic > 0]) == 0
    assert np.count_nonzero(plane) > 100


def test_powerpaint_mode_generates_local_prompt_and_records_provider(
    monkeypatch, tmp_path: Path
) -> None:
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")
    selected = [project.layers[0].id]
    project = pipeline.confirm_layer_mask(project, selected[0])
    monkeypatch.setattr(
        pipeline,
        "generate_background_prompt",
        lambda _image: ("weathered stone wall", 321),
    )

    def fake_powerpaint(
        source: Path,
        mask: Path,
        output: Path,
        prompt: str,
        progress=None,
        cancelled=None,
        steps=25,
    ) -> int:
        assert steps == 12
        assert source == tmp_path / "inpaint-input.png"
        assert mask == tmp_path / "union-mask.png"
        assert prompt == "weathered stone wall"
        if progress is not None:
            progress(25, 25)
        Image.open(source).save(output)
        return 654

    monkeypatch.setattr(pipeline, "powerpaint_inpaint", fake_powerpaint)
    progress_events: list[tuple[int, str]] = []

    result = pipeline.ProductionPipeline().inpaint(
        project,
        tmp_path,
        selected,
        refinement="powerpaint",
        steps=12,
        progress=lambda percent, stage, _message: progress_events.append(
            (percent, stage)
        ),
    )

    assert result.inpaintProvider == "powerpaint"
    assert result.backgroundPrompt == "weathered stone wall"
    assert result.vramPeaksMb["qwen3Vl"] == 321
    assert result.vramPeaksMb["powerpaint"] == 654
    assert (tmp_path / "background.png").is_file()
    assert (42, "Loading PowerPaint") in progress_events
    assert (92, "Redrawing background") in progress_events


def test_target_inpaint_writes_only_to_the_selected_scene_layer(
    monkeypatch, tmp_path: Path
) -> None:
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")
    selected = [project.layers[0].id]
    project = pipeline.confirm_layer_mask(project, selected[0])
    project = pipeline.PreviewPipeline().inpaint(project, tmp_path, selected)
    composition = Image.new("RGB", image.size, "purple")
    mask = Image.new("L", image.size)
    mask.paste(255, (5, 5, 35, 35))

    def fake_powerpaint(
        source: Path,
        received_mask: Path,
        output: Path,
        prompt: str,
        progress=None,
        cancelled=None,
        steps=25,
    ) -> int:
        assert steps == 25
        assert np.array_equal(np.asarray(Image.open(source)), np.asarray(composition))
        assert np.array_equal(np.asarray(Image.open(received_mask)), np.asarray(mask))
        assert prompt == "replace selected pixels"
        if progress is not None:
            progress(25, 25)
        Image.new("RGB", image.size, "blue").save(output)
        return 612

    monkeypatch.setattr(pipeline, "powerpaint_inpaint", fake_powerpaint)
    background_before = np.asarray(
        Image.open(tmp_path / "background.png").convert("RGB")
    ).copy()
    updated_background = pipeline.ProductionPipeline().inpaint_target(
        project,
        tmp_path,
        "background",
        composition,
        mask,
        prompt="replace selected pixels",
    )
    background_after = np.asarray(
        Image.open(tmp_path / "background.png").convert("RGB")
    )

    assert updated_background.inpaintProvider == "powerpaint"
    assert tuple(background_after[10, 10]) == (0, 0, 255)
    assert np.array_equal(background_after[50, 50], background_before[50, 50])
    background_history = {
        state.targetId: state
        for state in pipeline.inpaint_history(updated_background, tmp_path)
    }
    assert background_history["background"].canUndo is True
    assert background_history["background"].canRedo is False

    pipeline.restore_inpaint_history(updated_background, tmp_path, "background", "undo")
    assert np.array_equal(
        np.asarray(Image.open(tmp_path / "background.png").convert("RGB")),
        background_before,
    )
    background_history = {
        state.targetId: state
        for state in pipeline.inpaint_history(updated_background, tmp_path)
    }
    assert background_history["background"].canUndo is False
    assert background_history["background"].canRedo is True
    pipeline.restore_inpaint_history(updated_background, tmp_path, "background", "redo")
    assert tuple(
        Image.open(tmp_path / "background.png").convert("RGB").getpixel((10, 10))
    ) == (0, 0, 255)

    target = updated_background.layers[0]
    target_path = tmp_path / Path(target.cutoutUrl).name
    target_before = target_path.read_bytes()
    other_cutouts = {
        layer.id: (tmp_path / Path(layer.cutoutUrl).name).read_bytes()
        for layer in updated_background.layers[1:]
    }
    updated_layer = pipeline.ProductionPipeline().inpaint_target(
        updated_background,
        tmp_path,
        target.id,
        composition,
        mask,
        prompt="replace selected pixels",
    )
    target_after = target_path.read_bytes()
    cutout = Image.open(target_path).convert("RGBA")

    assert updated_layer.vramPeaksMb["powerpaint"] == 612
    assert cutout.getpixel((10, 10)) == (0, 0, 255, 255)
    layer_history = {
        state.targetId: state
        for state in pipeline.inpaint_history(updated_layer, tmp_path)
    }
    assert layer_history[target.id].canUndo is True
    assert layer_history[target.id].canRedo is False
    pipeline.restore_inpaint_history(updated_layer, tmp_path, target.id, "undo")
    assert target_path.read_bytes() == target_before
    pipeline.restore_inpaint_history(updated_layer, tmp_path, target.id, "redo")
    assert target_path.read_bytes() == target_after
    assert all(
        (tmp_path / Path(layer.cutoutUrl).name).read_bytes() == other_cutouts[layer.id]
        for layer in updated_layer.layers[1:]
    )
    assert not any(
        (tmp_path / name).exists()
        for name in (
            ".layer-inpaint-composition.png",
            ".layer-inpaint-mask.png",
            ".layer-inpaint-result.png",
        )
    )


def test_guided_refine_pulls_a_rough_brush_onto_real_edges(tmp_path: Path) -> None:
    # Guards the band width: when the region GrabCut may decide is a fixed few
    # pixels, refinement is a visual no-op no matter how rough the brush is.
    cv2 = pytest.importorskip("cv2", reason="OpenCV ships with the local AI runtime")
    image = pipeline.create_sample_image()
    image.save(tmp_path / "source.png")
    project = pipeline.PreviewPipeline().analyze(image, tmp_path, "project-id")
    # Refinement can only find edges that exist, so the target is a real object.
    layer = next(
        candidate for candidate in project.layers if candidate.kind == "instance"
    )
    truth = np.asarray(
        Image.open(tmp_path / Path(layer.maskUrl).name).convert("L"), dtype=np.uint8
    )
    reference = truth > 8

    slop = 24
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (slop * 2 + 1, slop * 2 + 1))
    rough = cv2.dilate((reference * 255).astype(np.uint8), kernel, iterations=1) > 8

    def overlap(mask: np.ndarray) -> float:
        union = np.count_nonzero(mask | reference)
        return float(np.count_nonzero(mask & reference)) / union if union else 0.0

    refined = pipeline._guided_mask_refine(image, (rough * 255).astype(np.uint8)) > 8

    assert overlap(refined) > overlap(rough) + 0.05
    # The brush stays the outer bound: refinement tightens, it never spreads.
    assert not np.any(refined & ~rough)


def test_guided_refine_keeps_a_thin_mask_that_erodes_away() -> None:
    pytest.importorskip("cv2", reason="OpenCV ships with the local AI runtime")
    image = pipeline.create_sample_image()
    # A wiry selection disappears under a wide erosion; the band has to narrow
    # until a definite-foreground core survives instead of giving up.
    thin = np.zeros((image.height, image.width), dtype=np.uint8)
    thin[200:203, 100:600] = 255

    refined = pipeline._guided_mask_refine(image, thin)

    assert np.count_nonzero(refined > 8)


class _StubResponse:
    """Minimal stand-in for the urlopen context manager used by the downloader."""

    def __init__(self, payload: bytes) -> None:
        self._body = BytesIO(payload)
        self.status = 200
        self.headers = {"Content-Length": str(len(payload))}

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def __enter__(self) -> "_StubResponse":
        return self

    def __exit__(self, *_: object) -> bool:
        return False


def test_download_with_resume_discards_a_partial_that_fails_its_checksum(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "model.pt"
    monkeypatch.setattr(
        pipeline.urllib.request,
        "urlopen",
        lambda request, timeout=0: _StubResponse(b"corrupted"),
    )

    with pytest.raises(pipeline.PipelineError):
        pipeline._download_with_resume(
            "https://example.invalid/model.pt",
            target,
            hashlib.md5(b"expected").hexdigest(),
        )

    # A surviving full-length .part would make every later attempt request a
    # range past the end of the file, which the server rejects forever.
    assert not (tmp_path / "model.pt.part").exists()
    assert not target.exists()


def test_download_with_resume_restarts_when_a_stale_partial_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "model.pt"
    stale = b"stale-bytes-from-an-older-release"
    (tmp_path / "model.pt.part").write_bytes(stale)
    payload = b"the-current-model-bytes"
    ranges: list[str | None] = []

    def fake_urlopen(request: object, timeout: int = 0) -> _StubResponse:
        requested = request.headers.get("Range")
        ranges.append(requested)
        if requested:
            raise urllib.error.HTTPError(
                "https://example.invalid/model.pt",
                416,
                "Range Not Satisfiable",
                {},
                None,
            )
        return _StubResponse(payload)

    monkeypatch.setattr(pipeline.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(pipeline.time, "sleep", lambda _seconds: None)

    pipeline._download_with_resume(
        "https://example.invalid/model.pt", target, hashlib.md5(payload).hexdigest()
    )

    assert ranges == [f"bytes={len(stale)}-", None]
    assert target.read_bytes() == payload
    assert not (tmp_path / "model.pt.part").exists()
