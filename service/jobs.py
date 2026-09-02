from __future__ import annotations

from dataclasses import dataclass
import logging
from threading import Lock
from typing import Literal
from uuid import uuid4

from .schemas import ProcessingJobPayload, ProjectPayload


logger = logging.getLogger(__name__)


JobKind = Literal["analyze", "refine", "inpaint"]
JobState = Literal["queued", "running", "completed", "failed", "cancelled"]


class JobCancelled(RuntimeError):
    """Raised inside a worker when the user cancels its processing job."""


@dataclass
class _JobRecord:
    job_id: str
    kind: JobKind
    state: JobState
    progress: int
    stage: str
    message: str
    result: ProjectPayload | None = None
    cancel_requested: bool = False


class ProcessingJobStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._jobs: dict[str, _JobRecord] = {}

    def create(self, kind: JobKind) -> str:
        job_id = uuid4().hex
        # The lock guards the in-memory registry because FastAPI background
        # workers and polling requests can touch it concurrently.
        with self._lock:
            self._jobs[job_id] = _JobRecord(
                job_id=job_id,
                kind=kind,
                state="queued",
                progress=0,
                stage="Queued",
                message="Waiting for the local AI worker.",
            )
        logger.info("job queued: id=%s kind=%s", job_id, kind)
        return job_id

    def update(self, job_id: str, progress: int, stage: str, message: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if job.cancel_requested or job.state == "cancelled":
                raise JobCancelled("Processing cancelled.")
            previous_stage = job.stage
            job.state = "running"
            # Progress callbacks can fire many times per second. Log only a
            # stage transition so diagnostics stay useful without becoming a
            # second progress stream.
            job.progress = max(job.progress, min(99, max(0, int(progress))))
            job.stage = stage
            job.message = message
            if stage != previous_stage:
                logger.info("job stage: id=%s progress=%s stage=%s", job_id, job.progress, stage)

    def complete(self, job_id: str, result: ProjectPayload) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if job.cancel_requested or job.state == "cancelled":
                raise JobCancelled("Processing cancelled.")
            job.state = "completed"
            job.progress = 100
            job.stage = "Complete"
            job.message = "Local processing finished."
            job.result = result
        logger.info("job completed: id=%s layers=%s", job_id, len(result.layers))

    def fail(self, job_id: str, message: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if job.state == "cancelled":
                return
            job.state = "failed"
            job.stage = "Failed"
            job.message = message
        logger.warning("job failed: id=%s message=%s", job_id, message)

    def cancel(self, job_id: str) -> ProcessingJobPayload:
        # Cancellation is idempotent: a completed/failed job is reported as-is,
        # while an active job becomes terminal and loses any pending result.
        with self._lock:
            job = self._jobs[job_id]
            if job.state not in {"completed", "failed", "cancelled"}:
                job.cancel_requested = True
                job.state = "cancelled"
                job.stage = "Cancelled"
                job.message = "Processing cancelled by the user."
                job.result = None
            payload = ProcessingJobPayload(
                jobId=job.job_id,
                kind=job.kind,
                state=job.state,
                progress=job.progress,
                stage=job.stage,
                message=job.message,
                result=job.result,
            )
        logger.info("job cancellation requested: id=%s state=%s", job_id, payload.state)
        return payload

    def ensure_active(self, job_id: str) -> None:
        # This is the cooperative cancellation gate used before expensive
        # stages and immediately before committing a project to disk.
        with self._lock:
            job = self._jobs[job_id]
            if job.cancel_requested or job.state == "cancelled":
                raise JobCancelled("Processing cancelled.")

    def read(self, job_id: str) -> ProcessingJobPayload:
        # Polling returns a snapshot while holding the lock, never the mutable
        # internal record itself.
        with self._lock:
            job = self._jobs[job_id]
            return ProcessingJobPayload(
                jobId=job.job_id,
                kind=job.kind,
                state=job.state,
                progress=job.progress,
                stage=job.stage,
                message=job.message,
                result=job.result,
            )
