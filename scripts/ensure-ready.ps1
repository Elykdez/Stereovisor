$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ManagedPython = Join-Path $ProjectRoot ".venv-ai\Scripts\python.exe"
$PowerPaintPython = Join-Path $ProjectRoot ".venv-powerpaint\Scripts\python.exe"
$ElectronExecutable = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
$ModelRoot = Join-Path $ProjectRoot "service\.models"
if ($env:PYTORCH_CUDA_ALLOC_CONF -and -not $env:PYTORCH_ALLOC_CONF) {
    $env:PYTORCH_ALLOC_CONF = $env:PYTORCH_CUDA_ALLOC_CONF
}
Remove-Item Env:\PYTORCH_CUDA_ALLOC_CONF -ErrorAction SilentlyContinue

Set-Location -LiteralPath $ProjectRoot

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

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Node.js and npm were not found in PATH. Install Node.js 22 or newer, then run Stereovisor again."
}

if (-not (Test-Path -LiteralPath $ManagedPython) -or -not (Test-Path -LiteralPath $ElectronExecutable)) {
    Write-Host "Preparing the Stereovisor core environment..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "setup-core.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Core setup failed with exit code $LASTEXITCODE."
    }
}

$SelectedPython = $null
if (Test-AiRuntime -PythonPath $ManagedPython) {
    $SelectedPython = $ManagedPython
    Write-Host "Using the project-managed CUDA runtime." -ForegroundColor Cyan
}
else {
    $SystemPythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($SystemPythonCommand -and (Test-AiRuntime -PythonPath $SystemPythonCommand.Source)) {
        $SelectedPython = $SystemPythonCommand.Source
        Write-Host "Using the verified local CUDA Python runtime." -ForegroundColor Cyan
    }
}

if (-not $SelectedPython -or -not (Test-PowerPaintRuntime)) {
    Write-Host "Preparing the managed CUDA AI environment. This is required only once..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "setup-ai.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "AI setup failed with exit code $LASTEXITCODE."
    }
    $SelectedPython = $ManagedPython
}

& $SelectedPython -W ignore -c "import torch, transformers, transparent_background, depth_anything_3, cv2; assert torch.cuda.is_available(); print('CUDA ready:', torch.__version__, torch.cuda.get_device_name(0))"
if ($LASTEXITCODE -ne 0) {
    throw "The selected local AI environment cannot access CUDA."
}

$env:STEREOVISOR_PYTHON = $SelectedPython
$env:STEREOVISOR_MODEL_ROOT = $ModelRoot
Write-Host "Preparing and validating local model weights..." -ForegroundColor Cyan
& $SelectedPython (Join-Path $PSScriptRoot "prepare-models.py")
if ($LASTEXITCODE -ne 0) {
    throw "Local model preparation failed with exit code $LASTEXITCODE."
}

Write-Host "Stereovisor is ready." -ForegroundColor Green
