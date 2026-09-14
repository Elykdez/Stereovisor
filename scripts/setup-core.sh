#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
venv_path="$project_root/.venv"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "This setup script supports Apple Silicon macOS only." >&2
  exit 2
fi

python_command=${STEREOVISOR_SYSTEM_PYTHON:-}
if [ -z "$python_command" ]; then
  python_command=$(command -v python3.12 || command -v python3 || true)
fi
if [ -z "$python_command" ]; then
  echo "Python 3.12 was not found. Install it before setting up Stereovisor." >&2
  exit 1
fi
"$python_command" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Stereovisor requires Python 3.12"'

if [ -d "$venv_path" ] && [ ! -x "$venv_path/bin/python" ]; then
  echo "Replacing a non-macOS .venv with the Apple Silicon environment."
  rm -rf "$venv_path"
fi
if [ ! -x "$venv_path/bin/python" ]; then
  "$python_command" -m venv --copies "$venv_path"
fi
"$venv_path/bin/python" -m pip install --disable-pip-version-check --upgrade pip
"$venv_path/bin/python" -m pip install --disable-pip-version-check -r "$project_root/service/requirements-core.txt"

cd "$project_root"
npm install
node "$project_root/node_modules/electron/install.js"

if [ ! -x "$project_root/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  echo "The Apple Silicon Electron runtime was not installed." >&2
  exit 1
fi
echo "Stereovisor core environment is ready for Apple Silicon."
