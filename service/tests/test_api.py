import io
import json
from zipfile import ZipFile

from fastapi.testclient import TestClient

import service.app as service_module
from service.app import app
from service.storage import ProjectStore


client = TestClient(app)


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


def test_rejects_unsupported_upload() -> None:
    response = client.post(
        "/api/analyze",
        files={"file": ("not-image.txt", b"not an image", "text/plain")},
    )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "UNSUPPORTED_IMAGE"


def test_project_package_round_trip_restores_images_and_editor_state(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))
    analyzed = client.post("/api/sample").json()
    layer_ids = [layer["id"] for layer in analyzed["layers"][:2]]
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
    assert client.get(imported["project"]["sourceUrl"]).status_code == 200
    assert client.get(imported["project"]["backgroundUrl"]).status_code == 200


def test_project_import_rejects_non_archive(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(service_module, "store", ProjectStore(tmp_path))

    response = client.post(
        "/api/projects/import",
        files={"file": ("broken.stereovisor", b"not a zip", "application/octet-stream")},
    )

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "IMPORT_FAILED"
