from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resource-root", type=Path, required=True)
    parser.add_argument("--model-root", type=Path, required=True)
    arguments = parser.parse_args()

    resource_root = arguments.resource_root.resolve()
    model_root = arguments.model_root.resolve()
    model_root.mkdir(parents=True, exist_ok=True)
    os.environ["STEREOVISOR_APP_ROOT"] = str(resource_root)
    os.environ["STEREOVISOR_MODEL_ROOT"] = str(model_root)
    os.environ["STEREOVISOR_POWERPAINT_VENDOR"] = str(
        resource_root / ".cache" / "vendor" / "PowerPaint"
    )
    os.environ["STEREOVISOR_SKIP_HQ"] = "1"
    os.environ["STEREOVISOR_BOOTSTRAP_COMPLETED"] = ""
    sys.path.insert(0, str(resource_root))

    prepare_script = resource_root / "service" / "scripts" / "prepare-models.py"
    spec = importlib.util.spec_from_file_location(
        "stereovisor_prepare_models", prepare_script
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load model preparation script: {prepare_script}")
    prepare_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(prepare_module)
    publish_bootstrap_status = prepare_module.publish_bootstrap_status

    marker = model_root / ".stereovisor-bootstrap-running"
    marker.touch()
    try:
        publish_bootstrap_status(
            model_root,
            "downloading",
            "Downloading required local model weights. Keep Stereovisor open.",
        )
        prepare_module.main()
        publish_bootstrap_status(
            model_root,
            "ready",
            "Required local AI models are ready.",
            progress=100,
        )
    except Exception as error:
        publish_bootstrap_status(model_root, "blocked", str(error))
        raise
    finally:
        marker.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
