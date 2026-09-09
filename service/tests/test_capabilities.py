import base64
import io
import threading

from fastapi.testclient import TestClient
from PIL import Image

import service.src.app as service_module
from service.src.app import app
from service.src.config import ai_dependencies
from service.src.providers import CAPABILITY_SPECS


client = TestClient(app)


def png_bytes(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def upload(
    name: str = "source.png",
    size: tuple[int, int] = (24, 24),
    color: str = "white",
):
    return (name, png_bytes(Image.new("RGB", size, color)), "image/png")


def mask_upload(size: tuple[int, int] = (24, 24)):
    mask = Image.new("L", size, 0)
    mask.paste(255, (4, 4, 16, 16))
    return ("mask.png", png_bytes(mask), "image/png")


def completed_job(response) -> dict:
    assert response.status_code == 200
    job_id = response.json()["jobId"]
    assert service_module.job_queue.join(30)
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["state"] == "completed"
    return payload


def test_every_capability_is_gated_by_a_real_health_provider() -> None:
    # The inventory must not invent readiness keys: capability availability and
    # startup readiness have to stay one source of truth.
    known = set(ai_dependencies())
    assert {spec["provider"] for spec in CAPABILITY_SPECS} <= known


def test_capability_inventory_describes_each_component() -> None:
    payload = client.get("/api/capabilities").json()

    assert response_ids(payload) == [
        "segmentation:detect",
        "depth:estimate",
        "matting:refine",
        "inpainting:fill",
        "vlm:vocabulary",
        "vlm:caption",
        "inpainting:redraw",
    ]
    entry = payload["capabilities"][0]
    assert entry["endpoint"] == "/api/jobs/capabilities/segmentation:detect"
    assert entry["model"].startswith("Grounding DINO")
    assert entry["vramBudgetMb"] == 8192
    assert {parameter["name"] for parameter in entry["parameters"]} == {
        "density",
        "labels",
    }
    assert isinstance(entry["available"], bool)
    endpoints = {
        item["endpoint"] for item in payload["capabilities"] if item["endpoint"]
    }
    registered = {getattr(route, "path", "") for route in app.routes}
    assert all(path.startswith("/api/jobs/capabilities/") for path in endpoints)
    assert endpoints <= registered


def response_ids(payload: dict) -> list[str]:
    return [entry["id"] for entry in payload["capabilities"]]


def test_powerpaint_is_listed_without_a_synchronous_endpoint() -> None:
    payload = client.get("/api/capabilities").json()
    redraw = next(
        entry for entry in payload["capabilities"] if entry["id"] == "inpainting:redraw"
    )

    # PowerPaint still requires workflow project context and prompt controls.
    assert redraw["endpoint"] is None


def test_capability_reports_503_when_its_provider_is_missing(monkeypatch) -> None:
    monkeypatch.setattr(
        service_module, "capability_ready", lambda _id: (False, "Missing weights")
    )

    response = client.post(
        "/api/jobs/capabilities/depth:estimate", files={"file": upload()}
    )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "CAPABILITY_UNAVAILABLE"
    assert response.json()["detail"]["detail"] == "Missing weights"


def test_segmentation_capability_returns_encoded_instances(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "capability_ready", lambda _id: (True, "ok"))
    seen: dict = {}

    def fake_detect(image, density, labels):
        seen["size"] = image.size
        seen["density"] = density
        seen["labels"] = labels
        mask = Image.new("L", image.size, 255)
        return (
            [
                {
                    "label": "person",
                    "score": 0.5,
                    "bounds": (0, 0, image.width, image.height),
                    "maskPng": base64.b64encode(png_bytes(mask)).decode("ascii"),
                }
            ],
            {"groundingDino": 120},
        )

    monkeypatch.setattr(service_module, "detect_instances", fake_detect)

    response = client.post(
        "/api/jobs/capabilities/segmentation:detect",
        files={"file": upload()},
        data={"density": "dense", "labels": "cat, dog"},
    )
    payload = completed_job(response)["result"]

    assert seen == {"size": (24, 24), "density": "dense", "labels": "cat, dog"}
    assert payload["vramPeaksMb"] == {"groundingDino": 120}
    assert payload["instances"][0]["label"] == "person"
    decoded = Image.open(io.BytesIO(base64.b64decode(payload["instances"][0]["maskPng"])))
    assert decoded.size == (24, 24)


def test_capability_failure_becomes_a_failed_job(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "capability_ready", lambda _id: (True, "ok"))

    def explode(_image):
        raise RuntimeError("depth model refused the input")

    monkeypatch.setattr(service_module, "estimate_depth", explode)

    response = client.post(
        "/api/jobs/capabilities/depth:estimate", files={"file": upload()}
    )
    assert response.status_code == 200
    assert service_module.job_queue.join(30)
    payload = client.get(f"/api/jobs/{response.json()['jobId']}").json()

    assert payload["state"] == "failed"
    assert "depth model refused" in payload["message"]


def test_mask_is_aligned_to_the_normalized_image(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "capability_ready", lambda _id: (True, "ok"))
    seen: dict = {}

    def fake_fill(image, mask):
        seen["image"] = image.size
        seen["mask"] = mask.size
        return Image.new("RGB", image.size, "black"), {"bigLama": 64}

    monkeypatch.setattr(service_module, "fill_region", fake_fill)

    response = client.post(
        "/api/jobs/capabilities/inpainting:fill",
        files={"file": upload(size=(24, 24)), "mask": mask_upload(size=(48, 48))},
    )

    payload = completed_job(response)["result"]
    # A mask supplied at the source resolution is resampled onto the bounded
    # image rather than rejected.
    assert seen["image"] == seen["mask"] == (24, 24)
    assert payload["provider"] == "big-lama"


def test_matting_rejects_unknown_kind_before_running_a_provider(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "capability_ready", lambda _id: (True, "ok"))

    response = client.post(
        "/api/jobs/capabilities/matting:refine",
        files={"file": upload(), "mask": mask_upload()},
        data={"kind": "unexpected"},
    )

    assert response.status_code == 422


def test_capability_rejects_a_non_image_upload(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "capability_ready", lambda _id: (True, "ok"))

    response = client.post(
        "/api/jobs/capabilities/depth:estimate",
        files={"file": ("notes.txt", b"plain text", "text/plain")},
    )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "UNSUPPORTED_IMAGE"


def test_readiness_is_checked_before_the_upload_is_decoded(monkeypatch) -> None:
    # An unusable capability must not spend time decoding megabytes first.
    monkeypatch.setattr(
        service_module, "capability_ready", lambda _id: (False, "Missing weights")
    )

    response = client.post(
        "/api/jobs/capabilities/depth:estimate",
        files={"file": ("notes.txt", b"plain text", "text/plain")},
    )

    assert response.status_code == 503


def test_capability_jobs_share_fifo_across_clients_and_cancel_cleanly(
    monkeypatch,
) -> None:
    monkeypatch.setattr(service_module, "capability_ready", lambda _id: (True, "ok"))
    first_started = threading.Event()
    release_first = threading.Event()
    order: list[tuple[int, int, int]] = []

    def fake_depth(image):
        color = image.getpixel((0, 0))
        order.append(color)
        if color == (255, 255, 255):
            first_started.set()
            assert release_first.wait(10)
        return Image.new("L", image.size, 128), {"depthAnything3": 32}

    monkeypatch.setattr(service_module, "estimate_depth", fake_depth)
    client_a = TestClient(app)
    client_b = TestClient(app)

    try:
        first = client_a.post(
            "/api/jobs/capabilities/depth:estimate",
            files={"file": upload(color="white")},
        ).json()["jobId"]
        assert first_started.wait(10)

        cancelled = client_b.post(
            "/api/jobs/capabilities/depth:estimate",
            files={"file": upload(color="red")},
        ).json()["jobId"]
        third = client_a.post(
            "/api/jobs/capabilities/depth:estimate",
            files={"file": upload(color="blue")},
        ).json()["jobId"]

        assert client_b.get(f"/api/jobs/{cancelled}").json()["queuePosition"] == 1
        assert client_a.get(f"/api/jobs/{third}").json()["queuePosition"] == 2

        cancelled_payload = client_b.post(f"/api/jobs/{cancelled}/cancel").json()
        assert cancelled_payload["state"] == "cancelled"
        assert client_a.get(f"/api/jobs/{third}").json()["queuePosition"] == 1
    finally:
        release_first.set()
        assert service_module.job_queue.join(30)

    assert order == [(255, 255, 255), (0, 0, 255)]
    assert client_a.get(f"/api/jobs/{first}").json()["state"] == "completed"
    assert client_a.get(f"/api/jobs/{third}").json()["state"] == "completed"
    assert client_b.get(f"/api/jobs/{cancelled}").json()["state"] == "cancelled"
