import json
import logging
from types import SimpleNamespace

import pytest

from service.src import compute
from service.src.jobs import JobCancelled


def test_compute_reports_actual_device_and_memory_without_loading_torch(monkeypatch):
    statuses = []
    fake_torch = SimpleNamespace(cuda=SimpleNamespace(
        mem_get_info=lambda: (512 * 1048576, 8192 * 1048576),
        get_device_name=lambda: "Test GPU",
    ))
    with compute.compute_scope(statuses.append, lambda: None):
        compute.report_compute(fake_torch, "Qwen3-VL", "cuda", "inference", completed=8, total=96, unit="tokens")
        monkeypatch.setattr(compute, "DEVICE", "cpu")
        compute.report_compute(None, "Qwen3-VL", "cpu", "loading")
        monkeypatch.setattr(compute, "DEVICE", "auto")
        compute.report_compute(None, "Qwen3-VL", "cpu", "inference")
    assert statuses[0].vramUsedMb == 7680
    assert statuses[0].vramTotalMb == 8192
    assert statuses[0].gpuName == "Test GPU"
    assert statuses[0].completed == 8
    assert statuses[1].vramUsedMb is None
    assert statuses[1].reason == "cpu_requested"
    assert statuses[2].reason == "cuda_unavailable"


def test_missing_memory_telemetry_does_not_change_selected_device():
    statuses = []
    with compute.compute_scope(statuses.append, lambda: None):
        compute.report_compute(None, "PowerPaint", "hybrid", "loading", reason="offloading")
    assert statuses[0].device == "hybrid"
    assert statuses[0].vramTotalMb is None
    assert statuses[0].reason == "offloading"


def test_mps_compute_status_does_not_report_cuda_as_unavailable():
    statuses = []
    with compute.compute_scope(statuses.append, lambda: None):
        compute.report_compute(None, "SAM 2.1 Small", "mps", "inference")
    assert statuses[0].device == "mps"
    assert statuses[0].reason is None


def test_compute_context_is_restored_after_failure_and_cleanup_can_run_after_cancel():
    statuses = []

    def cancelled():
        raise JobCancelled("cancelled")

    with pytest.raises(JobCancelled), compute.compute_scope(statuses.append, cancelled):
        try:
            compute.report_compute(None, "Qwen3-VL", "cpu", "inference")
        finally:
            compute.report_compute(None, "Qwen3-VL", "cpu", "cleanup")
            compute.clear_compute()
    compute.report_compute(None, "another job", "cpu", "loading")
    assert len(statuses) == 2
    assert statuses[0].phase == "cleanup"
    assert statuses[1] is None


def test_a_telemetry_listener_error_does_not_abort_model_cleanup():
    def broken_listener(_status):
        raise OSError("unavailable telemetry")

    with compute.compute_scope(broken_listener, lambda: None):
        compute.report_compute(None, "Qwen3-VL", "cpu", "cleanup")
        compute.clear_compute()


def gpu_logs(caplog):
    return [json.loads(record.getMessage().split(" ", 1)[1])
            for record in caplog.records if record.getMessage().startswith("gpu.compute ")]


def test_gpu_logs_track_job_phases_pressure_and_release_without_token_spam(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="service.src.compute")
    clock = [0.0]
    monkeypatch.setattr(compute, "monotonic", lambda: clock[0])
    free_mb = [2048]
    torch = SimpleNamespace(cuda=SimpleNamespace(
        mem_get_info=lambda: (free_mb[0] * 1048576, 8192 * 1048576),
        get_device_name=lambda: "Test GPU",
    ))
    with compute.compute_scope(lambda _: None, lambda: None, job_id="job-a"):
        compute.report_compute(torch, "Qwen3-VL", "cuda", "loading")
        compute.report_compute(torch, "Qwen3-VL", "cuda", "inference", completed=0, total=96, unit="tokens")
        for count in range(1, 10):
            clock[0] += 1
            compute.report_compute(torch, "Qwen3-VL", "cuda", "inference", completed=count, total=96, unit="tokens")
        assert len(gpu_logs(caplog)) == 2
        clock[0] = 10
        compute.report_compute(torch, "Qwen3-VL", "cuda", "inference", completed=10, total=96, unit="tokens")
        free_mb[0] = 256
        compute.report_compute(torch, "Qwen3-VL", "cuda", "inference", completed=11, total=96, unit="tokens")
        compute.report_compute(torch, "Qwen3-VL", "cuda", "cleanup")
        free_mb[0] = 7168
        compute.clear_compute(torch)
    logs = gpu_logs(caplog)
    assert [item["event"] for item in logs] == ["activity"] * 5 + ["released"]
    assert all(item["jobId"] == "job-a" for item in logs)
    assert logs[0]["gpuUsedMb"] == 6144
    assert logs[0]["gpuFreeMb"] == 2048
    assert logs[0]["gpuTotalMb"] == 8192
    assert logs[2]["completed"] == 10
    assert logs[3]["memoryPressure"] is True
    assert logs[-1]["gpuUsedMb"] == 1024
    assert logs[-1]["memorySource"] == "sampled"
    assert any(record.levelno == logging.WARNING for record in caplog.records)


def test_runner_logs_keep_reported_memory_and_failure_context_after_clear(caplog):
    caplog.set_level(logging.INFO, logger="service.src.compute")
    with pytest.raises(RuntimeError), compute.compute_scope(lambda _: None, lambda: None, job_id="runner-job"):
        compute.publish_compute({"model": "PowerPaint", "device": "hybrid", "phase": "inference",
                                 "gpuName": "Child GPU", "vramUsedMb": 7680, "vramTotalMb": 8192})
        compute.publish_compute({"model": "PowerPaint", "device": "hybrid", "phase": "cleanup",
                                 "gpuName": "Child GPU", "vramUsedMb": 7680, "vramTotalMb": 8192})
        compute.clear_compute()
        raise RuntimeError("CUDA out of memory")
    failure = gpu_logs(caplog)[-1]
    assert failure["event"] == "failed"
    assert failure["jobId"] == "runner-job"
    assert failure["lastWorkPhase"] == "inference"
    assert failure["gpuUsedMb"] == 7680
    assert failure["memorySource"] == "last_reported"
    assert failure["errorType"] == "RuntimeError"


def test_cpu_cancel_logs_unknown_memory_and_nested_jobs_restore_context(caplog):
    caplog.set_level(logging.INFO, logger="service.src.compute")
    with compute.compute_scope(lambda _: None, lambda: None, job_id="outer"):
        compute.report_compute(None, "Big LaMa", "cpu", "loading")
        with pytest.raises(JobCancelled), compute.compute_scope(lambda _: None, lambda: None, job_id="inner"):
            compute.report_compute(None, "Qwen3-VL", "cpu", "inference")
            raise JobCancelled("cancelled")
        compute.report_compute(None, "Big LaMa", "cpu", "cleanup")
    before = len(gpu_logs(caplog))
    compute.publish_compute({"model": "PowerPaint", "device": "hybrid", "phase": "loading"})
    logs = gpu_logs(caplog)
    assert len(logs) == before
    assert [item["jobId"] for item in logs] == ["outer", "inner", "inner", "outer"]
    assert logs[2]["event"] == "cancelled"
    assert logs[2]["gpuUsedMb"] is None
