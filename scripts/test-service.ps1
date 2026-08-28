$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ManagedPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$PythonPath = if (Test-Path -LiteralPath $ManagedPython) { $ManagedPython } else { "python" }

$env:STEREOVISOR_MODE = "preview"
& $PythonPath -m pytest (Join-Path $ProjectRoot "service\tests") -q
