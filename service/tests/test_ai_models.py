import numpy as np

from service.src.ai_models import (
    _deduplicate_detections,
    normalize_segmentation_density,
    normalize_segmentation_labels,
)


def test_segmentation_density_falls_back_to_balanced() -> None:
    assert normalize_segmentation_density("unknown") == "balanced"
    assert normalize_segmentation_density(None) == "balanced"
    assert normalize_segmentation_density("dense") == "dense"


def test_segmentation_labels_normalize_delimiters_case_and_duplicates() -> None:
    assert normalize_segmentation_labels(" Person, keyboard.\nKEYBOARD, cup ") == (
        "person",
        "keyboard",
        "cup",
    )


def test_detector_deduplication_removes_nested_boxes_and_respects_limit() -> None:
    boxes = np.asarray(
        [
            [0, 0, 80, 80],
            [0, 0, 100, 100],
            [100, 100, 180, 180],
        ],
        dtype=np.float32,
    )
    scores = np.asarray([0.9, 0.8, 0.7], dtype=np.float32)

    accepted_boxes, accepted_scores, accepted_labels = _deduplicate_detections(
        boxes,
        scores,
        ["person", "person", "chair"],
        width=200,
        height=200,
        minimum_box_fraction=0.001,
        max_instances=2,
    )

    assert len(accepted_boxes) == len(accepted_scores) == len(accepted_labels) == 2
    assert accepted_labels == ["person", "chair"]
