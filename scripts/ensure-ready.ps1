$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ManagedPython = Join-Path $ProjectRoot ".venv-ai\Scripts\python.exe"
$PowerPaintPython = Join-Path $ProjectRoot ".venv-powerpaint\Scripts\python.exe"
$ElectronExecutable = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
$ModelRoot = Join-Path $ProjectRoot "service\.models"
$BootstrapMarker = Join-Path $ModelRoot ".stereovisor-bootstrap-running"
$BootstrapStatus = Join-Path $ModelRoot ".stereovisor-bootstrap-status"
if ($env:PYTORCH_CUDA_ALLOC_CONF -and -not $env:PYTORCH_ALLOC_CONF) {
    $env:PYTORCH_ALLOC_CONF = $env:PYTORCH_CUDA_ALLOC_CONF
}
Remove-Item Env:\PYTORCH_CUDA_ALLOC_CONF -ErrorAction SilentlyContinue

Set-Location -LiteralPath $ProjectRoot

New-Item -ItemType Directory -Force -Path $ModelRoot | Out-Null

# Every child stage publishes through the same file, so setup-ai.ps1 keeps the
# startup gate moving while it installs the CUDA runtime.
$env:STEREOVISOR_BOOTSTRAP_STATUS = $BootstrapStatus
. (Join-Path $ProjectRoot "service\scripts\bootstrap-status.ps1")

# This launcher owns the preparation process, so it claims the marker whether
# it is new or left behind by a force-quit. Writing over it keeps the marker
# continuously present: a gap would let /api/health report a stale state.
New-Item -ItemType File -Force -Path $BootstrapMarker | Out-Null
Publish-BootstrapStatus -State "starting" -Detail "Checking the local AI runtime." -Provider "runtime" -Progress 2

function Test-AiRuntime {
    param([Parameter(Mandatory = $true)][string]$PythonPath)

    $PreviousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        & $PythonPath -W ignore -c "import sys; import torch, transformers, transparent_background, depth_anything_3, cv2; sys.exit(0 if torch.cuda.is_available() else 2)" *> $null
        $ProbeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorAction
    }
    return $ProbeExitCode -eq 0
}

function Test-PowerPaintRuntime {
    if (-not (Test-Path -LiteralPath $PowerPaintPython)) {
        return $false
    }
    $PreviousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        & $PowerPaintPython -W ignore -c "import sys; import torch, diffusers, transformers, mmengine; from accelerate.utils.memory import clear_device_cache; from peft import PeftModel; sys.exit(0 if torch.cuda.is_available() else 2)" *> $null
        $ProbeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorAction
    }
    return $ProbeExitCode -eq 0
}

try {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "Node.js and npm were not found in PATH. Install Node.js 22 or newer, then run Stereovisor again."
    }

if (-not (Test-Path -LiteralPath $ManagedPython) -or -not (Test-Path -LiteralPath $ElectronExecutable)) {
    Write-Host "Preparing the Stereovisor core environment..." -ForegroundColor Cyan
    Publish-BootstrapStatus -State "downloading" -Detail "Installing the Stereovisor core environment." -Provider "runtime" -Progress 4
    & (Join-Path $PSScriptRoot "setup-core.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Core setup failed with exit code $LASTEXITCODE."
    }
}

Publish-BootstrapStatus -State "initializing" -Detail "Checking the local CUDA AI runtime." -Provider "runtime" -Progress 8
# The app runs only on the project-managed environment. A global interpreter
# that happens to carry CUDA Torch is not the runtime setup-ai.ps1 provisions,
# and borrowing it silently hides a half-installed .venv-ai.
$SelectedPython = $null
if (Test-AiRuntime -PythonPath $ManagedPython) {
    $SelectedPython = $ManagedPython
    Write-Host "Using the project-managed CUDA runtime." -ForegroundColor Cyan
}

if (-not $SelectedPython -or -not (Test-PowerPaintRuntime)) {
    Write-Host "Preparing the managed CUDA AI environment. This is required only once..." -ForegroundColor Cyan
    Publish-BootstrapStatus -State "downloading" -Detail "Downloading and installing the local CUDA AI runtime." -Provider "runtime" -Progress 10
    # setup-ai.ps1 publishes its own step progress through the shared status file.
    & (Join-Path $ProjectRoot "service\scripts\setup-ai.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "AI setup failed with exit code $LASTEXITCODE."
    }
    $SelectedPython = $ManagedPython
}

Publish-BootstrapStatus -State "initializing" -Detail "Initializing and validating the local CUDA AI runtime." -Provider "runtime" -Progress 96
& $SelectedPython -W ignore -c "import torch, transformers, transparent_background, depth_anything_3, cv2; assert torch.cuda.is_available(); print('CUDA ready:', torch.__version__, torch.cuda.get_device_name(0))"
if ($LASTEXITCODE -ne 0) {
    throw "The selected local AI environment cannot access CUDA."
}

$env:STEREOVISOR_PYTHON = $SelectedPython
$env:STEREOVISOR_MODEL_ROOT = $ModelRoot
Write-Host "Preparing and validating local model weights..." -ForegroundColor Cyan
Complete-BootstrapProvider -Provider "runtime"
Publish-BootstrapStatus -State "starting" -Detail "Checking required local model weights."
& $SelectedPython (Join-Path $ProjectRoot "service\scripts\prepare-models.py")
if ($LASTEXITCODE -ne 0) {
    throw "Local model preparation failed with exit code $LASTEXITCODE."
}

Write-Host "Stereovisor is ready." -ForegroundColor Green
Publish-BootstrapStatus -State "ready" -Detail "Required local AI models are ready." -Progress 100
}
catch {
    Publish-BootstrapStatus -State "blocked" -Detail $_.Exception.Message
    throw
}
finally {
    Remove-Item -LiteralPath $BootstrapMarker -Force -ErrorAction SilentlyContinue
}
