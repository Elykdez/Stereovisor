import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from PIL import Image

from service.src.config import snapshot_ready

RUNNER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "powerpaint-runner.py"
SPEC = importlib.util.spec_from_file_location("powerpaint_runner", RUNNER_PATH)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def test_default_inference_steps_are_25() -> None:
    assert RUNNER.DEFAULT_INFERENCE_STEPS == 25


@pytest.mark.parametrize("cuda_available", [True, False])
def test_runner_reuses_unet_and_falls_back_to_cpu(
    monkeypatch, tmp_path: Path, cuda_available: bool
) -> None:
    torch = pytest.importorskip("torch", reason="Torch ships with the local AI runtime")

    def model(bias: float):
        result = torch.nn.Linear(1, 1)
        result.bias.data.fill_(bias)
        return result

    unet_loader = Mock(side_effect=lambda *args, **kwargs: model(1.0))

    def from_unet(unet, load_weights_from_unet=True):
        result = model(0.0)
        if load_weights_from_unet:
            # Upstream BrushNet shares its input bias with the source UNet.
            result.bias = unet.bias
        return result

    class Pipeline(SimpleNamespace):
        def __call__(self, **kwargs):
            for step in range(kwargs["num_inference_steps"]):
                callback_values = {"latents": object()}
                assert kwargs["callback_on_step_end"](self, step, None, callback_values) is callback_values
            return SimpleNamespace(images=[Image.new("RGB", (8, 8), "blue")])

    pipe = Pipeline()

    def load_pipeline(base, **components):
        pipe.unet = components.get("unet")
        if pipe.unet is None:
            pipe.unet = unet_loader(base, subfolder="unet")
        pipe.unet.to = Mock(wraps=pipe.unet.to)
        pipe.brushnet = components["brushnet"]
        pipe.text_encoder_brushnet = components["text_encoder_brushnet"]
        pipe.scheduler = SimpleNamespace(config={})
        pipe.vae = SimpleNamespace(enable_tiling=Mock())
        pipe.enable_model_cpu_offload = Mock()
        return pipe

    modules = {
        "diffusers": SimpleNamespace(UniPCMultistepScheduler=SimpleNamespace(from_config=Mock())),
        "safetensors.torch": SimpleNamespace(load_file=lambda *args, **kwargs: model(2.0).state_dict()),
        "transformers": SimpleNamespace(CLIPTextModel=SimpleNamespace(from_pretrained=Mock(return_value=model(0.0)))),
        "powerpaint.models.BrushNet_CA": SimpleNamespace(BrushNetModel=SimpleNamespace(from_unet=from_unet)),
        "powerpaint.models.unet_2d_condition": SimpleNamespace(UNet2DConditionModel=SimpleNamespace(from_pretrained=unet_loader)),
        "powerpaint.pipelines.pipeline_PowerPaint_Brushnet_CA": SimpleNamespace(StableDiffusionPowerPaintBrushNetPipeline=SimpleNamespace(from_pretrained=load_pipeline)),
        "powerpaint.utils.utils": SimpleNamespace(TokenizerWrapper=Mock(), add_tokens=Mock()),
    }
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(sys, "argv", [
        str(RUNNER_PATH),
        "--image", str(tmp_path / "source.png"),
        "--mask", str(tmp_path / "mask.png"),
        "--output", str(tmp_path / "output.png"),
        "--prompt", "empty room",
        "--steps", "5",
        "--checkpoint", str(tmp_path),
        "--vendor", str(tmp_path),
        "--progress", str(tmp_path / "progress.json"),
    ])
    monkeypatch.setattr(torch.cuda, "is_available", lambda: cuda_available)
    monkeypatch.setattr(torch.cuda, "reset_peak_memory_stats", lambda: None)
    monkeypatch.setattr(torch.cuda, "max_memory_allocated", lambda: 0)
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda: (6692 * 1048576, 8192 * 1048576))
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda: "Test GPU")
    monkeypatch.setattr(torch, "Generator", Mock())
    monkeypatch.setattr(torch, "load", lambda *args, **kwargs: {})
    Image.new("RGB", (8, 8), "red").save(tmp_path / "source.png")
    Image.new("L", (8, 8), 255).save(tmp_path / "mask.png")
    reports = []
    write_progress = RUNNER.write_progress

    def record_progress(*args, **kwargs):
        write_progress(*args, **kwargs)
        reports.append(json.loads((tmp_path / "progress.json").read_text()))
        if len(reports) == 1:
            unet_loader.assert_not_called()

    monkeypatch.setattr(RUNNER, "write_progress", record_progress)

    with torch.no_grad():
        RUNNER.main()

    unet_loader.assert_called_once()
    assert pipe.unet.bias.item() == 1.0
    assert pipe.brushnet.bias.item() == 2.0
    assert pipe.unet.to.call_count == (5 if cuda_available else 0)
    assert all(call.args == ("cpu",) for call in pipe.unet.to.call_args_list)
    assert reports[0]["compute"]["device"] == "cpu"
    assert [report["compute"]["phase"] for report in reports] == [
        "loading", "loading", "preparing", "inference", "inference", "inference",
        "inference", "inference", "inference", "cleanup",
    ]
    inference = [report["compute"] for report in reports if report["compute"]["phase"] == "inference"]
    assert [report["completed"] for report in inference] == [0, 1, 2, 3, 4, 5]
    expected_device = "hybrid" if cuda_available else "cpu"
    expected_reason = "offloading" if cuda_available else "cuda_unavailable"
    assert all(
        report["device"] == expected_device and report["reason"] == expected_reason
        for report in inference
    )
    if cuda_available:
        assert all(
            report["vramUsedMb"] == 1500 and report["vramTotalMb"] == 8192
            for report in inference
        )
        pipe.enable_model_cpu_offload.assert_called_once()
    else:
        assert all("vramUsedMb" not in report for report in inference)
        pipe.enable_model_cpu_offload.assert_not_called()
    assert reports[-1]["step"] == reports[-1]["total"] == 5
    assert Image.open(tmp_path / "output.png").getpixel((4, 4)) == (0, 0, 255)


def test_full_redraw_composite_keeps_the_core_and_feathers_the_seam() -> None:
    source = Image.new("RGB", (21, 21), "red")
    generated = Image.new("RGB", (21, 21), "blue")
    mask = Image.new("L", (21, 21))
    for y in range(7, 14):
        for x in range(7, 14):
            mask.putpixel((x, y), 255)

    result = RUNNER.composite_full_redraw(generated, source, mask)

    assert result.getpixel((0, 0)) == (255, 0, 0)
    assert result.getpixel((10, 10)) == (0, 0, 255)
    assert result.getpixel((7, 10)) == (0, 0, 255)
    assert result.getpixel((6, 10)) not in ((255, 0, 0), (0, 0, 255))


def test_snapshot_readiness_requires_marker_and_declared_files(tmp_path: Path) -> None:
    (tmp_path / ".stereovisor-ready").write_text("model/repo", encoding="utf-8")

    assert snapshot_ready(tmp_path) is True
    assert snapshot_ready(tmp_path, ("weights/model.bin",)) is False

    weights = tmp_path / "weights"
    weights.mkdir()
    (weights / "model.bin").write_bytes(b"complete")

    assert snapshot_ready(tmp_path, ("weights/model.bin",)) is True
