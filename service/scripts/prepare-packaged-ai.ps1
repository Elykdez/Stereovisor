param(
    [Parameter(Mandatory = $true)][string]$ResourceRoot,
    [Parameter(Mandatory = $true)][string]$ModelRoot,
    [string]$RuntimeRoot = $ResourceRoot
)
$ErrorActionPreference = "Stop"

$PythonPath = Join-Path $RuntimeRoot ".venv-ai\Scripts\python.exe"
$PrepareScript = Join-Path $ResourceRoot "service\scripts\prepare-models.py"
$VendorRoot = Join-Path $RuntimeRoot ".cache\vendor"
$RunningMarker = Join-Path $ModelRoot ".stereovisor-bootstrap-running"
$StatusFile = Join-Path $ModelRoot ".stereovisor-bootstrap-status"

if (-not (Test-Path -LiteralPath $PythonPath)) {
    throw "The packaged CUDA Python runtime is missing: $PythonPath"
}
if (-not (Test-Path -LiteralPath $PrepareScript)) {
    throw "The packaged model preparation script is missing: $PrepareScript"
}

New-Item -ItemType Directory -Force -Path $ModelRoot | Out-Null
$env:STEREOVISOR_BOOTSTRAP_STATUS = $StatusFile
# Start from an empty set: an inherited value would claim stages this launch
# has not verified.
$env:STEREOVISOR_BOOTSTRAP_COMPLETED = ""
. (Join-Path $PSScriptRoot "bootstrap-status.ps1")

# A force-quit may leave the marker from an old preparation behind. The current
# Electron instance owns this bootstrap, so it overwrites that stale marker
# without ever clearing it: a gap would let /api/health report a stale state.
New-Item -ItemType File -Force -Path $RunningMarker | Out-Null
Publish-BootstrapStatus -State "starting" -Detail "Preparing the local AI runtime." -Provider "runtime"
try {
    $env:STEREOVISOR_APP_ROOT = $ResourceRoot
    $env:STEREOVISOR_MODEL_ROOT = $ModelRoot
    $env:STEREOVISOR_POWERPAINT_VENDOR = Join-Path $VendorRoot "PowerPaint"
    $env:STEREOVISOR_POWERPAINT_PYTHON = Join-Path $RuntimeRoot ".venv-powerpaint\Scripts\python.exe"
    $env:STEREOVISOR_SKIP_HQ = "1"
    Complete-BootstrapProvider -Provider "runtime"
    Write-Host "Preparing Stereovisor local AI models in $ModelRoot..." -ForegroundColor Cyan
    Publish-BootstrapStatus -State "downloading" -Detail "Downloading required local model weights. Keep this window open."
    & $PythonPath $PrepareScript
    if ($LASTEXITCODE -ne 0) {
        throw "Model preparation failed with exit code $LASTEXITCODE."
    }
    Write-Host "Required Stereovisor local AI models are ready." -ForegroundColor Green
    Publish-BootstrapStatus -State "ready" -Detail "Required local AI models are ready." -Progress 100
}
catch {
    Publish-BootstrapStatus -State "blocked" -Detail $_.Exception.Message
    throw
}
finally {
    Remove-Item -LiteralPath $RunningMarker -Force -ErrorAction SilentlyContinue
}
