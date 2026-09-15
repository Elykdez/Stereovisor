#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
model_root=${STEREOVISOR_MODEL_ROOT:-"$project_root/service/.models"}

"$project_root/service/scripts/setup-ai.sh"
if [ "$(uname -s)" = "Darwin" ]; then
  export PYTORCH_ENABLE_MPS_FALLBACK=1
fi
STEREOVISOR_MODEL_ROOT="$model_root" \
  STEREOVISOR_APP_ROOT="$project_root" \
  "$project_root/.venv-ai/bin/python" \
    "$project_root/service/scripts/prepare-packaged-ai.py" \
    --resource-root "$project_root" \
    --model-root "$model_root"
