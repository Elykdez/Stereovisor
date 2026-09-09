import importlib.util
from pathlib import Path

from PIL import Image

from service.src.config import snapshot_ready

RUNNER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "powerpaint-runner.py"
SPEC = importlib.util.spec_from_file_location("powerpaint_runner", RUNNER_PATH)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def test_default_inference_steps_are_25() -> None:
    assert RUNNER.DEFAULT_INFERENCE_STEPS == 25


def test_full_redraw_composite_keeps_the_core_and_feathers_the_seam() -> None:
    source = Image.new("RGB", (21, 21), "red")
    generated = Image.new("RGB", (21, 21), "blue")
    mask = Image.new("L", (21, 21))
    for y in range(7, 14):
        for x in range(7, 14):
            mask.putpixel((x, y), 255)

    result = RUNNER.composite_full_redraw(generated, source, mask)

    assert result.getpixel((0, 0)) == (255, 0, 0)
    assert result.getpixel((10, 10)) == (0, 0, 255)
    assert result.getpixel((7, 10)) == (0, 0, 255)
    assert result.getpixel((6, 10)) not in ((255, 0, 0), (0, 0, 255))


def test_snapshot_readiness_requires_marker_and_declared_files(tmp_path: Path) -> None:
    (tmp_path / ".stereovisor-ready").write_text("model/repo", encoding="utf-8")

    assert snapshot_ready(tmp_path) is True
    assert snapshot_ready(tmp_path, ("weights/model.bin",)) is False

    weights = tmp_path / "weights"
    weights.mkdir()
    (weights / "model.bin").write_bytes(b"complete")

    assert snapshot_ready(tmp_path, ("weights/model.bin",)) is True
