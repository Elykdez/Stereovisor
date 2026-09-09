$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ManagedPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$PythonPath = if ($env:STEREOVISOR_PYTHON) { $env:STEREOVISOR_PYTHON } elseif (Test-Path -LiteralPath $ManagedPython) { $ManagedPython } else { "python" }

if (-not $env:STEREOVISOR_MODE) {
    $env:STEREOVISOR_MODE = "preview"
}

& $PythonPath (Join-Path $PSScriptRoot "run-service.py")
