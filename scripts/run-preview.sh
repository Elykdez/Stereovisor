#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$project_root/scripts/setup-core.sh"

cd "$project_root"
export STEREOVISOR_PYTHON="$project_root/.venv/bin/python"
export STEREOVISOR_MODE=preview
exec npm run dev
