#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
venv_path="$project_root/.venv-ai"
powerpaint_venv="$project_root/.venv-powerpaint"

"$project_root/scripts/setup-core.sh"

if [ -d "$venv_path" ] && [ ! -x "$venv_path/bin/python" ]; then
  echo "Replacing a non-macOS .venv-ai with the Apple Silicon environment."
  rm -rf "$venv_path"
fi
if [ ! -x "$venv_path/bin/python" ]; then
  "$project_root/.venv/bin/python" -m venv --copies "$venv_path"
fi

# The GUI and headless OpenCV wheels both own the cv2 package. Loading a mixed
# installation can deadlock dyld on macOS, and the local HTTP service needs no
# HighGUI support.
if "$venv_path/bin/python" -m pip show opencv-python >/dev/null 2>&1; then
  "$venv_path/bin/python" -m pip uninstall -y opencv-python
  "$venv_path/bin/python" -m pip install --force-reinstall --no-deps "opencv-python-headless==4.11.0.86"
fi

if ! "$venv_path/bin/python" -W ignore -c 'import torch, transformers, transparent_background, depth_anything_3, cv2' >/dev/null 2>&1; then
  "$venv_path/bin/python" -m pip install --disable-pip-version-check --upgrade pip
  "$venv_path/bin/python" -m pip install --disable-pip-version-check "torch==2.8.0" "torchvision==0.23.0"
  "$venv_path/bin/python" -m pip install --disable-pip-version-check -r "$project_root/service/requirements-ai.txt"
  "$venv_path/bin/python" "$project_root/service/scripts/setup-vendors.py"
fi

if [ -d "$powerpaint_venv" ] && [ ! -x "$powerpaint_venv/bin/python" ]; then
  echo "Replacing a non-macOS .venv-powerpaint with the Apple Silicon environment."
  rm -rf "$powerpaint_venv"
fi
if [ ! -x "$powerpaint_venv/bin/python" ]; then
  "$venv_path/bin/python" -m venv --copies "$powerpaint_venv"
fi

powerpaint_packages=$(
  "$powerpaint_venv/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])'
)
runtime_packages=$(
  "$venv_path/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])'
)
printf '%s\n' "$runtime_packages" > "$powerpaint_packages/stereovisor-ai-runtime.pth"
if ! "$powerpaint_venv/bin/python" -W ignore -c 'import torch, diffusers, transformers, accelerate, peft, mmengine; assert diffusers.__version__ == "0.27.0"' >/dev/null 2>&1; then
  "$powerpaint_venv/bin/python" -m pip install --disable-pip-version-check --upgrade pip
  "$powerpaint_venv/bin/python" -m pip install --disable-pip-version-check --no-deps -r "$project_root/service/requirements-powerpaint.txt"
fi

"$venv_path/bin/python" -c 'import torch; print("Apple Silicon AI runtime ready:", torch.__version__, "MPS" if torch.backends.mps.is_available() else "CPU")'
"$powerpaint_venv/bin/python" -W ignore -c 'import torch, diffusers, transformers, accelerate, peft, mmengine; print("PowerPaint runtime ready:", diffusers.__version__, "CUDA" if torch.cuda.is_available() else "CPU (CUDA unavailable)")'
