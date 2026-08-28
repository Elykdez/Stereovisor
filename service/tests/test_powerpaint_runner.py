import importlib.util
from pathlib import Path

from PIL import Image

from service.config import snapshot_ready


RUNNER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "powerpaint-runner.py"
SPEC = importlib.util.spec_from_file_location("powerpaint_runner", RUNNER_PATH)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def test_full_redraw_composite_never_blends_source_inside_mask() -> None:
    source = Image.new("RGB", (3, 1), "red")
    generated = Image.new("RGB", (3, 1), "blue")
    mask = Image.new("L", (3, 1))
    mask.putdata([0, 1, 255])

    result = RUNNER.composite_full_redraw(generated, source, mask)

    assert [result.getpixel((x, 0)) for x in range(3)] == [(255, 0, 0), (0, 0, 255), (0, 0, 255)]


def test_snapshot_readiness_requires_marker_and_declared_files(tmp_path: Path) -> None:
    (tmp_path / ".stereovisor-ready").write_text("model/repo", encoding="utf-8")

    assert snapshot_ready(tmp_path) is True
    assert snapshot_ready(tmp_path, ("weights/model.bin",)) is False

    weights = tmp_path / "weights"
    weights.mkdir()
    (weights / "model.bin").write_bytes(b"complete")

    assert snapshot_ready(tmp_path, ("weights/model.bin",)) is True
