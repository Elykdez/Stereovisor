$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

try {
    . (Join-Path $PSScriptRoot "ensure-ready.ps1")

    $env:STEREOVISOR_MODE = "ai"
    $env:STEREOVISOR_DEVICE = "cuda"
    $env:STEREOVISOR_MODEL_ROOT = Join-Path $ProjectRoot "service\.models"
    Set-Location -LiteralPath $ProjectRoot
    Write-Host "Starting Stereovisor with local AI..." -ForegroundColor Green
    & npm run dev
    exit $LASTEXITCODE
}
catch {
    Write-Host ""
    Write-Host "Stereovisor could not start:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
