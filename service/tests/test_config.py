from pathlib import Path

import service.config as config
from service.config import bootstrap_status, model_dependency_status, powerpaint_snapshot_ready


def _touch(root: Path, relative: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()


def test_powerpaint_accepts_downloaded_bin_unet(tmp_path: Path) -> None:
    _touch(tmp_path, ".stereovisor-ready")
    _touch(tmp_path, "PowerPaint_Brushnet/diffusion_pytorch_model.safetensors")
    _touch(tmp_path, "PowerPaint_Brushnet/pytorch_model.bin")
    _touch(tmp_path, "realisticVisionV60B1_v51VAE/unet/diffusion_pytorch_model.bin")

    assert powerpaint_snapshot_ready(tmp_path)


def test_powerpaint_still_requires_ready_marker(tmp_path: Path) -> None:
    _touch(tmp_path, "PowerPaint_Brushnet/diffusion_pytorch_model.safetensors")
    _touch(tmp_path, "PowerPaint_Brushnet/pytorch_model.bin")
    _touch(tmp_path, "realisticVisionV60B1_v51VAE/unet/diffusion_pytorch_model.bin")

    assert not powerpaint_snapshot_ready(tmp_path)


def test_model_dependency_status_requires_snapshot_marker_when_requested(tmp_path: Path) -> None:
    assert not model_dependency_status("json", "Test model", (tmp_path,), snapshots=True).available
    _touch(tmp_path, ".stereovisor-ready")
    assert model_dependency_status("json", "Test model", (tmp_path,), snapshots=True).available


def test_bootstrap_status_exposes_transient_state_only_while_running(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(config, "MODEL_ROOT", tmp_path)
    status = tmp_path / ".stereovisor-bootstrap-status"
    status.write_text(
        "\ufeffdownloading\nDownloading model weights.\nprovider=depth\nprogress=42",
        encoding="utf-8",
    )

    assert bootstrap_status().state == "blocked"
    (tmp_path / ".stereovisor-bootstrap-running").touch()
    assert bootstrap_status().state == "downloading"
    assert bootstrap_status().detail == "Downloading model weights."
    assert bootstrap_status().provider == "depth"
    assert bootstrap_status().progress == 42

    (tmp_path / ".stereovisor-bootstrap-running").unlink()
    status.write_text("ready\nRequired local AI models are ready.", encoding="utf-8")
    assert bootstrap_status().state == "ready"


def test_bootstrap_status_keeps_terminal_failure_after_the_marker_is_cleared(monkeypatch, tmp_path: Path) -> None:
    # A failed preparation removes its marker but must keep explaining why the
    # editor is still locked.
    monkeypatch.setattr(config, "MODEL_ROOT", tmp_path)
    (tmp_path / ".stereovisor-bootstrap-status").write_text(
        "blocked\nThe selected local AI environment cannot access CUDA.",
        encoding="utf-8",
    )

    status = bootstrap_status()

    assert status.state == "blocked"
    assert status.detail == "The selected local AI environment cannot access CUDA."


def test_bootstrap_status_reports_completed_stages(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(config, "MODEL_ROOT", tmp_path)
    (tmp_path / ".stereovisor-bootstrap-running").touch()
    (tmp_path / ".stereovisor-bootstrap-status").write_text(
        "downloading\nDownloading depth model.\nprovider=depth\nprogress=10\ncompleted=runtime,segmentation,bogus",
        encoding="utf-8",
    )

    assert bootstrap_status().completed == ("runtime", "segmentation")
