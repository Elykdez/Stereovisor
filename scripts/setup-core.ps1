$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPath = Join-Path $ProjectRoot ".venv"

if (-not (Test-Path -LiteralPath $VenvPath)) {
    py -3.12 -m venv $VenvPath
}

$PythonPath = Join-Path $VenvPath "Scripts\python.exe"
& $PythonPath -m pip install --upgrade pip
& $PythonPath -m pip install -r (Join-Path $ProjectRoot "service\requirements-core.txt")
npm install --prefix $ProjectRoot
& (Join-Path $PSScriptRoot "install-electron.ps1")

Write-Host "Core environment ready. Run: npm run dev"
