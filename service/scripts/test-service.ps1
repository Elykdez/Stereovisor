$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AiPython = Join-Path $ProjectRoot ".venv-ai\Scripts\python.exe"
$CorePython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$PythonPath = if (Test-Path -LiteralPath $AiPython) {
    $AiPython
}
elseif (Test-Path -LiteralPath $CorePython) {
    $CorePython
}
else {
    "python"
}

$env:STEREOVISOR_MODE = "preview"
& $PythonPath -m pytest (Join-Path $ProjectRoot "service\tests") -q
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
