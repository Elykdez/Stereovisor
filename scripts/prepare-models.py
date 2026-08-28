from __future__ import annotations

import hashlib
import fnmatch
import os
import shutil
import subprocess
import sys
import time
from urllib.parse import quote
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from service.config import MODEL_ROOT  # noqa: E402
from service.ai_models import (  # noqa: E402
    DA3_ID,
    DA3_PATH,
    GROUNDING_DINO_ID,
    GROUNDING_DINO_PATH,
    POWERPAINT_PATH,
    QWEN_ID,
    QWEN_PATH,
    SAM2_ID,
    SAM2_PATH,
)
from service.pipeline import (  # noqa: E402
    INSPYRENET_MODEL_MD5,
    INSPYRENET_MODEL_URL,
    LAMA_MD5,
    LAMA_URL,
    _download_with_resume,
)


def file_md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_verified_model(path: Path, url: str, expected_md5: str) -> None:
    if path.is_file() and file_md5(path) == expected_md5:
        print(f"Ready: {path.name}")
        return
    if path.exists():
        path.unlink()
    print(f"Downloading: {path.name}")
    _download_with_resume(url, path, expected_md5)
    print(f"Ready: {path.name}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resume_seed(path: Path, sha256: str, part: Path, total: int) -> None:
    if part.is_file() or not sha256:
        return
    cache = path / ".cache" / "huggingface" / "download"
    candidates = sorted(cache.glob(f"*.{sha256}.incomplete"), key=lambda item: item.stat().st_size, reverse=True)
    if candidates and candidates[0].stat().st_size <= total:
        candidates[0].replace(part)


def _download_lfs_file(repo_id: str, filename: str, path: Path, total: int, sha256: str) -> None:
    target = (path / filename).resolve()
    if path.resolve() not in target.parents:
        raise RuntimeError(f"Unsafe model path in {repo_id}: {filename}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size == total and _sha256(target) == sha256:
        return
    target.unlink(missing_ok=True)
    part = target.with_suffix(f"{target.suffix}.part")
    _resume_seed(path, sha256, part, total)
    if part.is_file() and part.stat().st_size > total:
        part.unlink()
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("curl is required for resumable model downloads")
    url = f"https://huggingface.co/{repo_id}/resolve/main/{quote(filename, safe='/')}"
    chunk_bytes = 8 * 1024 * 1024
    stalled_attempts = 0
    while (part.stat().st_size if part.is_file() else 0) < total:
        offset = part.stat().st_size if part.is_file() else 0
        end = min(total - 1, offset + chunk_bytes - 1)
        chunk_path = part.with_suffix(f"{part.suffix}.chunk")
        chunk_path.unlink(missing_ok=True)
        completed = subprocess.run(
            [
                curl,
                "-L",
                "--fail",
                "--silent",
                "--show-error",
                "--connect-timeout", "30",
                "--max-time", "300",
                "--range", f"{offset}-{end}",
                "--output", str(chunk_path),
                "--write-out", "%{http_code}",
                url,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        expected = end - offset + 1
        received = chunk_path.stat().st_size if chunk_path.is_file() else 0
        http_status = completed.stdout.strip()
        if http_status == "206" and 0 < received <= expected:
            # A timed-out range still contains a valid contiguous prefix. Keep it
            # so slow connections never retransmit bytes they already received.
            with part.open("ab") as output, chunk_path.open("rb") as source:
                shutil.copyfileobj(source, output, length=4 * 1024 * 1024)
            chunk_path.unlink()
            stalled_attempts = 0
            percent = part.stat().st_size * 100.0 / total
            print(f"  {filename}: {percent:5.1f}%", flush=True)
            continue

        chunk_path.unlink(missing_ok=True)
        stalled_attempts += 1
        if stalled_attempts >= 5:
            detail = completed.stderr.strip() or f"HTTP {http_status or 'unknown'}"
            raise RuntimeError(
                f"Download failed for {repo_id}/{filename} at {offset} bytes "
                f"after {stalled_attempts} attempts: {detail}"
            )
        detail = completed.stderr.strip() or f"HTTP {http_status or 'unknown'}"
        print(f"  Connection stalled; retrying ({stalled_attempts}/5): {detail}", flush=True)
        time.sleep(2)
    if _sha256(part) != sha256:
        raise RuntimeError(f"SHA-256 verification failed for {repo_id}/{filename}")
    part.replace(target)


def ensure_snapshot(repo_id: str, path: Path, allow_patterns: list[str] | None = None) -> None:
    from huggingface_hub import HfApi, hf_hub_download

    if (path / ".stereovisor-ready").is_file():
        print(f"Ready: {repo_id}")
        return
    print(f"Downloading: {repo_id}")
    path.mkdir(parents=True, exist_ok=True)
    siblings = HfApi().model_info(repo_id, files_metadata=True).siblings
    for sibling in siblings:
        filename = sibling.rfilename
        if allow_patterns and not any(fnmatch.fnmatch(filename, pattern) for pattern in allow_patterns):
            continue
        lfs_sha = getattr(sibling.lfs, "sha256", None) if sibling.lfs else None
        if lfs_sha and sibling.size:
            _download_lfs_file(repo_id, filename, path, int(sibling.size), lfs_sha)
        else:
            hf_hub_download(repo_id=repo_id, filename=filename, local_dir=path)
    (path / ".stereovisor-ready").write_text(repo_id, encoding="utf-8")
    print(f"Ready: {repo_id}")


def validate_lama(path: Path) -> None:
    import torch

    model = torch.jit.load(str(path), map_location="cpu").eval()
    del model


def validate_inspyrenet(path: Path) -> None:
    import torch

    state = torch.load(str(path), map_location="cpu", weights_only=True)
    if not isinstance(state, dict) or not state:
        raise RuntimeError("InSPyReNet checkpoint did not contain a model state dictionary")
    del state


def main() -> None:
    model_root = Path(os.environ.get("STEREOVISOR_MODEL_ROOT", MODEL_ROOT))
    model_root.mkdir(parents=True, exist_ok=True)

    lama_path = model_root / "big-lama.pt"
    inspyrenet_path = model_root / "inspyrenet" / "ckpt_base.pth"

    transformer_assets = ["*.json", "*.txt", "*.model", "*.safetensors", "*.py"]
    ensure_snapshot(GROUNDING_DINO_ID, GROUNDING_DINO_PATH, transformer_assets)
    ensure_snapshot(SAM2_ID, SAM2_PATH, transformer_assets)
    ensure_snapshot(DA3_ID, DA3_PATH, transformer_assets)
    ensure_verified_model(lama_path, LAMA_URL, LAMA_MD5)
    ensure_verified_model(inspyrenet_path, INSPYRENET_MODEL_URL, INSPYRENET_MODEL_MD5)

    if os.environ.get("STEREOVISOR_SKIP_HQ", "0") != "1":
        ensure_snapshot(QWEN_ID, QWEN_PATH, transformer_assets)
        ensure_snapshot("JunhaoZhuang/PowerPaint-v2-1", POWERPAINT_PATH)

    print("Validating local model files...")
    validate_lama(lama_path)
    validate_inspyrenet(inspyrenet_path)
    print(f"All local models are ready in {model_root}")


if __name__ == "__main__":
    main()
