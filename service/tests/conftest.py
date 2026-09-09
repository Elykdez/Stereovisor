"""Test-session isolation for state the service now persists.

Job state moved from an in-memory dict to a SQLite file beside the projects it
produces. Without this, running the suite would share - and on startup fail -
whatever jobs a locally running Stereovisor had in flight.

The environment variable has to be set before ``service.src.config`` is imported,
because the path is resolved once at import.
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile
from pathlib import Path

import pytest


_TEST_STATE_ROOT = Path(tempfile.mkdtemp(prefix="stereovisor-tests-"))
os.environ["STEREOVISOR_JOB_DB"] = str(_TEST_STATE_ROOT / "jobs.db")


@atexit.register
def _remove_test_state() -> None:
    shutil.rmtree(_TEST_STATE_ROOT, ignore_errors=True)


@pytest.fixture(autouse=True)
def live_job_queue():
    """Give every test a queue that accepts work.

    service.src.app builds one module-level JobQueue, and a lifespan shutdown stops
    it for good - correctly, since a late request must not enqueue work that no
    worker will ever run. But a test that enters TestClient as a context manager
    runs that shutdown, which then refused every submission for the rest of the
    session. The suite only passed because of the order pytest happened to
    collect the files in.
    """
    from service.src.app import job_queue

    job_queue.start()
    yield
