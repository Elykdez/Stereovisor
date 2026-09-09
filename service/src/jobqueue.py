from __future__ import annotations

import logging
import threading
import time
from collections import deque
from collections.abc import Callable

from .jobs import ProcessingJobStore

logger = logging.getLogger(__name__)


JobOperation = Callable[..., object]
JobRunner = Callable[[str, JobOperation], None]


class JobQueue:
    """FIFO admission control in front of the local GPU.

    Only one job executes at a time, which is what the hardware allows anyway.
    Making that explicit means a waiting job can report its position instead of
    silently occupying a request thread inside a lock.

    The worker is a plain daemon thread consuming an in-process deque, while
    durable state lives in :class:`ProcessingJobStore`. Splitting the API and
    the worker into separate processes later means replacing this consumer with
    one that polls the same database - the queue boundary does not move.
    """

    def __init__(
        self,
        store: ProcessingJobStore,
        runner: JobRunner,
        *,
        name: str = "stereovisor-jobs",
    ) -> None:
        self._store = store
        self._runner = runner
        self._name = name
        self._lock = threading.Lock()
        self._wakeup = threading.Condition(self._lock)
        self._pending: deque[tuple[str, JobOperation]] = deque()
        self._active: str | None = None
        self._thread: threading.Thread | None = None
        self._stopping = False

    # ----------------------------------------------------------------- state

    def depth(self) -> int:
        """Jobs waiting, excluding the one currently running."""
        with self._lock:
            return len(self._pending)

    def is_busy(self) -> bool:
        with self._lock:
            return self._active is not None or bool(self._pending)

    def _positions(self) -> list[tuple[str, int]]:
        # Position is how many jobs must finish first: 0 means "next up".
        offset = 1 if self._active is not None else 0
        return [
            (job_id, index + offset)
            for index, (job_id, _) in enumerate(self._pending)
        ]

    def _publish_positions(self, positions: list[tuple[str, int | None]]) -> None:
        # Called outside the queue lock: the store notifies listeners, and a
        # listener must never be able to reach back in and deadlock the worker.
        for job_id, position in positions:
            try:
                self._store.set_queue_position(job_id, position)
            except Exception:
                # A position is advisory - a client reads authoritative job
                # state over HTTP. Failing to report one must not fail the
                # submission that has already been accepted, and must not
                # strand the worker that is about to run it.
                logger.exception("could not report queue position: id=%s", job_id)

    # ---------------------------------------------------------------- submit

    def submit(self, job_id: str, operation: JobOperation) -> None:
        with self._lock:
            if self._stopping:
                raise RuntimeError("The job queue is shutting down")
            self._pending.append((job_id, operation))
            self._ensure_worker_locked()
            positions = self._positions()
            self._wakeup.notify_all()
        logger.info("job submitted: id=%s depth=%s", job_id, len(positions))
        self._publish_positions(positions)

    def discard(self, job_id: str) -> bool:
        """Remove a waiting job and immediately repair reported positions."""
        with self._lock:
            pending = deque(
                item for item in self._pending if item[0] != job_id
            )
            if len(pending) == len(self._pending):
                return False
            self._pending = pending
            positions = self._positions()
            self._wakeup.notify_all()
        self._publish_positions(positions)
        logger.info("queued job discarded: id=%s depth=%s", job_id, len(positions))
        return True

    def _ensure_worker_locked(self) -> None:
        # Started on demand so importing the app never spawns a thread, which
        # keeps test collection and one-shot tooling free of background work.
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._work, name=self._name, daemon=True)
        self._thread.start()

    # ---------------------------------------------------------------- worker

    def _work(self) -> None:
        while True:
            with self._lock:
                while not self._pending and not self._stopping:
                    self._wakeup.wait()
                if self._stopping and not self._pending:
                    return
                job_id, operation = self._pending.popleft()
                self._active = job_id
                positions = self._positions()
            try:
                # The job is no longer queued, so clear its own position and
                # move the remaining jobs up before the expensive work starts.
                # This is reporting, not admission: it cannot hold up the run.
                self._publish_positions([(job_id, None), *positions])
                self._runner(job_id, operation)
            except Exception:
                # Nothing in an iteration may escape the loop. The worker used
                # to die here with _active still set, so the queue reported a
                # job running forever, is_busy never cleared, and every later
                # shutdown waited out its full join timeout.
                logger.exception("job iteration failed: id=%s", job_id)
            finally:
                with self._lock:
                    self._active = None
                    self._wakeup.notify_all()

    # -------------------------------------------------------------- lifecycle

    def join(self, timeout: float = 60.0) -> bool:
        """Block until nothing is queued or running. Returns False on timeout."""
        deadline = time.monotonic() + timeout
        with self._lock:
            while self._pending or self._active is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._wakeup.wait(remaining)
            return True

    def start(self) -> None:
        """Accept work again after a stop.

        A queue is stopped by a lifespan shutdown, and a process can host more
        than one lifespan - a test harness entering the app twice is the common
        case. Without this, the second run held a queue that refused every
        submission, and the only thing hiding it was the order the files ran in.
        """
        with self._lock:
            self._stopping = False

    def stop(self, timeout: float = 10.0) -> None:
        with self._lock:
            self._stopping = True
            # Do not start new inference while the service is shutting down.
            # Pending operations hold decoded images in closures, so retaining
            # them until process exit wastes memory and leaves durable jobs
            # falsely queued if the process stays alive past the join timeout.
            pending = [job_id for job_id, _ in self._pending]
            self._pending.clear()
            self._wakeup.notify_all()
            thread = self._thread
            running = self._active
        # Cancelling the running job too lets it leave at its next cancellation
        # gate rather than being abandoned mid-stage. Shutdown then stops in
        # about the time one stage takes instead of waiting out this timeout,
        # and the job records that it was cancelled - which is what happened -
        # instead of surfacing as an unexplained failure on the next startup.
        for job_id in [*pending, *([running] if running else [])]:
            try:
                self._store.cancel(job_id)
            except KeyError:
                pass
        if thread is not None and thread.is_alive():
            thread.join(timeout)
