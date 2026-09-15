param(
    [Parameter(Mandatory = $true)][string]$ResourceRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$ModelRoot
)
$ErrorActionPreference = "Stop"
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$PythonRoot = Join-Path $RuntimeRoot ".python-runtime"
$BasePython = Join-Path $PythonRoot "tools\python.exe"
$ReadyMarker = Join-Path $RuntimeRoot ".stereovisor-runtime-ready"
$RunningMarker = Join-Path $ModelRoot ".stereovisor-bootstrap-running"

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $ModelRoot | Out-Null
$env:STEREOVISOR_BOOTSTRAP_STATUS = Join-Path $ModelRoot ".stereovisor-bootstrap-status"
$env:STEREOVISOR_BOOTSTRAP_COMPLETED = ""
$env:STEREOVISOR_RUNTIME_ROOT = $RuntimeRoot
$env:STEREOVISOR_APP_ROOT = $ResourceRoot
$env:STEREOVISOR_MODEL_ROOT = $ModelRoot
$env:PYTHONNOUSERSITE = "1"
Remove-Item Env:\PYTHONHOME, Env:\PYTHONPATH -ErrorAction SilentlyContinue
. (Join-Path $PSScriptRoot "bootstrap-status.ps1")
. (Join-Path $PSScriptRoot "download-file.ps1")

New-Item -ItemType File -Force -Path $RunningMarker | Out-Null
Remove-Item -LiteralPath $ReadyMarker -Force -ErrorAction SilentlyContinue
Publish-BootstrapStatus -State "starting" -Detail "Checking the local AI runtime." -Provider "runtime" -Progress 2

try {
    $PythonReady = $false
    if (Test-Path -LiteralPath $BasePython) {
        & $BasePython -I -c "import sys, struct, venv, ensurepip; assert sys.version_info[:3] == (3, 12, 8) and struct.calcsize('P') == 8" *> $null
        $PythonReady = $LASTEXITCODE -eq 0
    }
    if (-not $PythonReady) {
        Publish-BootstrapStatus -State "downloading" -Detail "Downloading Python 3.12.8 from the official Python package server." -Provider "runtime" -Progress 4
        $Archive = Join-Path $RuntimeRoot ".cache\downloads\python.3.12.8.nupkg"
        Get-ResumableFile -Uri "https://api.nuget.org/v3-flatcontainer/python/3.12.8/python.3.12.8.nupkg" `
            -Destination $Archive `
            -Sha256 "406856BE971D957E0BEE7A5CEFE20A5EC78D70A495E9E33CD0E53D31FAEC049D" `
            -Label "Python 3.12.8"
        Publish-BootstrapStatus -State "initializing" -Detail "Installing the local Python runtime." -Provider "runtime" -Progress 8
        $Staging = Join-Path $RuntimeRoot ".python-runtime.extracting"
        # Only these known children of the writable runtime directory may be
        # replaced after an interrupted extraction or a failed Python probe.
        foreach ($Target in @($Staging, $PythonRoot)) {
            if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($Target)) -ne $RuntimeRoot.TrimEnd('\')) {
                throw "Python extraction must stay inside the runtime directory."
            }
        }
        if (Test-Path -LiteralPath $Staging) { Remove-Item -LiteralPath $Staging -Recurse -Force }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Staging)
        $StagedPython = Join-Path $Staging "tools\python.exe"
        & $StagedPython -I -c "import sys, struct, venv, ensurepip; assert sys.version_info[:3] == (3, 12, 8) and struct.calcsize('P') == 8"
        if ($LASTEXITCODE -ne 0) { throw "The downloaded Python runtime could not start." }
        if (Test-Path -LiteralPath $PythonRoot) { Remove-Item -LiteralPath $PythonRoot -Recurse -Force }
        Move-Item -LiteralPath $Staging -Destination $PythonRoot
    }

    # Installation verifies the CUDA wheel itself. The running service reports
    # GPU availability and can use its existing CPU fallback on other hardware.
    $env:STEREOVISOR_SKIP_CUDA_VERIFY = "1"
    & (Join-Path $PSScriptRoot "setup-ai.ps1") -ResourceRoot $ResourceRoot -RuntimeRoot $RuntimeRoot -BasePython $BasePython
    if ($LASTEXITCODE -ne 0) { throw "Local AI dependency installation failed." }

    Publish-BootstrapStatus -State "initializing" -Detail "Initializing and validating the local CUDA AI runtime." -Provider "runtime" -Progress 96
    $PythonPath = Join-Path $RuntimeRoot ".venv-ai\Scripts\python.exe"
    $PowerPaintPython = Join-Path $RuntimeRoot ".venv-powerpaint\Scripts\python.exe"
    & $PythonPath -I -W ignore -c "import torch, torchvision, transformers, transparent_background, depth_anything_3, cv2, uvicorn, fastapi; assert torch.version.cuda; print('Local AI runtime verified.')"
    if ($LASTEXITCODE -ne 0) { throw "The installed local AI runtime could not be imported." }
    & $PowerPaintPython -I -W ignore -c "import torch, diffusers, transformers, mmengine; from accelerate.utils.memory import clear_device_cache; from peft import PeftModel; print('PowerPaint runtime verified.')"
    if ($LASTEXITCODE -ne 0) { throw "The installed PowerPaint runtime could not be imported." }
    $PowerPaintVendor = Join-Path $RuntimeRoot ".cache\vendor\PowerPaint\powerpaint\pipelines\pipeline_PowerPaint.py"
    if (-not (Test-Path -LiteralPath $PowerPaintVendor)) { throw "The installed PowerPaint sources are incomplete." }

    Set-Content -LiteralPath $ReadyMarker -Value "python-3.12.8-torch-2.8.0-cu128" -Encoding Ascii
    Complete-BootstrapProvider -Provider "runtime"
    Publish-BootstrapStatus -State "ready" -Detail "Local AI dependencies installed." -Provider "runtime" -Progress 100
}
catch {
    Publish-BootstrapStatus -State "blocked" -Detail $_.Exception.Message -Provider "runtime"
    throw
}
finally {
    Remove-Item -LiteralPath $RunningMarker -Force -ErrorAction SilentlyContinue
}
