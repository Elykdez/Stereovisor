#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$project_root/scripts/ensure-ready.sh"

cd "$project_root"
export STEREOVISOR_PYTHON="$project_root/.venv-ai/bin/python"
export STEREOVISOR_MODEL_ROOT="$project_root/service/.models"
export STEREOVISOR_MODE=ai
export STEREOVISOR_DEVICE=${STEREOVISOR_DEVICE:-auto}
if [ "$(uname -s)" = "Darwin" ]; then
  export PYTORCH_ENABLE_MPS_FALLBACK=1
fi
exec npm run dev
