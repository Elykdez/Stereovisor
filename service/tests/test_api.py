import io
import json
from zipfile import ZipFile

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

import service.app as service_module
import service.pipeline as pipeline
from service.app import app
from service.storage import ProjectStore


client = TestClient(app)


def png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_health_declares_local_engine() -> None:
    response = client.get("/api/health")
    payload = response.json()

    assert response.status_code == 200
    assert payload["localOnly"] is True
    assert payload["activeEngine"] in {"preview", "ai"}
    assert ": ." not in payload["message"]


def test_sample_to_inpaint_api_flow(monkeypatch) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    response = client.post("/api/sample")
    project = response.json()

    assert response.status_code == 200
    assert len(project["layers"]) >= 2

    layer_ids = [layer["id"] for layer in project["layers"][:2]]
    for layer_id in layer_ids:
        confirmed = client.post(f"/api/projects/{project['id']}/layers/{layer_id}/confirm")
        assert confirmed.status_code == 200
    inpainted = client.post(
        f"/api/projects/{project['id']}/inpaint",
        json={"layerIds": layer_ids},
    )
    result = inpainted.json()

    assert inpainted.status_code == 200
    assert result["backgroundUrl"].endswith("background.png")
    asset_response = client.get(result["backgroundUrl"])
    assert asset_response.status_code == 200
    assert asset_response.headers["content-type"] == "image/png"


def test_processing_job_reports_completion() -> None:
    started = client.post("/api/jobs/sample")
    job_id = started.json()["jobId"]

    status = client.get(f"/api/jobs/{job_id}")
    payload = status.json()

    assert started.status_code == 200
    assert status.status_code == 200
    assert payload["state"] == "completed"
    assert payload["progress"] == 100
    assert payload["result"]["layers"]


def test_inpaint_requires_confirmed_masks(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = client.post("/api/sample").json()

    response = client.post(
        f"/api/projects/{project['id']}/inpaint",
        json={"layerIds": [project["layers"][0]["id"]]},
    )

    assert response.status_code == 422
    assert "Confirm every selected mask" in response.json()["detail"]["message"]


def test_refine_job_targets_one_layer(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = client.post("/api/sample").json()
    target_id = project["layers"][0]["id"]

    class FakeRefiner:
        def refine(self, payload, _directory, layer_id, progress=None):
            assert layer_id == target_id
            if progress is not None:
                progress(60, "Refining mask", "Testing one local layer.")
            return payload.model_copy(
                update={
                    "layers": [
                        layer.model_copy(update={"refinementState": "refined"})
                        if layer.id == layer_id else layer
                        for layer in payload.layers
                    ]
                }
            )

    monkeypatch.setattr(service_module, "_pipeline", lambda: FakeRefiner())
    started = client.post(f"/api/jobs/projects/{project['id']}/layers/{target_id}/refine")
    status = client.get(f"/api/jobs/{started.json()['jobId']}").json()

    assert started.status_code == 200
    assert status["kind"] == "refine"
    assert status["state"] == "completed"
    assert status["result"]["layers"][0]["refinementState"] == "refined"


def test_target_inpaint_job_receives_composition_mask_and_target(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = client.post("/api/sample").json()
    size = (project["width"], project["height"])

    class FakeTargetInpainter:
        def inpaint_target(self, payload, _directory, target_id, composition, mask, prompt=None, progress=None):
            assert target_id == project["layers"][0]["id"]
            assert composition.size == size
            assert mask.size == size
            assert prompt == "new painted detail"
            if progress is not None:
                progress(70, "Inpainting layer", "Testing target inpaint.")
            return payload

    monkeypatch.setattr(service_module, "_pipeline", lambda: FakeTargetInpainter())
    started = client.post(
        f"/api/jobs/projects/{project['id']}/targets/{project['layers'][0]['id']}/inpaint",
        files={
            "composition": ("composition.png", png_bytes(Image.new("RGB", size, "white")), "image/png"),
            "mask": ("mask.png", png_bytes(Image.new("L", size, 255)), "image/png"),
        },
        data={"prompt": "new painted detail"},
    )
    status = client.get(f"/api/jobs/{started.json()['jobId']}").json()

    assert started.status_code == 200
    assert status["kind"] == "inpaint"
    assert status["state"] == "completed"


def test_target_inpaint_history_api_restores_the_focused_asset(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    project_store = ProjectStore(tmp_path)
    monkeypatch.setattr(service_module, "store", project_store)
    project = client.post("/api/sample").json()
    layer_id = project["layers"][0]["id"]
    assert client.post(f"/api/projects/{project['id']}/layers/{layer_id}/confirm").status_code == 200
    built = client.post(
        f"/api/projects/{project['id']}/inpaint",
        json={"layerIds": [layer_id]},
    ).json()
    directory = project_store.directory(project["id"])
    payload = project_store.read(project["id"])
    background_path = directory / "background.png"
    original = background_path.read_bytes()
    pipeline.record_inpaint_history(payload, directory, "background")
    Image.new("RGB", (built["width"], built["height"]), "blue").save(background_path)

    history = client.get(f"/api/projects/{project['id']}/inpaint-history")
    assert history.status_code == 200
    background = next(state for state in history.json() if state["targetId"] == "background")
    assert background == {"targetId": "background", "canUndo": True, "canRedo": False}

    undone = client.post(f"/api/projects/{project['id']}/targets/background/undo-inpaint")
    assert undone.status_code == 200
    assert background_path.read_bytes() == original
    redone = client.post(f"/api/projects/{project['id']}/targets/background/redo-inpaint")
    assert redone.status_code == 200
    assert Image.open(background_path).convert("RGB").getpixel((0, 0)) == (0, 0, 255)


def test_rejects_unsupported_upload() -> None:
    response = client.post(
        "/api/analyze",
        files={"file": ("not-image.txt", b"not an image", "text/plain")},
    )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "UNSUPPORTED_IMAGE"


def test_brush_masks_update_cutout_and_expand_inpainting(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = client.post("/api/sample").json()
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
    confirmed = client.post(f"/api/projects/{project['id']}/layers/{layer['id']}/confirm")
    assert confirmed.status_code == 200

    extra_mask = Image.new("L", size)
    ImageDraw.Draw(extra_mask).rectangle((size[0] - 70, 20, size[0] - 20, 70), fill=255)
    edited_extra = client.post(
        f"/api/projects/{project['id']}/extra-mask",
        files={"file": ("extra.png", png_bytes(extra_mask), "image/png")},
    )
    assert edited_extra.status_code == 200
    assert edited_extra.json()["extraMaskUrl"].endswith("extra-inpaint-mask.png")

    inpainted = client.post(
        f"/api/projects/{project['id']}/inpaint",
        json={"layerIds": [layer["id"]]},
    ).json()
    union_response = client.get(inpainted["unionMaskUrl"])
    union = Image.open(io.BytesIO(union_response.content)).convert("L")
    assert union.getpixel((60, 60)) == 255
    assert union.getpixel((size[0] - 40, 40)) == 255


def test_post_build_retouch_mask_invalidates_and_rebuilds_background(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("STEREOVISOR_MODE", "preview")
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    project = client.post("/api/sample").json()
    layer = project["layers"][0]
    confirmed = client.post(f"/api/projects/{project['id']}/layers/{layer['id']}/confirm")
    assert confirmed.status_code == 200

    first_build = client.post(
        f"/api/projects/{project['id']}/inpaint",
        json={"layerIds": [layer["id"]]},
    ).json()
    assert first_build["backgroundUrl"]
    assert first_build["unionMaskUrl"]

    retouch_mask = Image.new("L", (project["width"], project["height"]))
    retouch_point = (project["width"] - 45, 45)
    ImageDraw.Draw(retouch_mask).ellipse((retouch_point[0] - 20, 25, retouch_point[0] + 20, 65), fill=255)
    edited = client.post(
        f"/api/projects/{project['id']}/extra-mask",
        files={"file": ("retouch.png", png_bytes(retouch_mask), "image/png")},
    )

    assert edited.status_code == 200
    edited_project = edited.json()
    assert edited_project["backgroundUrl"] is None
    assert edited_project["unionMaskUrl"] is None
    assert edited_project["layers"][0]["confirmed"] is True

    rebuilt = client.post(
        f"/api/projects/{project['id']}/inpaint",
        json={"layerIds": [layer["id"]]},
    ).json()
    union_response = client.get(rebuilt["unionMaskUrl"])
    union = Image.open(io.BytesIO(union_response.content)).convert("L")
    assert rebuilt["backgroundUrl"]
    assert union.getpixel(retouch_point) == 255


def test_project_package_round_trip_restores_images_and_editor_state(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    analyzed = client.post("/api/sample").json()
    extra_mask = Image.new("L", (analyzed["width"], analyzed["height"]))
    ImageDraw.Draw(extra_mask).ellipse((5, 5, 35, 35), fill=255)
    analyzed = client.post(
        f"/api/projects/{analyzed['id']}/extra-mask",
        files={"file": ("extra.png", png_bytes(extra_mask), "image/png")},
    ).json()
    layer_ids = [layer["id"] for layer in analyzed["layers"][:2]]
    for layer_id in layer_ids:
        analyzed = client.post(f"/api/projects/{analyzed['id']}/layers/{layer_id}/confirm").json()
    project = client.post(
        f"/api/projects/{analyzed['id']}/inpaint",
        json={"layerIds": layer_ids},
    ).json()
    layer_states = [
        {
            "id": layer["id"],
            "depth": 0.42 if index == 0 else layer["depth"],
            "order": layer["order"],
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
    assert exported.headers["content-type"].startswith("application/vnd.stereovisor.project+zip")
    with ZipFile(io.BytesIO(exported.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["format"] == "stereovisor-project"
        assert manifest["version"] == 1
        assert "assets/source.png" in archive.namelist()
        assert all(record["sha256"] for record in manifest["assets"])

    imported_response = client.post(
        "/api/projects/import",
        files={"file": ("scene.stereovisor", exported.content, "application/vnd.stereovisor.project+zip")},
    )
    imported = imported_response.json()

    assert imported_response.status_code == 200
    assert imported["project"]["id"] != project["id"]
    assert imported["camera"] == camera
    assert imported["project"]["layers"][0]["depth"] == 0.42
    assert imported["project"]["layers"][0]["visible"] is False
    assert imported["project"]["layers"][0]["proposalMaskUrl"]
    assert imported["project"]["layers"][0]["confirmed"] is True
    assert client.get(imported["project"]["sourceUrl"]).status_code == 200
    assert client.get(imported["project"]["layers"][0]["proposalMaskUrl"]).status_code == 200
    assert client.get(imported["project"]["backgroundUrl"]).status_code == 200
    assert client.get(imported["project"]["extraMaskUrl"]).status_code == 200


def test_project_import_rejects_non_archive(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))

    response = client.post(
        "/api/projects/import",
        files={"file": ("broken.stereovisor", b"not a zip", "application/octet-stream")},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "IMPORT_FAILED"
