from __future__ import annotations

import hashlib
import importlib.util
import io
import zipfile
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "setup-vendors.py"


@pytest.fixture
def vendors(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("STEREOVISOR_RUNTIME_ROOT", str(tmp_path / "runtime"))
    spec = importlib.util.spec_from_file_location("setup_vendors", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def archive_bytes(filename: str = "upstream-commit/src/module.py") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(filename, "value = 42\n")
    return buffer.getvalue()


def serve_archive(vendors, monkeypatch, payload: bytes):
    requests = []

    def open_archive(url, timeout):
        requests.append(url)
        return io.BytesIO(payload)

    monkeypatch.setattr(vendors.urllib.request, "urlopen", open_archive)
    return requests


def test_downloaded_sources_use_runtime_root_and_need_no_git(vendors, monkeypatch):
    payload = archive_bytes()
    requests = serve_archive(vendors, monkeypatch, payload)
    target = vendors.VENDOR_ROOT / "example"

    vendors.ensure_archive(target, "owner/example", "commit", hashlib.sha256(payload).hexdigest())

    assert vendors.ROOT == SCRIPT.parents[2]
    assert target.is_relative_to(vendors.RUNTIME_ROOT)
    assert (target / "src" / "module.py").read_text() == "value = 42\n"
    assert (target / ".stereovisor-source-commit").read_text() == "commit"
    assert requests == ["https://codeload.github.com/owner/example/zip/commit"]

    vendors.ensure_archive(target, "owner/example", "commit", hashlib.sha256(payload).hexdigest())
    assert len(requests) == 1


def test_checksum_failure_preserves_installed_sources(vendors, monkeypatch):
    serve_archive(vendors, monkeypatch, archive_bytes())
    target = vendors.VENDOR_ROOT / "example"
    target.mkdir(parents=True)
    (target / "existing.py").write_text("working")

    with pytest.raises(RuntimeError, match="checksum"):
        vendors.ensure_archive(target, "owner/example", "commit", "0" * 64)

    assert (target / "existing.py").read_text() == "working"
    assert not (target / ".stereovisor-source-commit").exists()
    assert not target.with_name("example-commit.zip.partial").exists()


def test_interrupted_extraction_reuses_verified_archive(vendors, monkeypatch):
    payload = archive_bytes()
    requests = serve_archive(vendors, monkeypatch, payload)
    target = vendors.VENDOR_ROOT / "example"
    target.parent.mkdir(parents=True)
    (target.parent / "example-commit.zip").write_bytes(payload)
    staging = target.with_name(".example.extracting")
    staging.mkdir()
    (staging / "partial.txt").write_text("unfinished")

    vendors.ensure_archive(target, "owner/example", "commit", hashlib.sha256(payload).hexdigest())

    assert requests == []
    assert (target / "src" / "module.py").is_file()
    assert not (target / "partial.txt").exists()
    assert not staging.exists()


def test_source_archive_cannot_escape_staging(vendors, monkeypatch):
    payload = archive_bytes("upstream-commit/../../escape.py")
    serve_archive(vendors, monkeypatch, payload)
    target = vendors.VENDOR_ROOT / "example"

    with pytest.raises(ValueError, match="invalid path"):
        vendors.ensure_archive(target, "owner/example", "commit", hashlib.sha256(payload).hexdigest())

    assert not (target.parent / "escape.py").exists()
    assert not (target / ".stereovisor-source-commit").exists()


def test_extraction_cannot_replace_a_directory_outside_vendor_root(vendors, tmp_path):
    target = tmp_path / "unrelated"
    target.mkdir()
    (target / "keep.txt").write_text("owned by user")

    with pytest.raises(ValueError, match="runtime vendor directory"):
        vendors.ensure_archive(target, "owner/example", "commit", "0" * 64)

    assert (target / "keep.txt").read_text() == "owned by user"
