import io
import json
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import service.src.app as service_module
from service.src import pipeline
from service.src.app import app
from service.src.config import BootstrapStatus
from service.src.jobs import JobCancelled, ProcessingJobStore
from service.src.storage import ProjectStore

client = TestClient(app)


def png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _completed_job(response) -> dict:
    assert response.status_code == 200
    job_id = response.json()["jobId"]
    assert service_module.job_queue.join(120)
    return client.get(f"/api/jobs/{job_id}").json()


def _completed_project(response) -> dict:
    payload = _completed_job(response)
    assert payload["state"] == "completed", payload["message"]
    assert payload["result"] is not None
    return payload["result"]


def _sample_project() -> dict:
    return _completed_project(client.post("/api/jobs/sample"))


def _inpaint_project(project_id: str, layer_ids: list[str]) -> dict:
    return _completed_project(
        client.post(
            f"/api/jobs/projects/{project_id}/inpaint",
            json={"layerIds": layer_ids},
        )
    )


def test_health_declares_local_engine() -> None:
    response = client.get("/api/health")
    payload = response.json()

    assert response.status_code == 200
    assert payload["localOnly"] is True
    assert payload["activeEngine"] in {"preview", "ai"}
    assert payload["startupState"] in {
        "starting",
        "downloading",
        "initializing",
        "ready",
        "blocked",
    }
    assert payload["startupProgress"] is None or 0 <= payload["startupProgress"] <= 100
    assert ": ." not in payload["message"]


def test_remote_http_requires_the_configured_bearer_token(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "SERVICE_HOST", "0.0.0.0")
    monkeypatch.setattr(
        service_module, "SERVICE_AUTH_TOKEN", "correct-horse-battery-staple"
    )

    missing = client.get("/api/health")
    wrong = client.get("/api/health", headers={"Authorization": "Bearer wrong-token"})
    accepted = client.get(
        "/api/health",
        headers={"Authorization": "Bearer correct-horse-battery-staple"},
    )

    assert missing.status_code == 401
    assert missing.json()["detail"]["code"] == "AUTH_REQUIRED"
    assert missing.headers["www-authenticate"] == "Bearer"
    assert wrong.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["localOnly"] is False


def test_remote_http_allows_browser_authorization_preflight(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "SERVICE_HOST", "0.0.0.0")
    monkeypatch.setattr(
        service_module, "SERVICE_AUTH_TOKEN", "correct-horse-battery-staple"
    )

    response = client.options(
        "/api/health",
        headers={
            "Origin": "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )

    assert response.status_code == 200
    assert "authorization" in response.headers["access-control-allow-headers"].lower()


def _preparing_dependencies() -> dict[str, object]:
    return {
        "runtime": service_module.ProviderStatus(
            available=False, detail="Missing local AI runtime packages: PyTorch"
        ),
        "segmentation": service_module.ProviderStatus(
            available=False, detail="Missing model assets"
        ),
        "matting": service_module.ProviderStatus(
            available=True, detail="InSPyReNet installed"
        ),
        "depth": service_module.ProviderStatus(
            available=False, detail="Missing model assets"
        ),
        "inpainting": service_module.ProviderStatus(
            available=False, detail="Missing model assets"
        ),
        "prompting": service_module.ProviderStatus(available=False, detail="Optional"),
        "refinement": service_module.ProviderStatus(available=False, detail="Optional"),
    }


def test_health_reports_active_bootstrap_provider_progress(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "ai_dependencies", _preparing_dependencies)
    monkeypatch.setattr(service_module, "active_engine", lambda _probe=None: "preview")
    monkeypatch.setattr(service_module, "runtime_device", lambda: "cuda")
    monkeypatch.setattr(
        service_module,
        "bootstrap_status",
        lambda: BootstrapStatus("downloading", "Downloading DA3 (42%).", "depth", 42),
    )

    payload = client.get("/api/health").json()

    assert payload["startupState"] == "downloading"
    assert payload["startupProvider"] == "depth"
    assert payload["startupProgress"] == 42
    assert payload["providers"]["depth"]["state"] == "downloading"
    assert payload["providers"]["depth"]["progress"] == 42
    assert payload["providers"]["segmentation"]["state"] == "waiting"
    assert payload["providers"]["matting"]["state"] == "ready"


def test_health_reports_stages_the_running_bootstrap_already_finished(
    monkeypatch,
) -> None:
    # The core-only service that answers during preparation cannot import the
    # AI packages, so a finished stage is only visible through the bootstrap.
    monkeypatch.setattr(service_module, "ai_dependencies", _preparing_dependencies)
    monkeypatch.setattr(service_module, "active_engine", lambda _probe=None: "preview")
    monkeypatch.setattr(service_module, "runtime_device", lambda: "cuda")
    monkeypatch.setattr(
        service_module,
        "bootstrap_status",
        lambda: BootstrapStatus(
            "downloading", "Downloading DA3 (42%).", "depth", 42, ("runtime",)
        ),
    )

    payload = client.get("/api/health").json()

    assert payload["providers"]["runtime"]["state"] == "ready"
    assert payload["providers"]["runtime"]["progress"] == 100
    assert payload["providers"]["runtime"]["available"] is False


def test_upload_rejects_decompression_bomb_as_a_client_error(monkeypatch) -> None:
    def raise_bomb(_stream):
        raise Image.DecompressionBombError("image dimensions are unsafe")

    monkeypatch.setattr(service_module.Image, "open", raise_bomb)
    response = client.post(
        "/api/jobs/analyze",
        files={"file": ("scene.png", b"not-used", "image/png")},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "DECODE_FAILED"


def test_analyze_downsamples_oversized_source_preserving_aspect_ratio(
    monkeypatch,
) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    # Reuse the structured preview fixture so the test reaches project storage
    # instead of being rejected for having no distinct color regions.
    source = pipeline.create_sample_image().resize(
        (4096, 1600), Image.Resampling.BICUBIC
    )

    response = client.post(
        "/api/jobs/analyze",
        files={"file": ("wide.png", png_bytes(source), "image/png")},
    )

    assert response.status_code == 200
    project = _completed_project(response)
    assert (project["width"], project["height"]) == (3200, 1250)
    stored = client.get(project["sourceUrl"])
    assert stored.status_code == 200
    with Image.open(io.BytesIO(stored.content)) as saved:
        assert saved.size == (3200, 1250)


def test_sample_to_inpaint_api_flow(monkeypatch) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project = _sample_project()

    assert len(project["layers"]) >= 2

    layer_ids = [layer["id"] for layer in project["layers"][:2]]
    for layer_id in layer_ids:
        confirmed = client.post(
            f"/api/projects/{project['id']}/layers/{layer_id}/confirm"
        )
        assert confirmed.status_code == 200
    result = _inpaint_project(project["id"], layer_ids)

    assert result["backgroundUrl"].endswith("background.png")
    asset_response = client.get(result["backgroundUrl"])
    assert asset_response.status_code == 200
    assert asset_response.headers["content-type"] == "image/png"


def test_analyze_job_waits_for_ai_readiness_before_enqueueing(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "active_engine", lambda _probe=None: "ai")
    monkeypatch.setattr(
        service_module, "production_available", lambda _probe=None: False
    )
    monkeypatch.setattr(
        service_module,
        "ai_dependencies",
        lambda: {
            key: service_module.ProviderStatus(available=False, detail="starting")
            for key in service_module.REQUIRED_PROVIDERS
        },
    )

    response = client.post(
        "/api/jobs/analyze",
        files={
            "file": (
                "scene.png",
                png_bytes(pipeline.create_sample_image()),
                "image/png",
            )
        },
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "AI_STACK_STARTING"


def _brushed_mask(project: dict) -> bytes:
    mask = Image.new("L", (project["width"], project["height"]), 0)
    ImageDraw.Draw(mask).rectangle((40, 40, 240, 240), fill=255)
    return png_bytes(mask.convert("RGB"))


def test_brushed_area_becomes_a_named_layer(monkeypatch) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project = _sample_project()

    created = client.post(
        f"/api/projects/{project['id']}/layers",
        files={"file": ("area.png", _brushed_mask(project), "image/png")},
        data={"name": "  Snow   drift  "},
    )
    payload = created.json()

    assert created.status_code == 200
    assert len(payload["layers"]) == len(project["layers"]) + 1
    added = payload["layers"][-1]
    # Whitespace is collapsed so the name cannot break the list or the manifest.
    assert added["name"] == "Snow drift"
    assert added["kind"] == "manual"
    assert added["id"] not in {layer["id"] for layer in project["layers"]}
    assert added["order"] > max(layer["order"] for layer in project["layers"])
    assert client.get(added["maskUrl"]).status_code == 200
    assert client.get(added["cutoutUrl"]).status_code == 200


def test_created_layer_without_a_name_gets_the_next_area_number(monkeypatch) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project = _sample_project()

    created = client.post(
        f"/api/projects/{project['id']}/layers",
        files={"file": ("area.png", _brushed_mask(project), "image/png")},
    ).json()

    # Naming is optional: an unnamed brush still lands as an identifiable layer.
    added = created["layers"][-1]
    assert added["name"] == f"Area {len(project['layers']) + 1:02d}"


def test_created_layer_rejects_an_empty_brush(monkeypatch) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project = _sample_project()
    blank = Image.new("RGB", (project["width"], project["height"]), (0, 0, 0))

    response = client.post(
        f"/api/projects/{project['id']}/layers",
        files={"file": ("area.png", png_bytes(blank), "image/png")},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "LAYER_CREATE_FAILED"


def test_layer_rename_persists_and_rejects_blank_names(monkeypatch) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project = _sample_project()
    layer_id = project["layers"][0]["id"]

    renamed = client.post(
        f"/api/projects/{project['id']}/layers/{layer_id}/name",
        json={"name": "Lantern"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["layers"][0]["name"] == "Lantern"

    reloaded = client.post(
        f"/api/projects/{project['id']}/layers/{layer_id}/confirm"
    ).json()
    assert reloaded["layers"][0]["name"] == "Lantern"
    assert (
        client.post(
            f"/api/projects/{project['id']}/layers/{layer_id}/name",
            json={"name": "   "},
        ).status_code
        == 422
    )


def test_layer_delete_removes_assets_and_stays_undoable(monkeypatch) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project = _sample_project()
    doomed = project["layers"][0]

    deleted = client.post(f"/api/projects/{project['id']}/layers/{doomed['id']}/delete")
    payload = deleted.json()

    assert deleted.status_code == 200
    assert doomed["id"] not in {layer["id"] for layer in payload["layers"]}
    assert client.get(doomed["maskUrl"]).status_code == 404

    # Deletion destroys image assets, so it shares the reversible layer history.
    restored = client.post(f"/api/projects/{project['id']}/layers/undo-merge")
    assert restored.status_code == 200
    assert doomed["id"] in {layer["id"] for layer in restored.json()["layers"]}
    assert client.get(doomed["maskUrl"]).status_code == 200


def test_sample_layer_merge_api_supports_history(monkeypatch) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project = _sample_project()
    layer_ids = [layer["id"] for layer in project["layers"][:2]]

    merged_response = client.post(
        f"/api/projects/{project['id']}/layers/merge",
        json={"layerIds": layer_ids},
    )
    assert merged_response.status_code == 200
    merged = merged_response.json()
    assert len(merged["layers"]) == len(project["layers"]) - 1
    history = client.get(f"/api/projects/{project['id']}/layer-merge-history")
    assert history.status_code == 200
    assert history.json() == [{"targetId": "layers", "canUndo": True, "canRedo": False}]

    undone_response = client.post(f"/api/projects/{project['id']}/layers/undo-merge")
    assert undone_response.status_code == 200
    assert len(undone_response.json()["layers"]) == len(project["layers"])

    redone_response = client.post(f"/api/projects/{project['id']}/layers/redo-merge")
    assert redone_response.status_code == 200
    assert len(redone_response.json()["layers"]) == len(merged["layers"])


def test_processing_job_reports_completion() -> None:
    started = client.post("/api/jobs/sample")
    job_id = started.json()["jobId"]

    # Jobs are handed to a worker instead of running inline, so wait for the
    # queue to drain rather than assuming the POST already did the work.
    assert service_module.job_queue.join(120)
    status = client.get(f"/api/jobs/{job_id}")
    payload = status.json()

    assert started.status_code == 200
    assert status.status_code == 200
    assert payload["state"] == "completed"
    assert payload["progress"] == 100
    assert payload["result"]["layers"]


def test_processing_job_can_be_cancelled_before_worker_starts() -> None:
    job_id = service_module.jobs.create("analyze")

    response = client.post(f"/api/jobs/{job_id}/cancel")
    payload = response.json()

    assert response.status_code == 200
    assert payload["state"] == "cancelled"
    assert payload["stage"] == "Cancelled"
    assert client.get(f"/api/jobs/{job_id}").json()["state"] == "cancelled"


def test_cancelled_job_rejects_later_worker_updates() -> None:
    job_store = ProcessingJobStore()
    job_id = job_store.create("inpaint")

    cancelled = job_store.cancel(job_id)

    assert cancelled.state == "cancelled"
    with pytest.raises(JobCancelled):
        job_store.ensure_active(job_id)
    with pytest.raises(JobCancelled):
        job_store.update(job_id, 50, "Working", "Should not run")


def test_worker_honors_cancel_request_before_commit() -> None:
    job_id = service_module.jobs.create("inpaint")

    def operation(progress, cancelled):
        progress(20, "Working", "Preparing a cancellable test.")
        service_module.jobs.cancel(job_id)
        cancelled()
        raise AssertionError("cancelled worker continued past its cancellation check")

    service_module._run_job(job_id, operation)

    payload = service_module.jobs.read(job_id)
    assert payload.state == "cancelled"
    assert payload.result is None


def test_inpaint_requires_confirmed_masks(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = _sample_project()

    response = client.post(
        f"/api/jobs/projects/{project['id']}/inpaint",
        json={"layerIds": [project["layers"][0]["id"]]},
    )
    payload = _completed_job(response)

    assert payload["state"] == "failed"
    assert "Confirm every selected mask" in payload["message"]


def test_refine_job_targets_one_layer(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = _sample_project()
    target_id = project["layers"][0]["id"]

    class FakeRefiner:
        def refine(self, payload, _directory, layer_id, progress=None, cancelled=None):
            assert layer_id == target_id
            if progress is not None:
                progress(60, "Refining mask", "Testing one local layer.")
            return payload.model_copy(
                update={
                    "layers": [
                        (
                            layer.model_copy(update={"refinementState": "refined"})
                            if layer.id == layer_id
                            else layer
                        )
                        for layer in payload.layers
                    ]
                }
            )

    monkeypatch.setattr(service_module, "_pipeline", lambda: FakeRefiner())
    started = client.post(
        f"/api/jobs/projects/{project['id']}/layers/{target_id}/refine"
    )
    assert service_module.job_queue.join(120)
    status = client.get(f"/api/jobs/{started.json()['jobId']}").json()

    assert started.status_code == 200
    assert status["kind"] == "refine"
    assert status["state"] == "completed"
    assert status["result"]["layers"][0]["refinementState"] == "refined"


def test_target_inpaint_job_receives_composition_mask_and_target(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = _sample_project()
    size = (project["width"], project["height"])

    class FakeTargetInpainter:
        def inpaint_target(
            self,
            _payload,
            _directory,
            target_id,
            composition,
            mask,
            prompt=None,
            progress=None,
            cancelled=None,
            steps=25,
        ):
            assert target_id == project["layers"][0]["id"]
            assert composition.size == size
            assert mask.size == size
            assert prompt == "new painted detail"
            assert steps == 12
            if progress is not None:
                progress(70, "Inpainting layer", "Testing target inpaint.")
            return _payload

    monkeypatch.setattr(service_module, "_pipeline", lambda: FakeTargetInpainter())
    started = client.post(
        f"/api/jobs/projects/{project['id']}/targets/{project['layers'][0]['id']}/inpaint",
        files={
            "composition": (
                "composition.png",
                png_bytes(Image.new("RGB", size, "white")),
                "image/png",
            ),
            "mask": ("mask.png", png_bytes(Image.new("L", size, 255)), "image/png"),
        },
        data={"prompt": "new painted detail", "steps": "12"},
    )
    assert service_module.job_queue.join(120)
    status = client.get(f"/api/jobs/{started.json()['jobId']}").json()

    assert started.status_code == 200
    assert status["kind"] == "inpaint"
    assert status["state"] == "completed"


def test_target_inpaint_history_api_restores_the_focused_asset(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project_store = ProjectStore(tmp_path)
    monkeypatch.setattr(service_module, "store", project_store)
    project = _sample_project()
    layer_id = project["layers"][0]["id"]
    assert (
        client.post(
            f"/api/projects/{project['id']}/layers/{layer_id}/confirm"
        ).status_code
        == 200
    )
    built = _inpaint_project(project["id"], [layer_id])
    directory = project_store.directory(project["id"])
    payload = project_store.read(project["id"])
    background_path = directory / "background.png"
    original = background_path.read_bytes()
    pipeline.record_inpaint_history(payload, directory, "background")
    Image.new("RGB", (built["width"], built["height"]), "blue").save(background_path)

    history = client.get(f"/api/projects/{project['id']}/inpaint-history")
    assert history.status_code == 200
    background = next(
        state for state in history.json() if state["targetId"] == "background"
    )
    assert background == {"targetId": "background", "canUndo": True, "canRedo": False}

    undone = client.post(
        f"/api/projects/{project['id']}/targets/background/undo-inpaint"
    )
    assert undone.status_code == 200
    assert background_path.read_bytes() == original
    redone = client.post(
        f"/api/projects/{project['id']}/targets/background/redo-inpaint"
    )
    assert redone.status_code == 200
    assert Image.open(background_path).convert("RGB").getpixel((0, 0)) == (0, 0, 255)


def test_rejects_unsupported_upload() -> None:
    response = client.post(
        "/api/jobs/analyze",
        files={"file": ("not-image.txt", b"not an image", "text/plain")},
    )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "UNSUPPORTED_IMAGE"


def test_brush_masks_update_cutout_and_expand_inpainting(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = _sample_project()
    size = (project["width"], project["height"])
    layer = project["layers"][0]

    object_mask = Image.new("L", size)
    ImageDraw.Draw(object_mask).rectangle((30, 30, 110, 110), fill=255)
    edited_layer = client.post(
        f"/api/projects/{project['id']}/layers/{layer['id']}/mask",
        files={"file": ("mask.png", png_bytes(object_mask), "image/png")},
    )

    assert edited_layer.status_code == 200
    cutout_response = client.get(edited_layer.json()["layers"][0]["cutoutUrl"])
    cutout = Image.open(io.BytesIO(cutout_response.content)).convert("RGBA")
    assert cutout.getpixel((60, 60))[3] == 255
    assert cutout.getpixel((10, 10))[3] == 0
    assert edited_layer.json()["layers"][0]["confirmed"] is False
    confirmed = client.post(
        f"/api/projects/{project['id']}/layers/{layer['id']}/confirm"
    )
    assert confirmed.status_code == 200

    extra_mask = Image.new("L", size)
    ImageDraw.Draw(extra_mask).rectangle((size[0] - 70, 20, size[0] - 20, 70), fill=255)
    edited_extra = client.post(
        f"/api/projects/{project['id']}/extra-mask",
        files={"file": ("extra.png", png_bytes(extra_mask), "image/png")},
    )
    assert edited_extra.status_code == 200
    assert edited_extra.json()["extraMaskUrl"].endswith("extra-inpaint-mask.png")

    inpainted = _inpaint_project(project["id"], [layer["id"]])
    union_response = client.get(inpainted["unionMaskUrl"])
    union = Image.open(io.BytesIO(union_response.content)).convert("L")
    assert union.getpixel((60, 60)) == 255
    assert union.getpixel((size[0] - 40, 40)) == 255


def test_post_build_retouch_mask_invalidates_and_rebuilds_background(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = _sample_project()
    layer = project["layers"][0]
    confirmed = client.post(
        f"/api/projects/{project['id']}/layers/{layer['id']}/confirm"
    )
    assert confirmed.status_code == 200

    first_build = _inpaint_project(project["id"], [layer["id"]])
    assert first_build["backgroundUrl"]
    assert first_build["unionMaskUrl"]

    retouch_mask = Image.new("L", (project["width"], project["height"]))
    retouch_point = (project["width"] - 45, 45)
    ImageDraw.Draw(retouch_mask).ellipse(
        (retouch_point[0] - 20, 25, retouch_point[0] + 20, 65), fill=255
    )
    edited = client.post(
        f"/api/projects/{project['id']}/extra-mask",
        files={"file": ("retouch.png", png_bytes(retouch_mask), "image/png")},
    )

    assert edited.status_code == 200
    edited_project = edited.json()
    assert edited_project["backgroundUrl"] is None
    assert edited_project["unionMaskUrl"] is None
    assert edited_project["layers"][0]["confirmed"] is True

    rebuilt = _inpaint_project(project["id"], [layer["id"]])
    union_response = client.get(rebuilt["unionMaskUrl"])
    union = Image.open(io.BytesIO(union_response.content)).convert("L")
    assert rebuilt["backgroundUrl"]
    assert union.getpixel(retouch_point) == 255


def test_project_package_round_trip_restores_images_and_editor_state(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    analyzed = _sample_project()
    extra_mask = Image.new("L", (analyzed["width"], analyzed["height"]))
    ImageDraw.Draw(extra_mask).ellipse((5, 5, 35, 35), fill=255)
    analyzed = client.post(
        f"/api/projects/{analyzed['id']}/extra-mask",
        files={"file": ("extra.png", png_bytes(extra_mask), "image/png")},
    ).json()
    layer_ids = [layer["id"] for layer in analyzed["layers"][:2]]
    for layer_id in layer_ids:
        analyzed = client.post(
            f"/api/projects/{analyzed['id']}/layers/{layer_id}/confirm"
        ).json()
    project = _inpaint_project(analyzed["id"], layer_ids)
    layer_states = [
        {
            "id": layer["id"],
            "depth": 0.42 if index == 0 else layer["depth"],
            "order": layer["order"],
            "offsetX": 0.18 if index == 0 else 0.0,
            "offsetY": -0.09 if index == 0 else 0.0,
            "selected": layer["selected"],
            "visible": index != 0,
        }
        for index, layer in enumerate(project["layers"])
    ]
    camera = {"x": 0.31, "y": -0.17, "zoom": 1.12, "strength": 74}

    exported = client.post(
        f"/api/projects/{project['id']}/export",
        json={"camera": camera, "layers": layer_states},
    )

    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith(
        "application/vnd.stereovisor.project+zip"
    )
    with ZipFile(io.BytesIO(exported.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format"] == "stereovisor-project"
        assert manifest["version"] == 1
        assert "assets/source.png" in archive.namelist()
        assert all(record["sha256"] for record in manifest["assets"])

    imported_response = client.post(
        "/api/projects/import",
        files={
            "file": (
                "scene.stereovisor",
                exported.content,
                "application/vnd.stereovisor.project+zip",
            )
        },
    )
    imported = imported_response.json()

    assert imported_response.status_code == 200
    assert imported["project"]["id"] != project["id"]
    assert imported["camera"] == camera
    assert imported["project"]["layers"][0]["depth"] == 0.42
    assert imported["project"]["layers"][0]["visible"] is False
    assert imported["project"]["layers"][0]["offsetX"] == 0.18
    assert imported["project"]["layers"][0]["offsetY"] == -0.09
    assert imported["project"]["layers"][0]["proposalMaskUrl"]
    assert imported["project"]["layers"][0]["confirmed"] is True
    assert client.get(imported["project"]["sourceUrl"]).status_code == 200
    assert (
        client.get(imported["project"]["layers"][0]["proposalMaskUrl"]).status_code
        == 200
    )
    assert client.get(imported["project"]["backgroundUrl"]).status_code == 200
    assert client.get(imported["project"]["extraMaskUrl"]).status_code == 200


def test_project_import_rejects_non_archive(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))

    response = client.post(
        "/api/projects/import",
        files={
            "file": ("broken.stereovisor", b"not a zip", "application/octet-stream")
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "IMPORT_FAILED"
