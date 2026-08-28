from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = ROOT / ".cache" / "vendor"
DA3 = VENDOR_ROOT / "depth-anything-3"
POWERPAINT = VENDOR_ROOT / "PowerPaint"
DA3_COMMIT = "3d835ec1a5802d64a8b8b15f817a1ab54809bfe4"
POWERPAINT_COMMIT = "5b4c3d52291709fcec2a1870d987da693fd3549c"


def run(*arguments: str) -> None:
    subprocess.run(arguments, check=True, cwd=ROOT)


def ensure_checkout(path: Path, url: str, commit: str) -> None:
    if not (path / ".git").is_dir():
        path.parent.mkdir(parents=True, exist_ok=True)
        run("git", "clone", "--filter=blob:none", "--no-checkout", url, str(path))
    run("git", "-C", str(path), "fetch", "--depth", "1", "origin", commit)
    run("git", "-C", str(path), "checkout", "--detach", commit)


def patch_da3_exports() -> None:
    target = DA3 / "src" / "depth_anything_3" / "utils" / "export" / "__init__.py"
    target.write_text(
        '''from __future__ import annotations

from depth_anything_3.specs import Prediction

SUPPORTED_EXPORT_FORMATS = frozenset(
    {"glb", "mini_npz", "npz", "feat_vis", "depth_vis", "gs_ply", "gs_video", "colmap"}
)


def export(prediction: Prediction, export_format: str, export_dir: str, **kwargs):
    if "-" in export_format:
        for current in export_format.split("-"):
            export(prediction, current, export_dir, **kwargs)
        return
    if export_format == "glb":
        from .glb import export_to_glb as handler
    elif export_format == "mini_npz":
        from .npz import export_to_mini_npz as handler
    elif export_format == "npz":
        from .npz import export_to_npz as handler
    elif export_format == "feat_vis":
        from .feat_vis import export_to_feat_vis as handler
    elif export_format == "depth_vis":
        from .depth_vis import export_to_depth_vis as handler
    elif export_format == "gs_ply":
        from .gs import export_to_gs_ply as handler
    elif export_format == "gs_video":
        from .gs import export_to_gs_video as handler
    elif export_format == "colmap":
        from .colmap import export_to_colmap as handler
    else:
        raise ValueError(f"Unsupported export format: {export_format}")
    handler(prediction, export_dir, **kwargs.get(export_format, {}))


__all__ = ["export"]
''',
        encoding="utf-8",
    )


def main() -> None:
    ensure_checkout(DA3, "https://github.com/ByteDance-Seed/Depth-Anything-3.git", DA3_COMMIT)
    ensure_checkout(POWERPAINT, "https://github.com/open-mmlab/PowerPaint.git", POWERPAINT_COMMIT)
    patch_da3_exports()
    run(sys.executable, "-m", "pip", "install", "--no-deps", "-e", str(DA3))
    print("Pinned local model runtimes are ready.")


if __name__ == "__main__":
    main()
