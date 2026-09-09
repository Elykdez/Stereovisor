import asyncio
import base64

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import service.src.app as service_module
from service.src.app import app
from service.src.events import EventHub
from service.src.jobs import ProcessingJobStore
from service.src.schemas import ProjectPayload


def project(project_id: str = "p1") -> ProjectPayload:
    return ProjectPayload(
        id=project_id,
        width=8,
        height=8,
        sourceUrl="/api/projects/p1/assets/source.png",
        engine="preview",
        layers=[],
    )


def test_hub_without_a_bound_loop_drops_frames_instead_of_raising() -> None:
    hub = EventHub()
    hub.publish("job", {"state": "running"})  # must not raise


def test_hub_sequences_each_topic_independently() -> None:
    async def scenario() -> list[dict]:
        hub = EventHub()
        hub.bind(asyncio.get_running_loop())
        queue = hub.register()
        hub.publish("job", {"state": "queued"})
        hub.publish("health", {"startupState": "ready"})
        hub.publish("job", {"state": "running"})
        await asyncio.sleep(0)
        return [queue.get_nowait() for _ in range(3)]

    frames = asyncio.run(scenario())
    assert [(f["topic"], f["seq"]) for f in frames] == [
        ("job", 1),
        ("health", 1),
        ("job", 2),
    ]


def test_hub_drops_a_subscriber_that_stops_draining() -> None:
    async def scenario() -> int:
        hub = EventHub()
        hub.bind(asyncio.get_running_loop())
        hub.register()
        for index in range(400):
            hub.publish("job", {"state": index})
        await asyncio.sleep(0)
        return hub.subscriber_count()

    # A stalled client is dropped rather than allowed to back up the pipeline.
    assert asyncio.run(scenario()) == 0


def test_job_store_notifies_every_observable_transition() -> None:
    seen = []
    store = ProcessingJobStore(seen.append)
    job_id = store.create("analyze")
    store.update(job_id, 10, "Segmenting", "working")
    store.complete(job_id, project())

    assert [payload.state for payload in seen] == ["queued", "running", "completed"]
    assert [payload.progress for payload in seen] == [0, 10, 100]


def test_job_store_suppresses_repeated_identical_progress() -> None:
    seen = []
    store = ProcessingJobStore(seen.append)
    job_id = store.create("analyze")
    store.update(job_id, 10, "Segmenting", "working")
    store.update(job_id, 10, "Segmenting", "working")
    store.update(job_id, 10, "Segmenting", "working")

    assert len(seen) == 2  # queued + one running transition


def test_job_store_survives_a_failing_listener() -> None:
    def explode(_payload):
        raise RuntimeError("listener is broken")

    store = ProcessingJobStore(explode)
    job_id = store.create("analyze")
    store.update(job_id, 5, "Stage", "message")

    assert store.read(job_id).state == "running"


def test_published_job_events_never_carry_the_project_result(monkeypatch) -> None:
    published: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        service_module.events,
        "publish",
        lambda topic, payload: published.append((topic, payload)),
    )
    store = ProcessingJobStore(service_module._publish_job_event)
    job_id = store.create("analyze")
    store.complete(job_id, project())

    assert [topic for topic, _ in published] == ["job", "job"]
    assert all("result" not in payload for _, payload in published)
    assert published[-1][1]["state"] == "completed"


def test_event_socket_delivers_published_frames() -> None:
    with TestClient(app) as live:
        with live.websocket_connect("/api/events") as socket:
            assert socket.receive_json() == {"topic": "ready", "seq": 0}
            service_module.events.publish("job", {"jobId": "abc", "state": "running"})
            frame = socket.receive_json()

    assert frame["topic"] == "job"
    assert frame["jobId"] == "abc"
    assert frame["state"] == "running"
    assert frame["seq"] >= 1


def test_event_socket_rejects_an_unlisted_origin() -> None:
    with TestClient(app) as live:
        # The handshake is closed before accept, which surfaces to the client as
        # a disconnect rather than an open socket.
        with pytest.raises(WebSocketDisconnect):
            with live.websocket_connect(
                "/api/events", headers={"origin": "http://evil.example"}
            ) as socket:
                socket.receive_json()


def test_event_socket_accepts_a_listed_origin() -> None:
    with TestClient(app) as live:
        with live.websocket_connect(
            "/api/events", headers={"origin": "http://127.0.0.1:5173"}
        ) as socket:
            assert socket.receive_json()["topic"] == "ready"


def test_event_socket_accepts_the_packaged_file_origin() -> None:
    with TestClient(app) as live:
        with live.websocket_connect(
            "/api/events", headers={"origin": "file://"}
        ) as socket:
            assert socket.receive_json()["topic"] == "ready"


def _auth_subprotocol(token: str) -> str:
    encoded = base64.urlsafe_b64encode(token.encode("utf-8")).decode("ascii")
    return f"stereovisor.auth.{encoded.rstrip('=')}"


def test_remote_event_socket_requires_the_configured_token(monkeypatch) -> None:
    monkeypatch.setattr(service_module, "SERVICE_HOST", "0.0.0.0")
    monkeypatch.setattr(service_module, "SERVICE_AUTH_TOKEN", "lan-secret-123")

    with TestClient(app) as live:
        with pytest.raises(WebSocketDisconnect):
            with live.websocket_connect("/api/events") as socket:
                socket.receive_json()

        protocol = _auth_subprotocol("lan-secret-123")
        with live.websocket_connect(
            "/api/events", subprotocols=[protocol]
        ) as socket:
            assert socket.accepted_subprotocol == protocol
            assert socket.receive_json() == {"topic": "ready", "seq": 0}


def test_health_watch_eases_off_once_readiness_settles() -> None:
    from service.src.app import (
        HEALTH_WATCH_IDLE_SECONDS,
        HEALTH_WATCH_INTERVAL_SECONDS,
        health_watch_interval,
    )
    from service.src.schemas import HealthPayload

    def payload(state: str) -> HealthPayload:
        return HealthPayload(
            configuredMode="auto",
            activeEngine="ai",
            device="cpu",
            providers={},
            message="",
            startupState=state,
        )

    # Readiness churns while models are downloading and then stops changing.
    assert (
        health_watch_interval(payload("downloading")) == HEALTH_WATCH_INTERVAL_SECONDS
    )
    assert (
        health_watch_interval(payload("initializing")) == HEALTH_WATCH_INTERVAL_SECONDS
    )
    assert health_watch_interval(payload("blocked")) == HEALTH_WATCH_INTERVAL_SECONDS
    assert health_watch_interval(payload("ready")) == HEALTH_WATCH_IDLE_SECONDS
    assert HEALTH_WATCH_IDLE_SECONDS > HEALTH_WATCH_INTERVAL_SECONDS
