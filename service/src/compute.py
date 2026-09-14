from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from time import monotonic
from typing import Any

from .config import DEVICE
from .jobs import JobCancelled
from .schemas import ComputeStatus

logger = logging.getLogger(__name__)
ComputeReporter = Callable[[ComputeStatus | None], None]
_reporter: ContextVar[ComputeReporter | None] = ContextVar("compute_reporter", default=None)
_cancelled: ContextVar[Callable[[], None] | None] = ContextVar("compute_cancelled", default=None)


@dataclass
class _ComputeTrace:
    job_id: str | None
    latest: ComputeStatus | None = None
    last_work_phase: str | None = None
    logged_key: tuple | None = None
    logged_at: float = 0


_trace: ContextVar[_ComputeTrace | None] = ContextVar("compute_trace", default=None)


def _log_compute(
    status: ComputeStatus, *, event: str = "activity", memory_source: str = "reported",
    error: Exception | None = None,
) -> None:
    trace = _trace.get()
    if trace is None:
        return
    trace.latest = status
    if status.phase != "cleanup":
        trace.last_work_phase = status.phase
    used, total = status.vramUsedMb, status.vramTotalMb
    free = total - used if used is not None and total is not None else None
    pressure = used / total >= 0.9 if used is not None and total else None
    key = (status.model, status.device, status.phase, status.reason, pressure)
    now = monotonic()
    # Record transitions immediately, with at most one repeated activity line
    # per ten seconds. UI/token updates keep their existing faster cadence.
    if event == "activity" and key == trace.logged_key and now - trace.logged_at < 10:
        return
    trace.logged_key, trace.logged_at = key, now
    record = {
        "event": event, "jobId": trace.job_id, "pid": os.getpid(),
        "model": status.model, "device": status.device, "phase": status.phase,
        "reason": status.reason, "gpuName": status.gpuName,
        "gpuUsedMb": used, "gpuFreeMb": free, "gpuTotalMb": total,
        "memoryPressure": pressure, "memorySource": memory_source,
        "completed": status.completed, "total": status.total, "unit": status.unit,
    }
    if error is not None:
        record.update(errorType=type(error).__name__, lastWorkPhase=trace.last_work_phase)
    level = logging.WARNING if pressure or event == "failed" else logging.INFO
    logger.log(level, "gpu.compute %s", json.dumps(record, separators=(",", ":")))


@contextmanager
def compute_scope(
    reporter: ComputeReporter, cancelled: Callable[[], None], *, job_id: str | None = None,
) -> Iterator[None]:
    # The queue worker owns this context; model helpers keep their public APIs
    # and cannot leak one job's status into another job or a health request.
    reporter_token = _reporter.set(reporter)
    cancel_token = _cancelled.set(cancelled)
    trace_token = _trace.set(_ComputeTrace(job_id))
    try:
        yield
    except Exception as error:
        trace = _trace.get()
        if trace is not None and trace.latest is not None:
            _log_compute(trace.latest, event="cancelled" if isinstance(error, JobCancelled) else "failed",
                         memory_source="last_reported", error=error)
        raise
    finally:
        _trace.reset(trace_token)
        _cancelled.reset(cancel_token)
        _reporter.reset(reporter_token)


def check_compute_cancelled() -> None:
    cancelled = _cancelled.get()
    if cancelled is not None:
        cancelled()


def publish_compute(status: ComputeStatus | dict | None, *, memory_source: str = "reported") -> None:
    reporter = _reporter.get()
    if reporter is not None:
        payload = ComputeStatus.model_validate(status) if status is not None else None
        if payload is not None:
            _log_compute(payload, memory_source=memory_source)
        try:
            reporter(payload)
        except Exception:
            logger.warning("Could not publish compute status", exc_info=True)


def clear_compute(torch_module: Any = None) -> None:
    trace = _trace.get()
    if trace is not None and trace.latest is not None:
        status = trace.latest
        if torch_module is not None and status.device in ("cuda", "hybrid"):
            # This sample runs after the caller deletes tensors and releases CUDA.
            memory = _gpu_memory(torch_module)
            status = status.model_copy(update={"gpuName": None, "vramUsedMb": None,
                                               "vramTotalMb": None, **memory})
            _log_compute(status, event="released", memory_source="sampled")
        else:
            _log_compute(status, event="cleared", memory_source="last_reported")
    publish_compute(None)


def _gpu_memory(torch_module: Any) -> dict[str, Any]:
    try:
        free, capacity = torch_module.cuda.mem_get_info()
        return {
            "gpuName": torch_module.cuda.get_device_name(),
            "vramUsedMb": round((capacity - free) / 1048576),
            "vramTotalMb": round(capacity / 1048576),
        }
    except Exception:
        logger.debug("GPU memory snapshot unavailable", exc_info=True)
        return {}


def report_compute(
    torch_module: Any,
    model: str,
    device: str,
    phase: str,
    *,
    reason: str | None = None,
    completed: int | None = None,
    total: int | None = None,
    unit: str | None = None,
) -> None:
    if _reporter.get() is None:
        return
    if phase != "cleanup":
        check_compute_cancelled()
    memory: dict[str, Any] = {}
    if device in ("cuda", "hybrid"):
        # Sample only at model activity boundaries, never on an HTTP polling
        # thread. A missing memory API must not prevent inference or cancellation.
        memory = _gpu_memory(torch_module)
    elif device == "cpu" and reason is None:
        reason = "cpu_requested" if DEVICE == "cpu" else "cuda_unavailable"
    publish_compute(ComputeStatus(
        model=model, device=device, phase=phase, reason=reason,
        completed=completed, total=total, unit=unit, **memory,
    ), memory_source="sampled")
