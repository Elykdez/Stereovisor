"""project.json is the authoritative record of a user's work.

A direct write truncates before it writes, so a crash, a power loss, or a full
disk between those two moments would leave an unreadable project and forfeit
everything the run produced. The record has to commit whole or not at all.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

import service.src.storage as storage
from service.src.schemas import CameraPayload, ProjectPayload
from service.src.storage import ProjectStore


@pytest.fixture
def stored(tmp_path: Path) -> tuple[ProjectStore, str, Path]:
    store = ProjectStore(tmp_path)
    project_id, directory = store.create(Image.new("RGB", (8, 8), "white"))
    store.write(_project(project_id, "first"))
    return store, project_id, directory


def _project(project_id: str, note: str) -> ProjectPayload:
    return ProjectPayload(
        id=project_id,
        width=8,
        height=8,
        sourceUrl=f"/api/projects/{project_id}/assets/source.png",
        engine="preview",
        layers=[],
        backgroundPrompt=note,
    )


def _record(directory: Path) -> dict:
    return json.loads((directory / "project.json").read_text(encoding="utf-8"))


def test_a_project_record_round_trips(stored) -> None:
    store, project_id, directory = stored

    store.write(_project(project_id, "second"))

    assert _record(directory)["backgroundPrompt"] == "second"
    assert store.read(project_id).backgroundPrompt == "second"


def test_a_write_that_cannot_commit_leaves_the_previous_record_intact(
    stored, monkeypatch
) -> None:
    store, project_id, directory = stored
    monkeypatch.setattr(storage, "REPLACE_ATTEMPTS", 2)
    monkeypatch.setattr(storage, "REPLACE_RETRY_SECONDS", 0)

    def refuse(self, target):
        raise PermissionError(32, "The process cannot access the file")

    monkeypatch.setattr(Path, "replace", refuse)

    with pytest.raises(PermissionError):
        store.write(_project(project_id, "second"))

    # The old snapshot survives; a half-written file would raise here instead.
    assert _record(directory)["backgroundPrompt"] == "first"
    assert store.read(project_id).backgroundPrompt == "first"


def test_a_transient_lock_is_retried_rather_than_failing_the_write(
    stored, monkeypatch
) -> None:
    store, project_id, directory = stored
    monkeypatch.setattr(storage, "REPLACE_RETRY_SECONDS", 0)
    real_replace = Path.replace
    attempts = {"count": 0}

    def flaky(self, target):
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise PermissionError(32, "The process cannot access the file")
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", flaky)

    store.write(_project(project_id, "second"))

    assert attempts["count"] == 3
    assert _record(directory)["backgroundPrompt"] == "second"


def test_no_staging_file_is_left_behind(stored, monkeypatch) -> None:
    store, project_id, directory = stored
    store.write(_project(project_id, "second"))
    monkeypatch.setattr(storage, "REPLACE_ATTEMPTS", 1)
    monkeypatch.setattr(storage, "REPLACE_RETRY_SECONDS", 0)

    def refuse(self, target):
        raise PermissionError(32, "The process cannot access the file")

    monkeypatch.setattr(Path, "replace", refuse)
    with pytest.raises(PermissionError):
        store.write(_project(project_id, "third"))

    leftovers = [entry.name for entry in directory.iterdir() if entry.name.endswith(".tmp")]
    assert leftovers == []


def test_a_staged_record_is_never_exported_as_an_asset(stored) -> None:
    # Export globs *.png, so a staging file cannot be packaged even if one
    # outlived its writer. Pinned because the staging name sits in the same
    # directory the exporter walks.
    store, project_id, directory = stored
    (directory / "project.json.999.tmp").write_text("{}", encoding="utf-8")

    package = store.export_package(project_id, _camera(), [])

    assert b"project.json.999.tmp" not in package


def _camera() -> CameraPayload:
    return CameraPayload(x=0.0, y=0.0, zoom=1.0, strength=1.0)


def test_legacy_camera_state_defaults_to_a_sharp_near_focus() -> None:
    camera = CameraPayload.model_validate(
        {"x": 0.0, "y": 0.0, "zoom": 1.0, "strength": 68.0}
    )

    assert camera.depthOfField == 0.0
    assert camera.focusDepth == 1.0
    assert camera.inverseDepth is False
