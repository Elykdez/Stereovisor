from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import shutil
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile

from PIL import Image

from .schemas import CameraPayload, LayerEditorPayload, ProjectPayload

logger = logging.getLogger(__name__)


ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
ASSET_PATTERN = re.compile(r"^[a-zA-Z0-9_.-]+$")
PACKAGE_FORMAT = "stereovisor-project"
PACKAGE_VERSION = 1
MAX_PACKAGE_FILES = 128
MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
# Windows refuses a rename while any process still holds the destination open,
# so a project record commits across a brief window rather than in one attempt.
REPLACE_ATTEMPTS = 20
REPLACE_RETRY_SECONDS = 0.05


class ProjectPackageError(ValueError):
    pass


def _asset_name(url: str | None) -> str | None:
    return Path(url).name if url else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _replace_contents(target: Path, text: str) -> None:
    """Replace a file's contents, or leave the previous contents intact.

    project.json is the authoritative record of a user's work, and a direct
    write truncates before it writes: a crash, a power loss, or a full disk
    between those two moments leaves an unreadable project and forfeits
    everything the run produced. Staging beside the target and renaming means
    the file on disk is only ever the old snapshot or the complete new one.
    """
    staging = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    try:
        staging.write_text(text, encoding="utf-8")
        # os.replace fails on Windows while another process holds the
        # destination open, which a concurrent reader does briefly. Retry before
        # giving up - but unlike diagnostic state, a lost write here has to be
        # reported rather than swallowed.
        for remaining in reversed(range(REPLACE_ATTEMPTS)):
            try:
                staging.replace(target)
                return
            except PermissionError:
                if not remaining:
                    raise
                time.sleep(REPLACE_RETRY_SECONDS)
    finally:
        # A successful rename leaves nothing to remove. A failed one must not
        # leave a staging file behind for the next reader to trip over.
        try:
            staging.unlink(missing_ok=True)
        except OSError:
            logger.warning("could not remove staged project record: path=%s", staging)


class ProjectStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self, image: Image.Image) -> tuple[str, Path]:
        # A project directory is created before expensive processing so all
        # generated assets share one validated, project-scoped root.
        project_id = uuid.uuid4().hex
        directory = self.root / project_id
        directory.mkdir(parents=False)
        image.convert("RGB").save(directory / "source.png", format="PNG")
        logger.info(
            "project created: id=%s size=%sx%s", project_id, image.width, image.height
        )
        return project_id, directory

    def directory(self, project_id: str) -> Path:
        # Reject traversal and malformed IDs before resolving any filesystem
        # path; every asset operation relies on this containment check.
        if not ID_PATTERN.fullmatch(project_id):
            raise FileNotFoundError("Unknown project")
        path = (self.root / project_id).resolve()
        if path.parent != self.root or not path.is_dir():
            raise FileNotFoundError("Unknown project")
        return path

    def asset(self, project_id: str, name: str) -> Path:
        if not ASSET_PATTERN.fullmatch(name) or Path(name).name != name:
            raise FileNotFoundError("Unknown asset")
        path = (self.directory(project_id) / name).resolve()
        if path.parent != self.directory(project_id) or not path.is_file():
            raise FileNotFoundError("Unknown asset")
        return path

    def write(self, project: ProjectPayload) -> None:
        # The serialized project is the authoritative metadata snapshot. Asset
        # files are written first, then this record is committed last.
        target = self.directory(project.id) / "project.json"
        _replace_contents(target, project.model_dump_json(indent=2))

    def read(self, project_id: str) -> ProjectPayload:
        target = self.directory(project_id) / "project.json"
        data = json.loads(target.read_text(encoding="utf-8"))
        return ProjectPayload.model_validate(data)

    def export_package(
        self,
        project_id: str,
        camera: CameraPayload,
        layer_states: list[LayerEditorPayload],
    ) -> bytes:
        # Export strips local URLs and records checksums so an imported package
        # can be verified without trusting paths supplied by the caller.
        logger.info(
            "project export packaging: id=%s requested_layers=%s",
            project_id,
            len(layer_states),
        )
        directory = self.directory(project_id)
        project = self.read(project_id)
        states = {state.id: state for state in layer_states}
        if set(states) != {layer.id for layer in project.layers}:
            logger.warning(
                "project export rejected: id=%s layer state mismatch", project_id
            )
            raise ProjectPackageError("Export state does not match the project layers")

        layers = [
            layer.model_copy(update=states[layer.id].model_dump(exclude={"id"}))
            for layer in project.layers
        ]
        portable = project.model_copy(
            update={
                "sourceUrl": _asset_name(project.sourceUrl),
                "backgroundUrl": _asset_name(project.backgroundUrl),
                "unionMaskUrl": _asset_name(project.unionMaskUrl),
                "extraMaskUrl": _asset_name(project.extraMaskUrl),
                "depthMapUrl": _asset_name(project.depthMapUrl),
                "layers": [
                    layer.model_copy(
                        update={
                            "cutoutUrl": _asset_name(layer.cutoutUrl),
                            "maskUrl": _asset_name(layer.maskUrl),
                            "proposalMaskUrl": _asset_name(layer.proposalMaskUrl),
                        }
                    )
                    for layer in layers
                ],
            }
        )
        assets = sorted(directory.glob("*.png"), key=lambda item: item.name)
        records = [
            {
                "path": f"assets/{asset.name}",
                "bytes": asset.stat().st_size,
                "sha256": _sha256(asset),
            }
            for asset in assets
        ]
        manifest = {
            "format": PACKAGE_FORMAT,
            "version": PACKAGE_VERSION,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "camera": camera.model_dump(),
            "project": portable.model_dump(),
            "assets": records,
        }

        output = io.BytesIO()
        with ZipFile(output, "w") as archive:
            archive.writestr(
                "manifest.json",
                json.dumps(manifest, indent=2),
                compress_type=ZIP_DEFLATED,
            )
            for asset in assets:
                archive.write(asset, f"assets/{asset.name}", compress_type=ZIP_STORED)
        package = output.getvalue()
        logger.info(
            "project export packaged: id=%s assets=%s bytes=%s",
            project_id,
            len(assets),
            len(package),
        )
        return package

    def import_package(self, data: bytes) -> tuple[ProjectPayload, CameraPayload]:
        logger.info("project import verifying: bytes=%s", len(data))
        try:
            archive = ZipFile(io.BytesIO(data), "r")
        except BadZipFile as error:
            raise ProjectPackageError(
                "The selected file is not a valid Stereovisor project"
            ) from error

        with archive:
            files = [entry for entry in archive.infolist() if not entry.is_dir()]
            names = [entry.filename for entry in files]
            # The allowlist and size limits run before extraction to prevent zip
            # bombs, duplicate names, and undeclared files from reaching disk.
            if len(files) > MAX_PACKAGE_FILES or len(names) != len(set(names)):
                raise ProjectPackageError(
                    "The project package has an invalid file list"
                )
            if sum(entry.file_size for entry in files) > MAX_UNCOMPRESSED_BYTES:
                raise ProjectPackageError("The expanded project package is too large")
            if "manifest.json" not in names:
                raise ProjectPackageError("The project package has no manifest.json")
            if archive.getinfo("manifest.json").file_size > MAX_MANIFEST_BYTES:
                raise ProjectPackageError("The project manifest is too large")
            try:
                manifest = json.loads(archive.read("manifest.json"))
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise ProjectPackageError(
                    "The project manifest is not valid JSON"
                ) from error
            if (
                manifest.get("format") != PACKAGE_FORMAT
                or manifest.get("version") != PACKAGE_VERSION
            ):
                raise ProjectPackageError(
                    "This Stereovisor project version is not supported"
                )

            try:
                camera = CameraPayload.model_validate(manifest["camera"])
                portable = ProjectPayload.model_validate(manifest["project"])
                records = manifest["assets"]
            except (KeyError, TypeError, ValueError) as error:
                raise ProjectPackageError(
                    "The project manifest is incomplete or invalid"
                ) from error
            if not isinstance(records, list) or not records:
                raise ProjectPackageError(
                    "The project package contains no image assets"
                )

            declared: dict[str, dict] = {}
            for record in records:
                if not isinstance(record, dict):
                    raise ProjectPackageError("The project asset list is invalid")
                package_path = record.get("path")
                if not isinstance(package_path, str) or not package_path.startswith(
                    "assets/"
                ):
                    raise ProjectPackageError(
                        "The project contains an unsafe asset path"
                    )
                name = package_path.removeprefix("assets/")
                if (
                    not ASSET_PATTERN.fullmatch(name)
                    or Path(name).name != name
                    or not name.endswith(".png")
                ):
                    raise ProjectPackageError(
                        "The project contains an unsafe asset name"
                    )
                if package_path not in names or name in declared:
                    raise ProjectPackageError(
                        "A declared project asset is missing or duplicated"
                    )
                declared[name] = record
            declared_paths = {"manifest.json"} | {f"assets/{name}" for name in declared}
            if set(names) != declared_paths:
                raise ProjectPackageError(
                    "The project package contains undeclared files"
                )

            references = {
                name
                for name in (
                    _asset_name(portable.sourceUrl),
                    _asset_name(portable.backgroundUrl),
                    _asset_name(portable.unionMaskUrl),
                    _asset_name(portable.extraMaskUrl),
                    _asset_name(portable.depthMapUrl),
                    *(_asset_name(layer.cutoutUrl) for layer in portable.layers),
                    *(_asset_name(layer.maskUrl) for layer in portable.layers),
                    *(_asset_name(layer.proposalMaskUrl) for layer in portable.layers),
                )
                if name
            }
            if not references.issubset(declared):
                raise ProjectPackageError(
                    "The project manifest references missing image assets"
                )

            project_id = uuid.uuid4().hex
            # Verify every asset in an isolated staging directory. The final
            # replace below is atomic, so failed imports never create partial
            # live projects.
            with tempfile.TemporaryDirectory(
                prefix=".import-", dir=self.root
            ) as temporary:
                staging = Path(temporary)
                for name, record in declared.items():
                    expected_bytes = record.get("bytes")
                    expected_sha = record.get("sha256")
                    if (
                        not isinstance(expected_bytes, int)
                        or expected_bytes < 1
                        or not isinstance(expected_sha, str)
                        or not re.fullmatch(r"[a-f0-9]{64}", expected_sha)
                    ):
                        raise ProjectPackageError("A project asset checksum is invalid")
                    if archive.getinfo(f"assets/{name}").file_size != expected_bytes:
                        raise ProjectPackageError(
                            f"Project asset size does not match its manifest: {name}"
                        )
                    source = archive.open(f"assets/{name}")
                    target = staging / name
                    with source, target.open("wb") as destination:
                        shutil.copyfileobj(source, destination, length=4 * 1024 * 1024)
                    if (
                        target.stat().st_size != expected_bytes
                        or _sha256(target) != expected_sha
                    ):
                        raise ProjectPackageError(
                            f"Project asset verification failed: {name}"
                        )
                    try:
                        with Image.open(target) as image:
                            image.verify()
                    except OSError as error:
                        raise ProjectPackageError(
                            f"Project asset is not a valid PNG: {name}"
                        ) from error

                source_name = _asset_name(portable.sourceUrl)
                if not source_name:
                    raise ProjectPackageError(
                        "The project manifest has no source image"
                    )
                with Image.open(staging / source_name) as source_image:
                    if source_image.size != (portable.width, portable.height):
                        raise ProjectPackageError(
                            "The source image dimensions do not match the project manifest"
                        )

                def restored_url(value: str | None) -> str | None:
                    name = _asset_name(value)
                    return asset_url(project_id, name) if name else None

                restored = portable.model_copy(
                    update={
                        "id": project_id,
                        "sourceUrl": restored_url(portable.sourceUrl),
                        "backgroundUrl": restored_url(portable.backgroundUrl),
                        "unionMaskUrl": restored_url(portable.unionMaskUrl),
                        "extraMaskUrl": restored_url(portable.extraMaskUrl),
                        "depthMapUrl": restored_url(portable.depthMapUrl),
                        "layers": [
                            layer.model_copy(
                                update={
                                    "cutoutUrl": restored_url(layer.cutoutUrl),
                                    "maskUrl": restored_url(layer.maskUrl),
                                    "proposalMaskUrl": restored_url(
                                        layer.proposalMaskUrl
                                    ),
                                }
                            )
                            for layer in portable.layers
                        ],
                    }
                )
                (staging / "project.json").write_text(
                    restored.model_dump_json(indent=2), encoding="utf-8"
                )
                staging.replace(self.root / project_id)
            logger.info(
                "project import verified: id=%s assets=%s bytes=%s",
                project_id,
                len(declared),
                len(data),
            )
            return restored, camera


def asset_url(project_id: str, name: str) -> str:
    return f"/api/projects/{project_id}/assets/{name}"
