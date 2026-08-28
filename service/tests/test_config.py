from pathlib import Path

from service.config import powerpaint_snapshot_ready


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
