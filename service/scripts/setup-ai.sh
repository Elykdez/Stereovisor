#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
venv_path="$project_root/.venv-ai"
powerpaint_venv="$project_root/.venv-powerpaint"
system_name=$(uname -s)
platform_name=$([ "$system_name" = "Darwin" ] && printf '%s' "Apple Silicon" || printf '%s' "Linux")

"$project_root/scripts/setup-core.sh"

if [ -d "$venv_path" ] && ! "$venv_path/bin/python" -c \
  'import platform, sys; sys.exit(0 if platform.system() == sys.argv[1] else 1)' \
  "$system_name" >/dev/null 2>&1; then
  echo "Replacing an incompatible .venv-ai with the $platform_name environment."
  rm -rf "$venv_path"
fi
if [ ! -x "$venv_path/bin/python" ]; then
  "$project_root/.venv/bin/python" -m venv --copies "$venv_path"
fi

# The GUI and headless OpenCV wheels both own the cv2 package. A mixed install
# is unreliable on POSIX desktops, and the local HTTP service needs no HighGUI.
if "$venv_path/bin/python" -m pip show opencv-python >/dev/null 2>&1; then
  "$venv_path/bin/python" -m pip uninstall -y opencv-python
  "$venv_path/bin/python" -m pip install --force-reinstall --no-deps "opencv-python-headless==4.11.0.86"
fi

if ! "$venv_path/bin/python" -W ignore -c 'import torch, transformers, transparent_background, depth_anything_3, cv2' >/dev/null 2>&1; then
  "$venv_path/bin/python" -m pip install --disable-pip-version-check --upgrade pip
  if [ "$system_name" = "Linux" ]; then
    torch_index_url=${STEREOVISOR_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cpu}
    "$venv_path/bin/python" -m pip install --disable-pip-version-check \
      --index-url "$torch_index_url" "torch==2.8.0" "torchvision==0.23.0"
  else
    "$venv_path/bin/python" -m pip install --disable-pip-version-check "torch==2.8.0" "torchvision==0.23.0"
  fi
  "$venv_path/bin/python" -m pip install --disable-pip-version-check -r "$project_root/service/requirements-ai.txt"
  "$venv_path/bin/python" "$project_root/service/scripts/setup-vendors.py"
fi

if [ -d "$powerpaint_venv" ] && ! "$powerpaint_venv/bin/python" -c \
  'import platform, sys; sys.exit(0 if platform.system() == sys.argv[1] else 1)' \
  "$system_name" >/dev/null 2>&1; then
  echo "Replacing an incompatible .venv-powerpaint with the $platform_name environment."
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

"$venv_path/bin/python" -c 'import torch; print("AI runtime ready:", torch.__version__, "CUDA" if torch.cuda.is_available() else ("MPS" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "CPU"))'
"$powerpaint_venv/bin/python" -W ignore -c 'import torch, diffusers, transformers, accelerate, peft, mmengine; print("PowerPaint runtime ready:", diffusers.__version__, "CUDA" if torch.cuda.is_available() else "CPU (CUDA unavailable)")'
