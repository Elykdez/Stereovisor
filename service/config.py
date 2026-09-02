from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WORKSPACE_ROOT = ROOT.parent
PROJECT_ROOT = Path(os.environ.get("STEREOVISOR_PROJECT_ROOT", ROOT / ".projects"))
MODEL_ROOT = Path(os.environ.get("STEREOVISOR_MODEL_ROOT", ROOT / ".models"))
MODE = os.environ.get("STEREOVISOR_MODE", "auto").lower()
DEVICE = os.environ.get("STEREOVISOR_DEVICE", "auto").lower()
MAX_UPLOAD_BYTES = 40 * 1024 * 1024
MAX_PROJECT_PACKAGE_BYTES = 512 * 1024 * 1024
SERVICE_ORIGIN = os.environ.get("STEREOVISOR_SERVICE_ORIGIN", "http://127.0.0.1:5179")
POWERPAINT_PYTHON = Path(
    os.environ.get("STEREOVISOR_POWERPAINT_PYTHON", WORKSPACE_ROOT / ".venv-powerpaint" / "Scripts" / "python.exe")
)
POWERPAINT_VENDOR = Path(
    os.environ.get("STEREOVISOR_POWERPAINT_VENDOR", WORKSPACE_ROOT / ".cache" / "vendor" / "PowerPaint")
)

os.environ.setdefault("HF_HOME", str(MODEL_ROOT / "huggingface-cache"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "120")
os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")


@dataclass(frozen=True)
class DependencyStatus:
    available: bool
    detail: str


def snapshot_ready(path: Path, required_files: tuple[str, ...] = ()) -> bool:
    # The sentinel prevents a merely created model directory from being
    # reported as ready; required files add a cheap, explicit integrity gate.
    return (path / ".stereovisor-ready").is_file() and all((path / name).is_file() for name in required_files)


def powerpaint_snapshot_ready(path: Path) -> bool:
    required_files = (
        "PowerPaint_Brushnet/diffusion_pytorch_model.safetensors",
        "PowerPaint_Brushnet/pytorch_model.bin",
    )
    unet_variants = (
        "realisticVisionV60B1_v51VAE/unet/diffusion_pytorch_model.bin",
        "realisticVisionV60B1_v51VAE/unet/diffusion_pytorch_model.safetensors",
    )
    return snapshot_ready(path, required_files) and any((path / name).is_file() for name in unet_variants)


def dependency_status(module: str, label: str) -> DependencyStatus:
    available = importlib.util.find_spec(module) is not None
    detail = "Installed" if available else f"Missing {label}"
    return DependencyStatus(available=available, detail=detail)


def model_dependency_status(module: str, label: str, paths: tuple[Path, ...]) -> DependencyStatus:
    module_status = dependency_status(module, label)
    missing = [path.name for path in paths if not path.exists()]
    if not module_status.available:
        return module_status
    if missing:
        return DependencyStatus(available=False, detail=f"Missing model assets: {', '.join(missing)}")
    return DependencyStatus(available=True, detail=f"{label} installed")


def ai_dependencies() -> dict[str, DependencyStatus]:
    # Health reports module presence plus local model/sentinel presence. It does
    # not instantiate models, keeping startup checks fast and side-effect free.
    powerpaint_model = MODEL_ROOT / "powerpaint-v2-1"
    qwen_model = MODEL_ROOT / "qwen3-vl-2b-instruct"
    powerpaint_runtime = POWERPAINT_PYTHON.is_file() and POWERPAINT_VENDOR.is_dir()
    qwen_ready = snapshot_ready(qwen_model, ("model.safetensors",))
    powerpaint_ready = powerpaint_snapshot_ready(powerpaint_model)
    return {
        "segmentation": model_dependency_status(
            "transformers",
            "Grounding DINO-T and SAM 2.1 Small",
            (MODEL_ROOT / "grounding-dino-tiny", MODEL_ROOT / "sam2.1-hiera-small"),
        ),
        "matting": model_dependency_status(
            "transparent_background",
            "InSPyReNet",
            (MODEL_ROOT / "inspyrenet" / "ckpt_base.pth",),
        ),
        "depth": model_dependency_status(
            "depth_anything_3",
            "Depth Anything 3 Small",
            (MODEL_ROOT / "da3-small",),
        ),
        "inpainting": model_dependency_status("torch", "Big LaMa", (MODEL_ROOT / "big-lama.pt",)),
        "prompting": DependencyStatus(
            available=qwen_ready,
            detail="Qwen3-VL 2B weights installed" if qwen_ready else "Optional Qwen3-VL weights are incomplete or not installed",
        ),
        "refinement": DependencyStatus(
            available=powerpaint_runtime and powerpaint_ready,
            detail=(
                "PowerPaint v2.1 full-redraw runtime installed"
                if powerpaint_runtime and powerpaint_ready
                else (
                    "Optional PowerPaint v2.1 weights are incomplete or not installed"
                    if powerpaint_runtime
                    else "Optional PowerPaint v2.1 runtime is not installed"
                )
            ),
        ),
    }


def production_available() -> bool:
    dependencies = ai_dependencies()
    return all(dependencies[key].available for key in ("segmentation", "matting", "depth", "inpainting"))


def active_engine() -> str:
    # Explicit mode wins. Auto mode selects AI only when all core providers are
    # ready; otherwise preview remains available with an honest health message.
    if MODE == "preview":
        return "preview"
    if MODE == "ai":
        return "ai"
    return "ai" if production_available() else "preview"


def runtime_device() -> str:
    if DEVICE == "cpu":
        return "cpu"
    try:
        import torch
    except ImportError:
        return "unavailable"
    if DEVICE == "cuda" and not torch.cuda.is_available():
        return "cuda-unavailable"
    return "cuda" if torch.cuda.is_available() else "cpu"
