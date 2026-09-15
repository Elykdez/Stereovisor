from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNTIME_ROOT = Path(os.environ.get("STEREOVISOR_RUNTIME_ROOT", ROOT))
VENDOR_ROOT = RUNTIME_ROOT / ".cache" / "vendor"
DA3 = VENDOR_ROOT / "depth-anything-3"
POWERPAINT = VENDOR_ROOT / "PowerPaint"
DA3_COMMIT = "3d835ec1a5802d64a8b8b15f817a1ab54809bfe4"
POWERPAINT_COMMIT = "5b4c3d52291709fcec2a1870d987da693fd3549c"
DA3_ARCHIVE_SHA256 = "a19b31f64ed11d5c38438ea0f3e0864eecc299044967026749304c3a03dcf053"
POWERPAINT_ARCHIVE_SHA256 = "b7b45ea004b88851b181b8d3cbd6e40cb15e4f8d742cc1ea5125ba68416b7de9"


def run(*arguments: str) -> None:
    subprocess.run(arguments, check=True, cwd=ROOT)


def ensure_checkout(path: Path, url: str, commit: str) -> None:
    if not (path / ".git").is_dir():
        path.parent.mkdir(parents=True, exist_ok=True)
        run("git", "clone", "--filter=blob:none", "--no-checkout", url, str(path))
    run("git", "-C", str(path), "fetch", "--depth", "1", "origin", commit)
    run("git", "-C", str(path), "checkout", "--detach", commit)


def ensure_archive(path: Path, repository: str, commit: str, sha256: str) -> None:
    """Fetch pinned sources without requiring Git on an installed desktop."""
    marker = path / ".stereovisor-source-commit"
    if marker.is_file() and marker.read_text(encoding="ascii").strip() == commit:
        return
    staging = path.with_name(f".{path.name}.extracting")
    vendor_root = VENDOR_ROOT.resolve()
    if path.resolve().parent != vendor_root or staging.resolve().parent != vendor_root:
        raise ValueError("Vendor extraction must stay inside the runtime vendor directory.")
    path.parent.mkdir(parents=True, exist_ok=True)
    archive = path.with_name(f"{path.name}-{commit}.zip")
    cached = False
    if archive.is_file():
        with archive.open("rb") as source:
            cached = hashlib.file_digest(source, "sha256").hexdigest() == sha256
    if not cached:
        partial = archive.with_suffix(".zip.partial")
        with urllib.request.urlopen(
            f"https://codeload.github.com/{repository}/zip/{commit}", timeout=120
        ) as response, partial.open("wb") as destination:
            shutil.copyfileobj(response, destination)
        with partial.open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != sha256:
            partial.unlink()
            raise RuntimeError(f"The downloaded {path.name} sources failed their checksum.")
        partial.replace(archive)
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    with zipfile.ZipFile(archive) as package:
        # GitHub wraps source archives in one repository directory. Strip that
        # component while rejecting paths that could escape our staging root.
        for member in package.infolist():
            relative = Path(*Path(member.filename).parts[1:])
            target = staging / relative
            if not target.resolve().is_relative_to(staging.resolve()):
                raise ValueError("The source archive contains an invalid path.")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with package.open(member) as source, target.open("wb") as destination:
                    shutil.copyfileobj(source, destination)
    if path.exists():
        shutil.rmtree(path)
    staging.replace(path)
    marker.write_text(commit, encoding="ascii")


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
    if os.environ.get("STEREOVISOR_RUNTIME_ROOT"):
        ensure_archive(DA3, "ByteDance-Seed/Depth-Anything-3", DA3_COMMIT, DA3_ARCHIVE_SHA256)
        ensure_archive(POWERPAINT, "open-mmlab/PowerPaint", POWERPAINT_COMMIT, POWERPAINT_ARCHIVE_SHA256)
    else:
        ensure_checkout(DA3, "https://github.com/ByteDance-Seed/Depth-Anything-3.git", DA3_COMMIT)
        ensure_checkout(POWERPAINT, "https://github.com/open-mmlab/PowerPaint.git", POWERPAINT_COMMIT)
    patch_da3_exports()
    # Install a regular wheel copy so packaged virtual environments do not keep
    # an absolute editable-install pointer back to the build machine.
    run(sys.executable, "-m", "pip", "install", "--no-deps", "--force-reinstall", str(DA3))
    print("Pinned local model runtimes are ready.")


if __name__ == "__main__":
    main()
