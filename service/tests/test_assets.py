"""Project assets are large, mutable, and re-requested on every project load.

One project is a quarter of a gigabyte of cutouts at a stable path: refining a
mask overwrites its own file. So a client has to revalidate before reusing one,
and must not re-download one that has not changed.
"""

from __future__ import annotations

import os

from fastapi.testclient import TestClient

import service.src.app as service_module
from service.src.app import app

client = TestClient(app)


def _sample_asset() -> tuple[str, str]:
    """A completed sample project and the URL of its source image."""
    started = client.post("/api/jobs/sample")
    assert started.status_code == 200
    job_id = started.json()["jobId"]
    assert service_module.job_queue.join(120)
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["state"] == "completed", payload["message"]
    project = payload["result"]
    return project["id"], project["sourceUrl"]


def test_an_unchanged_asset_is_revalidated_instead_of_resent() -> None:
    _, url = _sample_asset()

    first = client.get(url)
    assert first.status_code == 200
    assert first.content
    tag = first.headers["etag"]

    second = client.get(url, headers={"If-None-Match": tag})

    assert second.status_code == 304
    assert second.content == b""
    assert second.headers["etag"] == tag


def test_an_asset_must_be_revalidated_rather_than_reused_blindly() -> None:
    # "no-store" would be correct but forbids the 304 above; "no-cache" keeps
    # the copy and requires a revalidation before every reuse.
    _, url = _sample_asset()

    response = client.get(url)

    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["etag"]
    assert response.headers["last-modified"]


def test_a_rewritten_asset_invalidates_its_entity_tag() -> None:
    project_id, url = _sample_asset()
    original = client.get(url)
    tag = original.headers["etag"]

    path = service_module.store.asset(project_id, os.path.basename(url))
    stamp = path.stat().st_mtime + 10
    os.utime(path, (stamp, stamp))

    refetched = client.get(url, headers={"If-None-Match": tag})

    assert refetched.status_code == 200
    assert refetched.headers["etag"] != tag
    assert refetched.content == original.content


def test_a_timestamp_revalidates_when_no_entity_tag_is_offered() -> None:
    _, url = _sample_asset()
    first = client.get(url)

    unchanged = client.get(
        url, headers={"If-Modified-Since": first.headers["last-modified"]}
    )

    assert unchanged.status_code == 304


def test_a_weak_entity_tag_still_matches() -> None:
    # A proxy or a browser may weaken the tag it echoes back.
    _, url = _sample_asset()
    tag = client.get(url).headers["etag"]

    response = client.get(url, headers={"If-None-Match": f"W/{tag}"})

    assert response.status_code == 304


def test_a_missing_asset_is_still_reported_as_missing() -> None:
    project_id, _ = _sample_asset()

    response = client.get(f"/api/projects/{project_id}/assets/nothing-here.png")

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "ASSET_NOT_FOUND"
