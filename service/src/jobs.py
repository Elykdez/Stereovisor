from __future__ import annotations

import logging
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from threading import Condition, RLock
from uuid import uuid4

from pydantic import TypeAdapter

from .schemas import ComputeStatus, JobKind, JobResult, ProcessingJobPayload, ServerActivity

logger = logging.getLogger(__name__)


TERMINAL_STATES = ("completed", "failed", "cancelled")
JOB_RESULT_ADAPTER = TypeAdapter(JobResult)

# Completed work is kept long enough for a renderer to collect its result after
# a reload, then removed so the store does not grow for the life of a machine.
DEFAULT_RETENTION_SECONDS = 3600.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id           TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    state            TEXT NOT NULL,
    progress         INTEGER NOT NULL,
    stage            TEXT NOT NULL,
    message          TEXT NOT NULL,
    queue_position   INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at       REAL NOT NULL,
    updated_at       REAL NOT NULL,
    compute_json     TEXT,
    compute_started_at REAL,
    compute_updated_at REAL
);
-- Results are a separate row so status polling never reads the payload blob.
CREATE TABLE IF NOT EXISTS job_results (
    job_id  TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_updated_at ON jobs (updated_at);
"""


class JobCancelled(RuntimeError):
    """Raised inside a worker when the user cancels its processing job."""


JobListener = Callable[[ProcessingJobPayload], None]


class ProcessingJobStore:
    """Durable job state.

    SQLite is the source of truth so a job survives a service restart: a
    renderer that reconnects gets a real terminal state instead of a 404. The
    default (no path) is an in-memory database, which keeps tests isolated.
    """

    def __init__(
        self,
        listener: JobListener | None = None,
        *,
        path: Path | str | None = None,
        retention_seconds: float = DEFAULT_RETENTION_SECONDS,
    ) -> None:
        # One connection guarded by a lock. Write volume is a few hundred rows
        # per job, so a pool would add moving parts for no measurable gain.
        self._lock = RLock()
        self._changed = Condition(self._lock)
        self._listener = listener
        self._retention_seconds = retention_seconds
        self._path = str(path) if path is not None else ":memory:"
        if path is not None:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self._path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            if path is not None:
                # WAL keeps a reader (status polling) from blocking the worker.
                self._connection.execute("PRAGMA journal_mode=WAL")
                # Every progress tick commits, and under WAL a full sync makes
                # each one wait on the disk - about 0.4 ms against 0.06 ms here.
                # NORMAL risks losing the last commits to an OS crash, which
                # costs nothing: a job interrupted that way cannot be resumed
                # anyway, and fail_interrupted already terminates it on startup.
                self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.executescript(SCHEMA)
            columns = {row["name"] for row in self._connection.execute("PRAGMA table_info(jobs)")}
            for name, kind in (("compute_json", "TEXT"), ("compute_started_at", "REAL"), ("compute_updated_at", "REAL")):
                if name not in columns:
                    self._connection.execute(f"ALTER TABLE jobs ADD COLUMN {name} {kind}")
            self._connection.commit()

    # ------------------------------------------------------------------ util

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _row(self, job_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
        if row is None:
            raise KeyError(job_id)
        return row

    def _result(self, job_id: str) -> JobResult | None:
        row = self._connection.execute(
            "SELECT payload FROM job_results WHERE job_id = ?", (job_id,)
        ).fetchone()
        return JOB_RESULT_ADAPTER.validate_json(row["payload"]) if row else None

    def _payload(
        self, row: sqlite3.Row, *, with_result: bool = True
    ) -> ProcessingJobPayload:
        compute = None
        if row["state"] == "running" and row["compute_json"]:
            now = time.time()
            compute = ComputeStatus.model_validate_json(row["compute_json"]).model_copy(update={
                "elapsedSeconds": max(0, int(now - row["compute_started_at"])),
                "idleSeconds": max(0, int(now - row["compute_updated_at"])),
            })
        return ProcessingJobPayload(
            jobId=row["job_id"],
            kind=row["kind"],
            state=row["state"],
            progress=row["progress"],
            stage=row["stage"],
            message=row["message"],
            queuePosition=row["queue_position"],
            compute=compute,
            result=self._result(row["job_id"]) if with_result else None,
        )

    def _notify(self, payload: ProcessingJobPayload | None) -> None:
        # Outside the lock: a listener must never stall an inference worker.
        if payload is None or self._listener is None:
            return
        try:
            self._listener(payload)
        except Exception:  # pragma: no cover - defensive
            logger.exception("job listener failed: id=%s", payload.jobId)

    def _write(
        self,
        job_id: str,
        *,
        state: str | None = None,
        progress: int | None = None,
        stage: str | None = None,
        message: str | None = None,
        queue_position: int | None = -1,
        cancel_requested: bool | None = None,
    ) -> ProcessingJobPayload | None:
        """Apply a change and return a snapshot only if something observable moved."""
        row = self._row(job_id)
        updated = {
            "state": state if state is not None else row["state"],
            "progress": progress if progress is not None else row["progress"],
            "stage": stage if stage is not None else row["stage"],
            "message": message if message is not None else row["message"],
            # -1 is the "leave alone" sentinel; None is a real value here.
            "queue_position": (
                row["queue_position"] if queue_position == -1 else queue_position
            ),
            "cancel_requested": int(
                row["cancel_requested"]
                if cancel_requested is None
                else cancel_requested
            ),
        }
        keep_compute = updated["state"] == "running" and updated["stage"] == row["stage"]
        for key in ("compute_json", "compute_started_at", "compute_updated_at"):
            updated[key] = row[key] if keep_compute else None
        observable = ("state", "progress", "stage", "message", "queue_position")
        if (
            all(updated[key] == row[key] for key in observable)
            and updated["cancel_requested"] == row["cancel_requested"]
        ):
            return None
        self._connection.execute(
            """
            UPDATE jobs
               SET state = ?, progress = ?, stage = ?, message = ?,
                   queue_position = ?, cancel_requested = ?, updated_at = ?,
                   compute_json = ?, compute_started_at = ?, compute_updated_at = ?
             WHERE job_id = ?
            """,
            (
                updated["state"],
                updated["progress"],
                updated["stage"],
                updated["message"],
                updated["queue_position"],
                updated["cancel_requested"],
                time.time(),
                updated["compute_json"],
                updated["compute_started_at"],
                updated["compute_updated_at"],
                job_id,
            ),
        )
        self._connection.commit()
        self._changed.notify_all()
        if all(updated[key] == row[key] for key in observable):
            # A pure cancel-flag write is persisted but is not an observable
            # transition on its own; the state change that follows reports it.
            return None
        return self._payload(
            self._row(job_id), with_result=updated["state"] == "completed"
        )

    # ----------------------------------------------------------------- write

    def create(self, kind: JobKind) -> str:
        job_id = uuid4().hex
        now = time.time()
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO jobs
                    (job_id, kind, state, progress, stage, message,
                     queue_position, cancel_requested, created_at, updated_at)
                VALUES (?, ?, 'queued', 0, 'Queued', ?, NULL, 0, ?, ?)
                """,
                (job_id, kind, "Waiting for the local AI worker.", now, now),
            )
            self._connection.commit()
            payload = self._payload(self._row(job_id))
            self._changed.notify_all()
        self._notify(payload)
        logger.info("job queued: id=%s kind=%s", job_id, kind)
        return job_id

    def update(self, job_id: str, progress: int, stage: str, message: str) -> None:
        with self._lock:
            row = self._row(job_id)
            if row["cancel_requested"] or row["state"] == "cancelled":
                raise JobCancelled("Processing cancelled.")
            previous_stage = row["stage"]
            payload = self._write(
                job_id,
                state="running",
                # Progress never goes backwards, and 100 is reserved for a
                # committed result.
                progress=max(row["progress"], min(99, max(0, int(progress)))),
                stage=stage,
                message=message,
                queue_position=None,
            )
        if payload is not None and stage != previous_stage:
            logger.info(
                "job stage: id=%s progress=%s stage=%s", job_id, payload.progress, stage
            )
        self._notify(payload)

    def set_compute(self, job_id: str, status: ComputeStatus | None) -> None:
        with self._lock:
            row = self._row(job_id)
            # A model releasing memory after cancellation cannot revive its job.
            if row["state"] != "running":
                return
            previous = ComputeStatus.model_validate_json(row["compute_json"]) if row["compute_json"] else None
            now = time.time()
            same_phase = previous is not None and status is not None and (
                previous.model, previous.device, previous.phase
            ) == (status.model, status.device, status.phase)
            self._connection.execute(
                "UPDATE jobs SET compute_json = ?, compute_started_at = ?, compute_updated_at = ?, updated_at = ? WHERE job_id = ?",
                (
                    status.model_dump_json() if status is not None else None,
                    row["compute_started_at"] if same_phase else now,
                    now, now, job_id,
                ),
            )
            self._connection.commit()
            payload = self._payload(self._row(job_id), with_result=False)
            self._changed.notify_all()
        self._notify(payload)

    def complete(self, job_id: str, result: JobResult) -> None:
        with self._lock:
            row = self._row(job_id)
            if row["cancel_requested"] or row["state"] == "cancelled":
                raise JobCancelled("Processing cancelled.")
            self._connection.execute(
                "INSERT OR REPLACE INTO job_results (job_id, payload) VALUES (?, ?)",
                (job_id, result.model_dump_json()),
            )
            payload = self._write(
                job_id,
                state="completed",
                progress=100,
                stage="Complete",
                message="Local processing finished.",
                queue_position=None,
            )
        self._notify(payload)
        logger.info("job completed: id=%s kind=%s", job_id, row["kind"])

    def fail(self, job_id: str, message: str) -> None:
        with self._lock:
            if self._row(job_id)["state"] == "cancelled":
                return
            payload = self._write(
                job_id,
                state="failed",
                stage="Failed",
                message=message,
                queue_position=None,
            )
        self._notify(payload)
        logger.warning("job failed: id=%s message=%s", job_id, message)

    def cancel(self, job_id: str) -> ProcessingJobPayload:
        # Idempotent: a terminal job is reported as-is, while an active job
        # becomes terminal and loses any pending result.
        with self._lock:
            row = self._row(job_id)
            payload: ProcessingJobPayload | None = None
            if row["state"] not in TERMINAL_STATES:
                self._connection.execute(
                    "DELETE FROM job_results WHERE job_id = ?", (job_id,)
                )
                payload = self._write(
                    job_id,
                    state="cancelled",
                    stage="Cancelled",
                    message="Processing cancelled by the user.",
                    queue_position=None,
                    cancel_requested=True,
                )
            snapshot = self._payload(self._row(job_id))
        self._notify(payload)
        logger.info(
            "job cancellation requested: id=%s state=%s", job_id, snapshot.state
        )
        return snapshot

    def set_queue_position(self, job_id: str, position: int | None) -> None:
        """Report how many jobs are ahead of this one, or None once it runs."""
        with self._lock:
            try:
                row = self._row(job_id)
            except KeyError:
                return
            if row["state"] != "queued":
                return
            # "Nothing ahead of me" and "not waiting behind anything" are the
            # same thing to a client, so both normalize to None. Without this a
            # backlog-free job emits three identical queued frames: one on
            # create, one on submit, one when the worker picks it up.
            backlog = position if position else None
            message = (
                "Waiting for the local AI worker."
                if backlog is None
                else f"Waiting for the local AI worker ({backlog} ahead)."
            )
            payload = self._write(job_id, message=message, queue_position=backlog)
        self._notify(payload)

    def fail_interrupted(self) -> int:
        """Terminate jobs left mid-flight by a crash or restart.

        GPU work cannot be resumed, so the honest outcome is an explanatory
        failure rather than a job that appears to be running with no worker.
        """
        with self._lock:
            stale = [
                row["job_id"]
                for row in self._connection.execute(
                    "SELECT job_id FROM jobs WHERE state IN ('queued', 'running')"
                ).fetchall()
            ]
            payloads = [
                self._write(
                    job_id,
                    state="failed",
                    stage="Failed",
                    message="The local service restarted while this job was running.",
                    queue_position=None,
                )
                for job_id in stale
            ]
        for payload in payloads:
            self._notify(payload)
        if stale:
            logger.warning("interrupted jobs failed on startup: count=%s", len(stale))
        return len(stale)

    def evict_expired(self, now: float | None = None) -> int:
        moment = time.time() if now is None else now
        cutoff = moment - self._retention_seconds
        with self._lock:
            expired = [
                row["job_id"]
                for row in self._connection.execute(
                    "SELECT job_id FROM jobs WHERE state IN (?, ?, ?) AND updated_at < ?",
                    (*TERMINAL_STATES, cutoff),
                ).fetchall()
            ]
            if expired:
                marks = ",".join("?" for _ in expired)
                self._connection.execute(
                    f"DELETE FROM job_results WHERE job_id IN ({marks})", expired
                )
                self._connection.execute(
                    f"DELETE FROM jobs WHERE job_id IN ({marks})", expired
                )
                self._connection.commit()
                logger.info("expired jobs evicted: count=%s", len(expired))
        return len(expired)

    # ------------------------------------------------------------------ read

    def ensure_active(self, job_id: str) -> None:
        # The cooperative cancellation gate used before expensive stages and
        # immediately before committing a project to disk.
        with self._lock:
            row = self._row(job_id)
            if row["cancel_requested"] or row["state"] == "cancelled":
                raise JobCancelled("Processing cancelled.")

    def read(self, job_id: str) -> ProcessingJobPayload:
        with self._lock:
            return self._payload(self._row(job_id))

    def activity(self, *, worker_busy: bool = False) -> ServerActivity:
        with self._lock:
            queued = self._connection.execute("SELECT count(*) FROM jobs WHERE state = 'queued'").fetchone()[0]
            row = self._connection.execute(
                "SELECT * FROM jobs WHERE state = 'running' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is not None:
                job = self._payload(row, with_result=False)
                return ServerActivity(state="running", queuedJobs=queued, stage=job.stage, compute=job.compute)
            # Cancellation is terminal for the client before a model finishes
            # its cooperative stop. Keep that interval distinct from idle.
            state = "queued" if queued else "stopping" if worker_busy else "idle"
            return ServerActivity(state=state, queuedJobs=queued)

    def wait_for_terminal(
        self, job_id: str, timeout: float = 30.0
    ) -> ProcessingJobPayload:
        """Block until a job reaches a terminal state.

        Used by shutdown and by tests; the HTTP API never waits on a job.
        """
        deadline = time.monotonic() + timeout
        with self._lock:
            while True:
                row = self._row(job_id)
                if row["state"] in TERMINAL_STATES:
                    return self._payload(row)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return self._payload(row)
                self._changed.wait(remaining)
