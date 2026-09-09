import threading
import time

import pytest

from service.src.jobqueue import JobQueue
from service.src.jobs import JobCancelled, ProcessingJobStore
from service.src.schemas import DepthResult, ProjectPayload


def project(project_id: str = "p1") -> ProjectPayload:
    return ProjectPayload(
        id=project_id,
        width=8,
        height=8,
        sourceUrl="/api/projects/p1/assets/source.png",
        engine="preview",
        layers=[],
    )


# --------------------------------------------------------------- durability


def test_jobs_survive_a_service_restart(tmp_path) -> None:
    path = tmp_path / "jobs.db"
    store = ProcessingJobStore(path=path)
    job_id = store.create("analyze")
    store.complete(job_id, project())
    store.close()

    reopened = ProcessingJobStore(path=path)
    try:
        payload = reopened.read(job_id)
        assert payload.state == "completed"
        assert payload.progress == 100
        assert payload.result is not None
        assert payload.result.id == "p1"
    finally:
        reopened.close()


def test_capability_results_survive_a_service_restart(tmp_path) -> None:
    path = tmp_path / "jobs.db"
    store = ProcessingJobStore(path=path)
    job_id = store.create("depth:estimate")
    store.complete(
        job_id,
        DepthResult(depthPreviewPng="encoded-depth", vramPeaksMb={"depth": 42}),
    )
    store.close()

    reopened = ProcessingJobStore(path=path)
    try:
        payload = reopened.read(job_id)
        assert payload.kind == "depth:estimate"
        assert isinstance(payload.result, DepthResult)
        assert payload.result.depthPreviewPng == "encoded-depth"
    finally:
        reopened.close()


def test_interrupted_jobs_fail_on_restart(tmp_path) -> None:
    path = tmp_path / "jobs.db"
    store = ProcessingJobStore(path=path)
    running = store.create("analyze")
    store.update(running, 40, "Segmenting", "Working.")
    queued = store.create("inpaint")
    finished = store.create("refine")
    store.complete(finished, project())
    store.close()

    reopened = ProcessingJobStore(path=path)
    try:
        # GPU work cannot be resumed, so the honest outcome is an explanatory
        # failure rather than a job that looks alive with no worker behind it.
        assert reopened.fail_interrupted() == 2
        assert reopened.read(running).state == "failed"
        assert "restarted" in reopened.read(running).message
        assert reopened.read(queued).state == "failed"
        # Work that already finished is preserved across the restart.
        assert reopened.read(finished).state == "completed"
    finally:
        reopened.close()


def test_an_in_memory_store_is_isolated_by_default() -> None:
    # The no-path default keeps tests and one-shot tooling off the real database.
    first = ProcessingJobStore()
    second = ProcessingJobStore()
    job_id = first.create("analyze")

    with pytest.raises(KeyError):
        second.read(job_id)


# ------------------------------------------------------------------ retention


def test_expired_terminal_jobs_are_evicted() -> None:
    store = ProcessingJobStore(retention_seconds=60)
    finished = store.create("analyze")
    store.complete(finished, project())
    active = store.create("refine")
    store.update(active, 10, "Working", "Still going.")

    assert store.evict_expired() == 0  # nothing is old enough yet
    assert store.evict_expired(now=time.time() + 3600) == 1

    with pytest.raises(KeyError):
        store.read(finished)
    # An unfinished job is never swept, however old it looks.
    assert store.read(active).state == "running"


def test_eviction_removes_the_result_row_too() -> None:
    store = ProcessingJobStore(retention_seconds=0)
    job_id = store.create("analyze")
    store.complete(job_id, project())

    store.evict_expired(now=time.time() + 10)

    fresh = store.create("analyze")
    assert store.read(fresh).result is None
    with pytest.raises(KeyError):
        store.read(job_id)


# ---------------------------------------------------------------- the queue


def test_queue_runs_one_job_at_a_time_in_order() -> None:
    store = ProcessingJobStore()
    started = threading.Event()
    release = threading.Event()
    concurrent = []
    running = []
    order = []

    def runner(job_id, operation):
        running.append(job_id)
        concurrent.append(len(running))
        operation()
        running.remove(job_id)
        order.append(job_id)

    queue = JobQueue(store, runner)
    try:
        first = store.create("analyze")
        queue.submit(first, lambda: (started.set(), release.wait(10)))
        assert started.wait(10)

        second = store.create("inpaint")
        queue.submit(second, lambda: None)
        third = store.create("refine")
        queue.submit(third, lambda: None)

        release.set()
        assert queue.join(30)
    finally:
        queue.stop()

    assert order == [first, second, third]
    assert max(concurrent) == 1  # the local GPU is never shared


def test_a_waiting_job_reports_how_many_are_ahead() -> None:
    store = ProcessingJobStore()
    started = threading.Event()
    release = threading.Event()

    queue = JobQueue(store, lambda job_id, operation: operation())
    try:
        first = store.create("analyze")
        queue.submit(first, lambda: (started.set(), release.wait(10)))
        assert started.wait(10)

        second = store.create("inpaint")
        queue.submit(second, lambda: None)
        third = store.create("refine")
        queue.submit(third, lambda: None)

        assert store.read(second).queuePosition == 1
        assert store.read(third).queuePosition == 2
        # The count is mirrored into the message so existing UI shows it with
        # no change to how a job is rendered.
        assert "1 ahead" in store.read(second).message
        assert "2 ahead" in store.read(third).message

        release.set()
        assert queue.join(30)
    finally:
        queue.stop()

    # Position is cleared once a job is no longer waiting.
    assert store.read(second).queuePosition is None
    assert store.read(third).queuePosition is None


def test_the_first_job_reports_no_backlog() -> None:
    store = ProcessingJobStore()
    queue = JobQueue(store, lambda job_id, operation: operation())
    try:
        job_id = store.create("analyze")
        queue.submit(job_id, lambda: None)
        assert queue.join(30)
    finally:
        queue.stop()

    assert "ahead" not in store.read(job_id).message


def test_discarded_job_never_runs_and_repairs_queue_positions() -> None:
    store = ProcessingJobStore()
    started = threading.Event()
    release = threading.Event()
    executed = []

    def runner(job_id, operation):
        # The same gate _run_job uses before touching any expensive stage.
        try:
            store.ensure_active(job_id)
        except JobCancelled:
            return
        operation()

    queue = JobQueue(store, runner)
    try:
        first = store.create("analyze")
        queue.submit(first, lambda: (started.set(), release.wait(10)))
        assert started.wait(10)

        second = store.create("inpaint")
        queue.submit(second, lambda: executed.append(second))
        third = store.create("refine")
        queue.submit(third, lambda: executed.append(third))
        assert store.read(third).queuePosition == 2

        store.cancel(second)
        assert queue.discard(second)
        assert store.read(third).queuePosition == 1

        release.set()
        assert queue.join(30)
    finally:
        queue.stop()

    assert executed == [third]
    assert store.read(second).state == "cancelled"


def test_queue_reports_depth_and_settles_to_idle() -> None:
    store = ProcessingJobStore()
    started = threading.Event()
    release = threading.Event()

    queue = JobQueue(store, lambda job_id, operation: operation())
    try:
        first = store.create("analyze")
        queue.submit(first, lambda: (started.set(), release.wait(10)))
        assert started.wait(10)
        queue.submit(store.create("inpaint"), lambda: None)

        assert queue.depth() == 1
        assert queue.is_busy()

        release.set()
        assert queue.join(30)
        assert queue.depth() == 0
        assert not queue.is_busy()
    finally:
        queue.stop()


def test_a_stopped_queue_accepts_work_again_once_restarted() -> None:
    # A process can host more than one lifespan. The second run must get a
    # working queue rather than one still latched shut by the first shutdown.
    store = ProcessingJobStore()
    queue = JobQueue(store, lambda job_id, operation: operation())
    queue.stop()

    queue.start()

    executed: list[str] = []
    try:
        queue.submit(store.create("analyze"), lambda: executed.append("ran"))
        assert queue.join(10)
        assert executed == ["ran"]
    finally:
        queue.stop()


def test_submitting_after_shutdown_is_refused() -> None:
    store = ProcessingJobStore()
    queue = JobQueue(store, lambda job_id, operation: operation())
    queue.stop()

    with pytest.raises(RuntimeError):
        queue.submit(store.create("analyze"), lambda: None)


def test_shutdown_cancels_pending_work_without_starting_it() -> None:
    store = ProcessingJobStore()
    started = threading.Event()
    release = threading.Event()
    executed: list[str] = []
    queue = JobQueue(store, lambda job_id, operation: operation())
    try:
        first = store.create("analyze")
        queue.submit(first, lambda: (started.set(), release.wait(10)))
        assert started.wait(10)

        second = store.create("inpaint")
        queue.submit(second, lambda: executed.append(second))
        queue.stop(timeout=1)
        release.set()

        assert queue.join(10)
        assert executed == []
        assert store.read(second).state == "cancelled"
    finally:
        queue.stop()


def test_a_failure_reporting_positions_never_blocks_a_job() -> None:
    # A position is advisory: a client reads authoritative job state over HTTP.
    # Reporting one must not fail a submission that is already durable and
    # already queued, nor stop the worker from running it.
    store = ProcessingJobStore()

    def refuse(job_id: str, position: int | None) -> None:
        raise RuntimeError("the job store is unavailable")

    store.set_queue_position = refuse  # type: ignore[method-assign]
    executed: list[str] = []
    queue = JobQueue(store, lambda job_id, operation: operation())
    try:
        queue.submit(store.create("analyze"), lambda: executed.append("ran"))

        assert queue.join(10)
        assert executed == ["ran"]
        assert not queue.is_busy()
    finally:
        queue.stop()


def test_the_worker_survives_an_iteration_that_raises() -> None:
    # Whatever an iteration does before the runner, it must not escape the
    # loop. The worker used to die with the job still marked active: is_busy
    # never cleared, join hung for its full timeout, and no later job was
    # picked up.
    store = ProcessingJobStore()
    queue = JobQueue(store, lambda job_id, operation: operation())
    failed_once = {"done": False}
    real_publish = queue._publish_positions

    def flaky(positions):
        # Only the worker clears a position; submit only reports a backlog.
        clearing = any(position is None for _, position in positions)
        if clearing and not failed_once["done"]:
            failed_once["done"] = True
            raise RuntimeError("reporting collapsed")
        real_publish(positions)

    queue._publish_positions = flaky  # type: ignore[method-assign]
    executed: list[str] = []
    try:
        queue.submit(store.create("analyze"), lambda: executed.append("first"))
        assert queue.join(10)
        assert not queue.is_busy()

        queue.submit(store.create("inpaint"), lambda: executed.append("second"))

        assert queue.join(10)
        assert executed == ["second"]
        assert not queue.is_busy()
    finally:
        queue.stop()


def test_shutdown_asks_the_running_job_to_stop() -> None:
    # Abandoning it means waiting out the join and then reporting an
    # unexplained failure on the next startup. Cancelling lets the job leave at
    # its next gate and record what actually happened.
    store = ProcessingJobStore()
    started = threading.Event()
    outcome: list[str] = []

    def long_running(job_id: str) -> None:
        started.set()
        for _ in range(100):
            try:
                store.ensure_active(job_id)
            except JobCancelled:
                store.cancel(job_id)
                outcome.append("cancelled")
                return
            time.sleep(0.01)
        outcome.append("ran to completion")

    queue = JobQueue(store, lambda job_id, operation: operation())
    try:
        job_id = store.create("analyze")
        queue.submit(job_id, lambda: long_running(job_id))
        assert started.wait(10)

        queue.stop(timeout=10)

        assert outcome == ["cancelled"]
        assert store.read(job_id).state == "cancelled"
    finally:
        queue.stop()
