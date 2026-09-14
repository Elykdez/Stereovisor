import json
import sys
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
from PIL import Image

from service.src import refinement
from service.src.compute import compute_scope
from service.src.jobs import JobCancelled
from service.src.refinement import _parse_object_vocabulary


def test_vlm_vocabulary_parser_accepts_json_and_removes_duplicates() -> None:
    assert _parse_object_vocabulary('["Person", "keyboard", "person"]') == (
        "person",
        "keyboard",
    )


def test_vlm_vocabulary_parser_removes_reasoning_and_prefixes() -> None:
    assert _parse_object_vocabulary(
        "<think>inspect the scene</think>Objects: person, cup, monitor"
    ) == ("person", "cup", "monitor")


@pytest.fixture
def qwen_runtime(monkeypatch):
    class Inputs(dict):
        def __init__(self):
            self.input_ids = np.asarray([[1, 2, 3]])
            super().__init__(input_ids=self.input_ids)

        def to(self, device):
            return self

    processor = SimpleNamespace(
        apply_chat_template=Mock(return_value=Inputs()),
        batch_decode=Mock(return_value=["sunlit stone room"]),
    )
    model = Mock()
    model.to.return_value = model
    model.eval.return_value = model
    torch = SimpleNamespace(
        cuda=SimpleNamespace(
            mem_get_info=lambda: (1024 * 1048576, 8192 * 1048576),
            get_device_name=lambda: "Test GPU",
        ),
        float16="float16", float32="float32", inference_mode=nullcontext,
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(
        AutoProcessor=SimpleNamespace(from_pretrained=Mock(return_value=processor)),
        Qwen3VLForConditionalGeneration=SimpleNamespace(from_pretrained=Mock(return_value=model)),
        StoppingCriteria=object, StoppingCriteriaList=list,
    ))
    monkeypatch.setattr(refinement, "snapshot_ready", lambda *args: True)
    monkeypatch.setattr(refinement, "resolve_device", lambda module: "cuda")
    monkeypatch.setattr(refinement, "begin_vram_stage", lambda module: None)
    monkeypatch.setattr(refinement, "peak_vram_mb", lambda module: 64)
    release = Mock()
    monkeypatch.setattr(refinement, "release_cuda", release)
    return SimpleNamespace(model=model, processor=processor, release=release)


def test_qwen_reports_real_token_activity_and_bounds_image(monkeypatch, qwen_runtime):
    def generate(input_ids, stopping_criteria, **kwargs):
        for count in range(1, 6):
            output = np.zeros((1, input_ids.shape[-1] + count), dtype=int)
            assert stopping_criteria[0](output, None) is False
        return output

    qwen_runtime.model.generate.side_effect = generate
    moments = iter([0, 0.1, 0.2, 0.3, 1.2, 1.3])
    monkeypatch.setattr(refinement.time, "monotonic", lambda: next(moments))
    reports = []
    source = Image.new("RGB", (2048, 1024))
    with compute_scope(reports.append, lambda: None):
        prompt, peak = refinement._run_qwen(source, "describe", 8, "test caption")

    assert (prompt, peak) == ("sunlit stone room", 64)
    prepared = qwen_runtime.processor.apply_chat_template.call_args.args[0][0]["content"][0]["image"]
    assert prepared.size == (1024, 512)
    assert source.size == (2048, 1024)
    assert [report.phase for report in reports if report is not None] == [
        "loading", "preparing", "inference", "inference", "inference", "inference", "cleanup",
    ]
    activity = [report for report in reports if report and report.phase == "inference"]
    assert [report.completed for report in activity] == [0, 1, 4, 5]
    assert all(report.total == 8 and report.unit == "tokens" for report in activity)
    assert all(report.device == "cuda" and report.gpuName == "Test GPU" for report in activity)
    assert reports[-1] is None
    qwen_runtime.release.assert_called_once()


def test_qwen_cancellation_interrupts_tokens_and_releases_model(qwen_runtime):
    requested = False

    def cancelled():
        if requested:
            raise JobCancelled("cancelled")

    def generate(input_ids, stopping_criteria, **kwargs):
        nonlocal requested
        stopping_criteria[0](np.zeros((1, 4)), None)
        requested = True
        stopping_criteria[0](np.zeros((1, 5)), None)
        pytest.fail("generation continued after cancellation")

    qwen_runtime.model.generate.side_effect = generate
    reports = []
    with compute_scope(reports.append, cancelled), pytest.raises(JobCancelled):
        refinement._run_qwen(Image.new("RGB", (8, 8)), "describe", 8, "test caption")

    assert reports[-2].phase == "cleanup"
    assert reports[-1] is None
    qwen_runtime.release.assert_called_once()
    qwen_runtime.processor.batch_decode.assert_not_called()


def test_qwen_out_of_memory_explains_recovery_and_releases_model(qwen_runtime):
    failure = RuntimeError("CUDA out of memory")
    qwen_runtime.model.generate.side_effect = failure
    reports = []
    with compute_scope(reports.append, lambda: None), pytest.raises(RuntimeError) as raised:
        refinement.generate_background_prompt(Image.new("RGB", (8, 8)))

    assert "Close other GPU applications" in str(raised.value)
    assert "STEREOVISOR_DEVICE=cpu" in str(raised.value)
    assert raised.value.__cause__ is failure
    assert reports[-1] is None
    qwen_runtime.release.assert_called_once()


@pytest.mark.parametrize("step", [0, 1])
def test_powerpaint_status_follows_progress_and_includes_loading(monkeypatch, tmp_path: Path, step):
    python = tmp_path / "python.exe"
    python.touch()
    monkeypatch.setattr(refinement, "POWERPAINT_PYTHON", python)
    monkeypatch.setattr(refinement, "POWERPAINT_VENDOR", tmp_path)
    monkeypatch.setattr(refinement, "powerpaint_snapshot_ready", lambda path: True)
    monkeypatch.setattr(refinement.time, "sleep", lambda seconds: None)
    phase = "loading" if step == 0 else "inference"
    status = {"model": "PowerPaint", "device": "hybrid", "phase": phase, "reason": "offloading"}
    if step:
        status.update(completed=step, total=5, unit="steps")

    def start_process(command, **kwargs):
        (tmp_path / ".powerpaint-progress.json").write_text(json.dumps({
            "step": step, "total": 5, "compute": status,
        }), encoding="utf-8")
        kwargs["stdout"].write('{"peak_vram_mb": 64}\n')
        return SimpleNamespace(
            pid=1, returncode=0, poll=Mock(side_effect=[None, None, 0, 0]),
        )

    monkeypatch.setattr(refinement.subprocess, "Popen", start_process)
    reports = []
    order = []

    def report_compute(status):
        reports.append(status)
        order.append("compute")

    with compute_scope(report_compute, lambda: None):
        peak = refinement.powerpaint_inpaint(
            tmp_path / "source.png", tmp_path / "mask.png", tmp_path / "output.png", "empty room",
            progress=(lambda step, total: order.append("progress")) if step else None,
        )

    assert peak == 64
    assert [report.phase for report in reports if report] == [phase, "cleanup"]
    assert order == (["progress"] if step else []) + ["compute", "compute", "compute"]
    assert reports[0].device == "hybrid"
    assert reports[-2].completed is reports[-2].total is reports[-2].unit is None
    assert reports[-1] is None
    assert not (tmp_path / ".powerpaint-progress.json").exists()
    assert not (tmp_path / ".powerpaint-runner.log").exists()


@pytest.mark.parametrize("output,detail", [
    ("Successfully added embeddings", "Successfully added embeddings"),
    ("CUDA out of memory", "Close other GPU applications"),
])
@pytest.mark.parametrize("device,reason", [("cpu", None), ("hybrid", "offloading")])
def test_powerpaint_failure_retains_diagnostics_and_actual_device(monkeypatch, tmp_path: Path, output, detail, device, reason):
    python = tmp_path / "python.exe"
    python.touch()
    monkeypatch.setattr(refinement, "POWERPAINT_PYTHON", python)
    monkeypatch.setattr(refinement, "POWERPAINT_VENDOR", tmp_path)
    monkeypatch.setattr(refinement, "powerpaint_snapshot_ready", lambda path: True)
    monkeypatch.setattr(refinement.time, "sleep", lambda seconds: None)
    phase = "loading" if device == "cpu" else "preparing"

    def start_process(command, **kwargs):
        (tmp_path / ".powerpaint-progress.json").write_text(json.dumps({
            "step": 0, "total": 5,
            "compute": {"model": "PowerPaint", "device": device, "phase": phase, "reason": reason},
        }), encoding="utf-8")
        kwargs["stdout"].write(output)
        return SimpleNamespace(pid=1, returncode=-1, poll=Mock(side_effect=[None, -1, -1]))

    monkeypatch.setattr(refinement.subprocess, "Popen", start_process)
    reports = []
    with compute_scope(reports.append, lambda: None), pytest.raises(RuntimeError) as raised:
        refinement.powerpaint_inpaint(
            tmp_path / "source.png", tmp_path / "mask.png", tmp_path / "output.png", "empty room",
        )

    assert f"during {phase} (exit code -1)" in str(raised.value)
    assert detail in str(raised.value)
    assert reports[-2].phase == "cleanup"
    assert reports[-2].device == device
    assert reports[-2].reason == reason
    assert reports[-1] is None
    assert (tmp_path / ".powerpaint-runner.log").read_text(encoding="utf-8") == output
    assert not (tmp_path / ".powerpaint-progress.json").exists()


def test_powerpaint_cancellation_cleans_logs_without_inventing_device(monkeypatch, tmp_path: Path):
    python = tmp_path / "python.exe"
    python.touch()
    monkeypatch.setattr(refinement, "POWERPAINT_PYTHON", python)
    monkeypatch.setattr(refinement, "POWERPAINT_VENDOR", tmp_path)
    monkeypatch.setattr(refinement, "powerpaint_snapshot_ready", lambda path: True)
    process = SimpleNamespace(
        pid=1, poll=Mock(side_effect=[None, None]), kill=Mock(), wait=Mock(),
    )

    def start_process(command, **kwargs):
        kwargs["stdout"].write("loading checkpoint")
        return process

    def cancelled():
        raise JobCancelled("cancelled")

    monkeypatch.setattr(refinement.subprocess, "Popen", start_process)
    reports = []
    with compute_scope(reports.append, cancelled), pytest.raises(JobCancelled):
        refinement.powerpaint_inpaint(
            tmp_path / "source.png", tmp_path / "mask.png", tmp_path / "output.png", "empty room",
            cancelled=cancelled,
        )

    assert reports == [None]
    process.kill.assert_called_once()
    process.wait.assert_called_once()
    assert not (tmp_path / ".powerpaint-runner.log").exists()
