$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Test-TcpPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $Client = [System.Net.Sockets.TcpClient]::new()
    try {
        $Connection = $Client.ConnectAsync("127.0.0.1", $Port)
        return $Connection.Wait(750) -and $Client.Connected
    }
    catch {
        return $false
    }
    finally {
        $Client.Dispose()
    }
}

function Test-StereovisorRenderer {
    try {
        $Response = Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 2
        return $Response.StatusCode -eq 200 -and $Response.Content -match "<title>Stereovisor</title>"
    }
    catch {
        return $false
    }
}

function Test-StereovisorService {
    try {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:5179/api/health" -TimeoutSec 2
        return $Health.status -eq "ok" -and $Health.localOnly -eq $true
    }
    catch {
        return $false
    }
}

function Stop-OrphanedStereovisorService {
    if (Test-StereovisorRenderer) { return $false }
    $serviceScript = (Join-Path $ProjectRoot "scripts\run-service.py").ToLowerInvariant()
    $managedProcessIds = @()
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 5179 -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
        if (-not $process -or -not $process.CommandLine -or -not $process.CommandLine.ToLowerInvariant().Contains($serviceScript)) {
            continue
        }
        $current = $process
        while ($current -and $current.CommandLine -and (
                $current.CommandLine.ToLowerInvariant().Contains($serviceScript) -or
                $current.CommandLine.ToLowerInvariant().Contains((Join-Path $ProjectRoot "scripts\start-service.ps1").ToLowerInvariant())
            )) {
            $managedProcessIds += $current.ProcessId
            if (-not $current.ParentProcessId) { break }
            $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($current.ParentProcessId)"
        }
    }
    # Stop the listener first, then its project-owned parent wrappers.
    $managedProcessIds = @($managedProcessIds | Select-Object -Unique)
    if (-not $managedProcessIds.Count) { return $false }

    $workerCount = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match "python" -and $_.CommandLine -match "powerpaint-runner\.py"
    }).Count
    if ($workerCount -gt 0) {
        throw "A Stereovisor model worker is still active. Wait for it to finish, then run Stereovisor again."
    }
    Write-Host "Cleaning an orphaned Stereovisor local service..." -ForegroundColor Yellow
    foreach ($processId in $managedProcessIds) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    for ($attempt = 0; $attempt -lt 20 -and (Test-TcpPort -Port 5179); $attempt++) {
        Start-Sleep -Milliseconds 250
    }
    return $true
}

try {
    $RendererReady = Test-StereovisorRenderer
    $ServiceReady = Test-StereovisorService
    if ($RendererReady -and $ServiceReady) {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            throw "Node.js and npm were not found in PATH. Install Node.js 22 or newer, then run Stereovisor again."
        }
        $env:STEREOVISOR_MODE = "ai"
        $env:STEREOVISOR_DEVICE = "cuda"
        $env:STEREOVISOR_MODEL_ROOT = Join-Path $ProjectRoot "service\.models"
        Set-Location -LiteralPath $ProjectRoot
        Write-Host "Reusing the running Stereovisor local services..." -ForegroundColor Cyan
        & npm run dev:electron
        exit $LASTEXITCODE
    }

    [void](Stop-OrphanedStereovisorService)
    $BusyPorts = @()
    if (Test-TcpPort -Port 5173) { $BusyPorts += "5173" }
    if (Test-TcpPort -Port 5179) { $BusyPorts += "5179" }
    if ($BusyPorts.Count -gt 0) {
        throw "Stereovisor cannot start because port(s) $($BusyPorts -join ', ') are occupied by another process. Close that process and run Stereovisor again."
    }

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
