$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPath = Join-Path $ProjectRoot ".venv-ai"
$PythonPath = Join-Path $VenvPath "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $PythonPath)) {
    $SystemPython = (Get-Command python -ErrorAction Stop).Source
    & $SystemPython -m venv --system-site-packages $VenvPath
}

$HasCudaTorch = $false
& $PythonPath -c "import torch; assert torch.cuda.is_available()"
if ($LASTEXITCODE -eq 0) {
    $HasCudaTorch = $true
}
if (-not $HasCudaTorch) {
    & $PythonPath -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128 --timeout 120 --retries 12
    if ($LASTEXITCODE -ne 0) {
        throw "CUDA PyTorch installation failed. The AI setup stopped before installing a CPU fallback."
    }
}
& $PythonPath -m pip install -r (Join-Path $ProjectRoot "service\requirements-ai.txt")
if ($LASTEXITCODE -ne 0) {
    throw "Local AI dependency installation failed."
}

& $PythonPath (Join-Path $PSScriptRoot "setup-vendors.py")
if ($LASTEXITCODE -ne 0) {
    throw "Pinned Depth Anything 3 and PowerPaint source setup failed."
}

$PowerPaintVenv = Join-Path $ProjectRoot ".venv-powerpaint"
$PowerPaintPython = Join-Path $PowerPaintVenv "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $PowerPaintPython)) {
    & $PythonPath -m venv $PowerPaintVenv
}
$PowerPaintPackages = Join-Path $PowerPaintVenv "Lib\site-packages"
$RuntimePackages = & $PythonPath -c "import sys; print('\n'.join(path for path in sys.path if path.lower().endswith('site-packages')))"
$RuntimePackages | Set-Content -LiteralPath (Join-Path $PowerPaintPackages "stereovisor-ai-runtime.pth") -Encoding Ascii
& $PowerPaintPython -m pip install --upgrade pip
& $PowerPaintPython -m pip install --no-deps "diffusers==0.27.0" "transformers==4.38.2" "huggingface-hub==0.25.2" "accelerate==0.34.2" "peft==0.9.0" "mmengine==0.10.7" "numpy==1.26.4" "opencv-python==4.10.0.84" "safetensors==0.6.2" "pillow==11.3.0" "tokenizers==0.15.2" "importlib-metadata>=8,<9" "rich>=13,<15" "termcolor>=2,<4" "yapf>=0.40,<1"
if ($LASTEXITCODE -ne 0) {
    throw "Optional PowerPaint runtime installation failed."
}

& $PythonPath -c "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable'; print('CUDA ready:', torch.__version__, torch.cuda.get_device_name(0))"
if ($LASTEXITCODE -ne 0) {
    throw "The managed Torch runtime cannot access CUDA."
}

Write-Host "Local CUDA AI dependencies installed."
