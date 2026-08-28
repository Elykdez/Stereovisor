from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Literal
from uuid import uuid4

from .schemas import ProcessingJobPayload, ProjectPayload


JobKind = Literal["analyze", "refine", "inpaint"]
JobState = Literal["queued", "running", "completed", "failed"]


@dataclass
class _JobRecord:
    job_id: str
    kind: JobKind
    state: JobState
    progress: int
    stage: str
    message: str
    result: ProjectPayload | None = None


class ProcessingJobStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._jobs: dict[str, _JobRecord] = {}

    def create(self, kind: JobKind) -> str:
        job_id = uuid4().hex
        with self._lock:
            self._jobs[job_id] = _JobRecord(
                job_id=job_id,
                kind=kind,
                state="queued",
                progress=0,
                stage="Queued",
                message="Waiting for the local AI worker.",
            )
        return job_id

    def update(self, job_id: str, progress: int, stage: str, message: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.state = "running"
            job.progress = max(job.progress, min(99, max(0, int(progress))))
            job.stage = stage
            job.message = message

    def complete(self, job_id: str, result: ProjectPayload) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.state = "completed"
            job.progress = 100
            job.stage = "Complete"
            job.message = "Local processing finished."
            job.result = result

    def fail(self, job_id: str, message: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job.state = "failed"
            job.stage = "Failed"
            job.message = message

    def read(self, job_id: str) -> ProcessingJobPayload:
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
