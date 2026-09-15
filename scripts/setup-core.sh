#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
venv_path="$project_root/.venv"
system_name=$(uname -s)
machine_name=$(uname -m)

case "$system_name:$machine_name" in
  Darwin:arm64) platform_name="Apple Silicon macOS" ;;
  Linux:x86_64) platform_name="x64 Linux" ;;
  *)
    echo "This setup script supports Apple Silicon macOS and x64 Linux only." >&2
    exit 2
    ;;
esac

python_command=${STEREOVISOR_SYSTEM_PYTHON:-}
if [ -z "$python_command" ]; then
  python_command=$(command -v python3.12 || command -v python3 || true)
fi
if [ -z "$python_command" ]; then
  echo "Python 3.12 was not found. Install it before setting up Stereovisor." >&2
  exit 1
fi
"$python_command" -c 'import sys; assert sys.version_info[:2] == (3, 12), "Stereovisor requires Python 3.12"'

if [ -d "$venv_path" ] && ! "$venv_path/bin/python" -c \
  'import platform, sys; sys.exit(0 if platform.system() == sys.argv[1] and platform.machine() == sys.argv[2] else 1)' \
  "$system_name" "$machine_name" >/dev/null 2>&1; then
  echo "Replacing an incompatible .venv with the $platform_name environment."
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

if [ "$system_name" = "Darwin" ]; then
  electron_path="$project_root/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
else
  electron_path="$project_root/node_modules/electron/dist/electron"
fi
if [ ! -x "$electron_path" ]; then
  echo "The $platform_name Electron runtime was not installed." >&2
  exit 1
fi
echo "Stereovisor core environment is ready for $platform_name."
