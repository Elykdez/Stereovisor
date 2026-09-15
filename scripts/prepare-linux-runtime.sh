#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_root="$project_root/.python-runtime"
powerpaint_packages="$runtime_root/powerpaint-site-packages"
cache_root="$project_root/.cache/python-runtime"
archive_name="cpython-3.12.14+20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
archive_path="$cache_root/$archive_name"
archive_sha256="72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c"
archive_url="https://github.com/astral-sh/python-build-standalone/releases/download/20260901/$archive_name"

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "The packaged Python runtime supports x64 Linux only." >&2
  exit 2
fi

"$project_root/scripts/setup-core.sh"
mkdir -p "$cache_root"
if [ ! -f "$archive_path" ] || ! printf '%s  %s\n' "$archive_sha256" "$archive_path" | sha256sum -c - >/dev/null 2>&1; then
  rm -f "$archive_path"
  curl -L --fail --retry 5 --continue-at - --output "$archive_path" "$archive_url"
fi
printf '%s  %s\n' "$archive_sha256" "$archive_path" | sha256sum -c -

if [ -d "$runtime_root" ] && ! "$runtime_root/bin/python3" -c 'import platform, sys; sys.exit(0 if platform.system() == "Linux" and platform.machine() == "x86_64" else 1)' >/dev/null 2>&1; then
  echo "Replacing an incompatible .python-runtime with the x64 Linux runtime."
  rm -rf "$runtime_root"
fi
if [ ! -x "$runtime_root/bin/python3" ]; then
  staging_root=$(mktemp -d "${TMPDIR:-/tmp}/stereovisor-python.XXXXXX")
  trap 'rm -rf "$staging_root"' EXIT INT TERM
  tar -xzf "$archive_path" -C "$staging_root"
  mv "$staging_root/python" "$runtime_root"
  rm -rf "$staging_root"
  trap - EXIT INT TERM
fi

requirements_hash=$(
  sha256sum \
    "$project_root/service/requirements-core.txt" \
    "$project_root/service/requirements-ai.txt" \
    "$project_root/service/requirements-powerpaint.txt" \
    "$project_root/service/scripts/powerpaint-runner.py" \
    "$project_root/service/scripts/setup-vendors.py" | sha256sum | awk '{print $1}'
)
ready_marker="$runtime_root/.stereovisor-runtime-$requirements_hash"
powerpaint_vendor="$project_root/.cache/vendor/PowerPaint"
if [ -f "$ready_marker" ] \
  && [ -f "$powerpaint_vendor/powerpaint/pipelines/pipeline_PowerPaint.py" ] \
  && "$runtime_root/bin/python3" -W ignore -c 'import torch, transformers, transparent_background, depth_anything_3, cv2, fastapi' >/dev/null 2>&1 \
  && PYTHONPATH="$powerpaint_packages" "$runtime_root/bin/python3" -W ignore -c 'import torch, diffusers, transformers, accelerate, peft, mmengine; assert diffusers.__version__ == "0.27.0"' >/dev/null 2>&1; then
  echo "Relocatable x64 Linux Python runtime is ready."
  exit 0
fi

"$runtime_root/bin/python3" -m pip install --disable-pip-version-check --no-cache-dir --upgrade pip
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check --no-cache-dir -r "$project_root/service/requirements-core.txt"
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check --no-cache-dir \
  --index-url "${STEREOVISOR_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cpu}" \
  "torch==2.8.0" "torchvision==0.23.0"
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check --no-cache-dir -r "$project_root/service/requirements-ai.txt"
"$runtime_root/bin/python3" -m pip uninstall -y opencv-python
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check --no-cache-dir --force-reinstall --no-deps "opencv-python-headless==4.11.0.86"
STEREOVISOR_RUNTIME_ROOT="$project_root" "$runtime_root/bin/python3" "$project_root/service/scripts/setup-vendors.py"
rm -rf "$powerpaint_packages"
mkdir -p "$powerpaint_packages"
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check --no-cache-dir --no-deps \
  --target "$powerpaint_packages" \
  -r "$project_root/service/requirements-powerpaint.txt"
"$runtime_root/bin/python3" -W ignore -c 'import torch, transformers, transparent_background, depth_anything_3, cv2, fastapi; print("Packaged AI runtime ready:", torch.__version__, "CUDA" if torch.cuda.is_available() else "CPU")'
PYTHONPATH="$powerpaint_packages" "$runtime_root/bin/python3" -W ignore -c 'import torch, diffusers, transformers, accelerate, peft, mmengine; print("Packaged PowerPaint runtime ready:", diffusers.__version__, "CUDA" if torch.cuda.is_available() else "CPU (CUDA unavailable)")'
touch "$ready_marker"
