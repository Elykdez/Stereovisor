#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_root="$project_root/.python-runtime"
powerpaint_packages="$runtime_root/powerpaint-site-packages"
cache_root="$project_root/.cache/python-runtime"
archive_name="cpython-3.12.14+20260901-aarch64-apple-darwin-install_only.tar.gz"
archive_path="$cache_root/$archive_name"
archive_sha256="3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76"
archive_url="https://github.com/astral-sh/python-build-standalone/releases/download/20260901/$archive_name"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "The packaged Python runtime supports Apple Silicon macOS only." >&2
  exit 2
fi

"$project_root/scripts/setup-core.sh"
mkdir -p "$cache_root"
if [ ! -f "$archive_path" ] || ! printf '%s  %s\n' "$archive_sha256" "$archive_path" | shasum -a 256 -c - >/dev/null 2>&1; then
  rm -f "$archive_path"
  curl -L --fail --retry 5 --continue-at - --output "$archive_path" "$archive_url"
fi
printf '%s  %s\n' "$archive_sha256" "$archive_path" | shasum -a 256 -c -

if [ ! -x "$runtime_root/bin/python3" ]; then
  staging_root=$(mktemp -d "${TMPDIR:-/tmp}/stereovisor-python.XXXXXX")
  trap 'rm -rf "$staging_root"' EXIT INT TERM
  tar -xzf "$archive_path" -C "$staging_root"
  mv "$staging_root/python" "$runtime_root"
  rm -rf "$staging_root"
  trap - EXIT INT TERM
fi

requirements_hash=$(
  shasum -a 256 \
    "$project_root/service/requirements-core.txt" \
    "$project_root/service/requirements-ai.txt" \
    "$project_root/service/requirements-powerpaint.txt" \
    "$project_root/service/scripts/powerpaint-runner.py" \
    "$project_root/service/scripts/setup-vendors.py" | shasum -a 256 | awk '{print $1}'
)
ready_marker="$runtime_root/.stereovisor-runtime-$requirements_hash"
if [ -f "$ready_marker" ] \
  && "$runtime_root/bin/python3" -W ignore -c 'import torch, transformers, transparent_background, depth_anything_3, cv2, fastapi' >/dev/null 2>&1 \
  && PYTHONPATH="$powerpaint_packages" "$runtime_root/bin/python3" -W ignore -c 'import torch, diffusers, transformers, accelerate, peft, mmengine; assert diffusers.__version__ == "0.27.0"' >/dev/null 2>&1; then
  echo "Relocatable Apple Silicon Python runtime is ready."
  exit 0
fi

"$runtime_root/bin/python3" -m pip install --disable-pip-version-check --upgrade pip
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check -r "$project_root/service/requirements-core.txt"
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check "torch==2.8.0" "torchvision==0.23.0"
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check -r "$project_root/service/requirements-ai.txt"
"$runtime_root/bin/python3" -m pip uninstall -y opencv-python
"$runtime_root/bin/python3" -m pip install --force-reinstall --no-deps "opencv-python-headless==4.11.0.86"
"$runtime_root/bin/python3" "$project_root/service/scripts/setup-vendors.py"
rm -rf "$powerpaint_packages"
mkdir -p "$powerpaint_packages"
"$runtime_root/bin/python3" -m pip install --disable-pip-version-check --no-deps \
  --target "$powerpaint_packages" \
  -r "$project_root/service/requirements-powerpaint.txt"
"$runtime_root/bin/python3" -W ignore -c 'import torch, transformers, transparent_background, depth_anything_3, cv2, fastapi; print("Packaged AI runtime ready:", torch.__version__, "MPS" if torch.backends.mps.is_available() else "CPU")'
PYTHONPATH="$powerpaint_packages" "$runtime_root/bin/python3" -W ignore -c 'import torch, diffusers, transformers, accelerate, peft, mmengine; print("Packaged PowerPaint runtime ready:", diffusers.__version__, "CUDA" if torch.cuda.is_available() else "CPU (CUDA unavailable)")'
touch "$ready_marker"
