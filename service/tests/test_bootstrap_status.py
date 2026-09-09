"""Bootstrap status publishing must never be able to fail a launch.

The status file is diagnostic: /api/health reads it to drive the startup gate.
On Windows `os.replace` fails while any process holds the destination open, and
the health watch reads it continuously while the gate is up. A transient
sharing violation there once killed model preparation outright, which left the
editor gated forever with no explanation.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "prepare-models.py"
SPEC = importlib.util.spec_from_file_location("prepare_models", MODULE_PATH)
assert SPEC and SPEC.loader
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


def status_file(root: Path) -> Path:
    return root / ".stereovisor-bootstrap-status"


def test_status_is_written_normally(tmp_path: Path) -> None:
    PREPARE.publish_bootstrap_status(
        tmp_path, "downloading", "Fetching depth model.", "depth", 42
    )

    lines = status_file(tmp_path).read_text(encoding="utf-8").splitlines()
    assert lines[0] == "downloading"
    assert lines[1] == "Fetching depth model."
    assert "provider=depth" in lines
    assert "progress=42" in lines


def test_a_locked_destination_does_not_fail_the_launch(
    tmp_path: Path, monkeypatch
) -> None:
    # Both the rename and the cleanup fail, which is precisely the pair that
    # escaped before: the handler for the first raised the second.
    def refuse(self, *args, **kwargs):
        raise PermissionError(32, "The process cannot access the file")

    monkeypatch.setattr(Path, "replace", refuse)
    monkeypatch.setattr(Path, "unlink", refuse)

    PREPARE.publish_bootstrap_status(tmp_path, "initializing", "Validating.")


def test_a_transient_lock_is_retried_rather_than_dropped(
    tmp_path: Path, monkeypatch
) -> None:
    real_replace = Path.replace
    attempts = {"count": 0}

    def flaky(self, target):
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise PermissionError(32, "The process cannot access the file")
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", flaky)

    PREPARE.publish_bootstrap_status(tmp_path, "ready", "Models are ready.", progress=100)

    assert attempts["count"] == 3
    assert status_file(tmp_path).read_text(encoding="utf-8").startswith("ready")


def test_staging_file_is_scoped_to_the_writing_process(tmp_path: Path) -> None:
    # The launcher publishes status from PowerShell at the same time. A shared
    # staging name lets two correct writers collide on Windows.
    import os

    captured: list[Path] = []
    real_write_text = Path.write_text

    def record(self, *args, **kwargs):
        captured.append(self)
        return real_write_text(self, *args, **kwargs)

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(Path, "write_text", record)
        PREPARE.publish_bootstrap_status(tmp_path, "starting", "Preparing.")

    assert captured, "the status writer never staged a file"
    assert str(os.getpid()) in captured[0].name
    assert captured[0].name.endswith(".tmp")


def test_no_staging_file_is_left_behind(tmp_path: Path) -> None:
    PREPARE.publish_bootstrap_status(tmp_path, "ready", "Done.", progress=100)

    leftovers = [entry.name for entry in tmp_path.iterdir() if entry.name.endswith(".tmp")]
    assert leftovers == []
