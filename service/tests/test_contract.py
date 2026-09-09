"""Frozen response contract.

The renderer's startup gate, job reducer, and scene compositor read these exact
fields. Introducing the client/server boundary must not reshape them, so any
drift fails here rather than surfacing as a blank gate or a missing layer.
"""

from fastapi.testclient import TestClient

import service.src.app as app_module
from service.src.app import app
from service.src.schemas import (
    HealthPayload,
    LayerPayload,
    ProcessingJobPayload,
    ProjectPayload,
    ProviderStatus,
)

client = TestClient(app)


HEALTH_FIELDS = {
    "status",
    "version",
    "configuredMode",
    "activeEngine",
    "device",
    "localOnly",
    "providers",
    "message",
    "startupState",
    "startupDetail",
    "startupProvider",
    "startupProgress",
}

PROVIDER_FIELDS = {"available", "detail", "state", "progress"}

# queuePosition was added deliberately with the durable job queue. It is
# additive and optional, so existing clients that ignore it are unaffected;
# this list is updated by review, never to silence a surprise.
JOB_FIELDS = {
    "jobId",
    "kind",
    "state",
    "progress",
    "stage",
    "message",
    "queuePosition",
    "result",
}

PROJECT_FIELDS = {
    "id",
    "width",
    "height",
    "sourceUrl",
    "backgroundUrl",
    "unionMaskUrl",
    "extraMaskUrl",
    "depthMapUrl",
    "backgroundPrompt",
    "inpaintProvider",
    "vramPeaksMb",
    "engine",
    "layers",
}

LAYER_FIELDS = {
    "id",
    "name",
    "cutoutUrl",
    "maskUrl",
    "proposalMaskUrl",
    "refinementState",
    "confirmed",
    "maskRevision",
    "depth",
    "order",
    "offsetX",
    "offsetY",
    "selected",
    "visible",
    "bounds",
    "kind",
    "confidence",
}


def test_health_schema_is_frozen() -> None:
    assert set(HealthPayload.model_fields) == HEALTH_FIELDS
    assert set(ProviderStatus.model_fields) == PROVIDER_FIELDS


def test_live_health_response_matches_the_frozen_schema() -> None:
    payload = client.get("/api/health").json()

    assert set(payload) == HEALTH_FIELDS
    # The startup gate renders one row per required provider.
    assert {"runtime", "segmentation", "matting", "depth", "inpainting"} <= set(
        payload["providers"]
    )
    for provider in payload["providers"].values():
        assert set(provider) == PROVIDER_FIELDS


def test_job_and_project_schemas_are_frozen() -> None:
    assert set(ProcessingJobPayload.model_fields) == JOB_FIELDS
    assert set(ProjectPayload.model_fields) == PROJECT_FIELDS
    assert set(LayerPayload.model_fields) == LAYER_FIELDS


def test_job_states_and_startup_states_are_frozen() -> None:
    # startup.ts keys its progress arithmetic off these exact strings.
    startup_states = HealthPayload.model_fields["startupState"].annotation
    assert set(startup_states.__args__) == {
        "starting",
        "downloading",
        "initializing",
        "ready",
        "blocked",
    }
    job_states = ProcessingJobPayload.model_fields["state"].annotation
    assert set(job_states.__args__) == {
        "queued",
        "running",
        "completed",
        "failed",
        "cancelled",
    }


def test_workflow_routes_are_still_registered() -> None:
    # Every inference operation is admitted through the observable job queue.
    paths = {getattr(route, "path", "") for route in app.routes}
    for path in (
        "/api/health",
        "/api/jobs/analyze",
        "/api/jobs/sample",
        "/api/jobs/capabilities/depth:estimate",
        "/api/jobs/{job_id}",
        "/api/jobs/{job_id}/cancel",
        "/api/projects/{project_id}/assets/{name}",
        "/api/projects/{project_id}/export",
        "/api/projects/import",
    ):
        assert path in paths, path
    assert "/api/analyze" not in paths
    assert "/api/sample" not in paths
    assert "/api/projects/{project_id}/inpaint" not in paths


def test_job_lifecycle_reports_a_completed_project() -> None:
    started = client.post("/api/jobs/sample")
    assert started.status_code == 200
    assert app_module.job_queue.join(120)

    payload = client.get(f"/api/jobs/{started.json()['jobId']}").json()

    assert set(payload) == JOB_FIELDS
    assert payload["state"] == "completed"
    assert payload["progress"] == 100
    assert set(payload["result"]) == PROJECT_FIELDS
    for layer in payload["result"]["layers"]:
        assert set(layer) == LAYER_FIELDS
