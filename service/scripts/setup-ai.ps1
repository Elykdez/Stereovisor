param(
    [string]$ResourceRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$RuntimeRoot = $ResourceRoot,
    [string]$BasePython
)
$ErrorActionPreference = "Stop"
$VenvPath = Join-Path $RuntimeRoot ".venv-ai"
$PythonPath = Join-Path $VenvPath "Scripts\python.exe"
$WheelCache = Join-Path $RuntimeRoot ".cache\wheels"

# Installing this environment is the longest part of a first launch. Publishing
# each step keeps the app's startup gate moving instead of sitting at zero.
# Standalone runs have no status file, and every call is then a no-op.
. (Join-Path $PSScriptRoot "bootstrap-status.ps1")
. (Join-Path $PSScriptRoot "download-file.ps1")

# Re-running venv preserves installed packages and repairs an interrupted
# first-run creation that left python.exe present but pip incomplete.
if ($BasePython -or -not (Test-Path -LiteralPath $PythonPath)) {
    Publish-BootstrapStatus -State "initializing" -Detail "Creating the local CUDA AI environment." -Provider "runtime" -Progress 12
    if (-not $BasePython) { $BasePython = (Get-Command python -ErrorAction Stop).Source }
    & $BasePython -I -m venv $VenvPath
    if ($LASTEXITCODE -ne 0) {
        throw "Creating the local CUDA AI environment failed."
    }
}

# Every AI import has to resolve inside this environment. Environments created
# by an earlier build borrowed the user's global packages, and that search path
# is mirrored into the PowerPaint runtime further down, so switch the sharing
# off before anything installs.
$VenvConfig = Join-Path $VenvPath "pyvenv.cfg"
$ConfigLines = Get-Content -LiteralPath $VenvConfig
if ($ConfigLines -match "include-system-site-packages\s*=\s*true") {
    ($ConfigLines -replace "include-system-site-packages\s*=\s*true", "include-system-site-packages = false") |
        Set-Content -LiteralPath $VenvConfig -Encoding Ascii
    Write-Host "Isolated .venv-ai from the global Python packages." -ForegroundColor Cyan
}

$CudaTag = "cu128"
if ($BasePython) {
    # The NuGet runtime seeds an older pip that cannot resume timed-out wheels.
    & $PythonPath -m pip install --upgrade --timeout 60 --retries 10 "pip>=25.2,<27"
    if ($LASTEXITCODE -ne 0) { throw "Updating the local package installer failed." }
}
$TorchVersion = "2.8.0"
$TorchvisionVersion = "0.23.0"
$WheelBase = $env:STEREOVISOR_TORCH_WHEEL_BASE
if (-not $WheelBase) {
    $WheelBase = "https://download.pytorch.org/whl/$CudaTag"
}
$WheelBase = $WheelBase.TrimEnd("/")

# Pinned so a resumed transfer that picked up a bad range is rejected instead of
# installed. Unlisted interpreter tags still install, just without the check.
$WheelHashes = @{
    "torch-2.8.0+cu128-cp312-cp312-win_amd64.whl"        = "0AD925202387F4E7314302A1B4F8860FA824357F9B1466D7992BF276370EBCFF"
    "torchvision-0.23.0+cu128-cp312-cp312-win_amd64.whl" = "20FA9C7362A006776630B00B8A01919FEDCF504A202B81358D32C5AEF39956FE"
}

function Get-TorchWheel {
    param(
        [Parameter(Mandatory = $true)][string]$Distribution,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$PythonTag
    )

    $FileName = "$Distribution-$Version+$CudaTag-$PythonTag-$PythonTag-win_amd64.whl"
    $Destination = Join-Path $WheelCache $FileName
    Get-ResumableFile -Uri "$WheelBase/$($FileName -replace '\+', '%2B')" `
        -Destination $Destination `
        -Sha256 $WheelHashes[$FileName] `
        -Label $FileName
    return $Destination
}

function Test-VenvCudaTorch {
    # Torch has to be CUDA capable and live inside this environment; a global
    # install that happens to be importable is not what the app runs on.
    $PreviousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "SilentlyContinue"
        & $PythonPath -W ignore -c "import pathlib, sys, torch; sys.exit(0 if torch.version.cuda and str(pathlib.Path(torch.__file__).resolve()).lower().startswith(sys.prefix.lower()) else 2)" *> $null
        $ProbeExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorAction
    }
    return $ProbeExitCode -eq 0
}

if (-not (Test-VenvCudaTorch)) {
    # pip streams this wheel in one request and starts over from zero whenever
    # the CDN connection stalls, which never completes on a slow link. Fetch it
    # with a resumable transfer first, then install from the cached file.
    Publish-BootstrapStatus -State "downloading" -Detail "Downloading CUDA PyTorch. This is the largest one-time download." -Provider "runtime" -Progress 20
    $PythonTag = & $PythonPath -c "import sys; print('cp%d%d' % sys.version_info[:2])"
    $TorchWheel = Get-TorchWheel -Distribution "torch" -Version $TorchVersion -PythonTag $PythonTag
    $TorchvisionWheel = Get-TorchWheel -Distribution "torchvision" -Version $TorchvisionVersion -PythonTag $PythonTag

    Publish-BootstrapStatus -State "downloading" -Detail "Installing CUDA PyTorch." -Provider "runtime" -Progress 45
    & $PythonPath -m pip install --timeout 60 --retries 10 $TorchWheel $TorchvisionWheel
    if ($LASTEXITCODE -ne 0) {
        throw "CUDA PyTorch installation failed. The AI setup stopped before installing a CPU fallback."
    }
}
Publish-BootstrapStatus -State "downloading" -Detail "Installing the local AI dependencies." -Provider "runtime" -Progress 55
& $PythonPath -m pip install --timeout 60 --retries 10 -r (Join-Path $ResourceRoot "service\requirements-ai.txt")
if ($LASTEXITCODE -ne 0) {
    throw "Local AI dependency installation failed."
}

Publish-BootstrapStatus -State "downloading" -Detail "Pinning the Depth Anything 3 and PowerPaint sources." -Provider "runtime" -Progress 70
if ($PSBoundParameters.ContainsKey("RuntimeRoot")) {
    $env:STEREOVISOR_RUNTIME_ROOT = $RuntimeRoot
}
& $PythonPath (Join-Path $PSScriptRoot "setup-vendors.py")
if ($LASTEXITCODE -ne 0) {
    throw "Pinned Depth Anything 3 and PowerPaint source setup failed."
}

Publish-BootstrapStatus -State "downloading" -Detail "Installing the optional PowerPaint runtime." -Provider "runtime" -Progress 80
$PowerPaintVenv = Join-Path $RuntimeRoot ".venv-powerpaint"
$PowerPaintPython = Join-Path $PowerPaintVenv "Scripts\python.exe"
if ($BasePython -or -not (Test-Path -LiteralPath $PowerPaintPython)) {
    & $PythonPath -m venv $PowerPaintVenv
    if ($LASTEXITCODE -ne 0) {
        throw "Creating the optional PowerPaint environment failed."
    }
}
$PowerPaintPackages = Join-Path $PowerPaintVenv "Lib\site-packages"
$RuntimePackages = Join-Path $VenvPath "Lib\site-packages"
& $PythonPath -c "import pathlib, sys; pathlib.Path(sys.argv[1]).write_text('import site; site.addsitedir(' + ascii(sys.argv[2]) + ')\n', encoding='ascii')" (Join-Path $PowerPaintPackages "stereovisor-ai-runtime.pth") $RuntimePackages
if ($LASTEXITCODE -ne 0) {
    throw "Linking the optional PowerPaint runtime failed."
}
& $PowerPaintPython -m pip install --upgrade pip
& $PowerPaintPython -m pip install --timeout 60 --retries 10 --no-deps -r (Join-Path $ResourceRoot "service\requirements-powerpaint.txt") "opencv-python==4.10.0.84"
if ($LASTEXITCODE -ne 0) {
    throw "Optional PowerPaint runtime installation failed."
}

Publish-BootstrapStatus -State "initializing" -Detail "Verifying CUDA availability." -Provider "runtime" -Progress 92
# A packaging machine installs the CUDA wheels without owning a GPU, so the
# runtime probe cannot pass there. Build pipelines set this; a user install
# must not, or a broken environment ships as a working one.
if ($env:STEREOVISOR_SKIP_CUDA_VERIFY -eq "1") {
    Write-Host "STEREOVISOR_SKIP_CUDA_VERIFY=1: skipping the CUDA runtime probe." -ForegroundColor Yellow
    & $PythonPath -c "import torch; print('Torch installed:', torch.__version__, '(CUDA runtime unverified)')"
    if ($LASTEXITCODE -ne 0) {
        throw "The managed Torch runtime is not importable."
    }
}
else {
    & $PythonPath -c "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable'; print('CUDA ready:', torch.__version__, torch.cuda.get_device_name(0))"
    if ($LASTEXITCODE -ne 0) {
        throw "The managed Torch runtime cannot access CUDA."
    }
}

Write-Host "Local CUDA AI dependencies installed."
