$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AppVersion = (Get-Content -LiteralPath (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json).version
$ServicePort = if ($env:STEREOVISOR_SERVICE_PORT) { $env:STEREOVISOR_SERVICE_PORT } else { "5772" }
$ShowConsole = $env:STEREOVISOR_SHOW_CONSOLE -in @("1", "true", "yes")
$AppProcess = $null
$BootstrapServiceProcess = $null
$ServiceProcess = $null
$ModelRoot = Join-Path $ProjectRoot "service\.models"
$BootstrapMarker = Join-Path $ModelRoot ".stereovisor-bootstrap-running"
$BootstrapClaimed = $false
$env:STEREOVISOR_BOOTSTRAP_STATUS = Join-Path $ModelRoot ".stereovisor-bootstrap-status"
# Start from an empty set: an inherited value would claim stages this launch
# has not verified.
$env:STEREOVISOR_BOOTSTRAP_COMPLETED = ""
. (Join-Path $ProjectRoot "service\scripts\bootstrap-status.ps1")

# A terminal hosted inside another Electron app exports this, which would make
# our electron.exe run main.js as plain Node and exit before a window opens.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

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

function Wait-StereovisorRenderer {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        # A listening socket can exist before Vite has served index.html. Use
        # the real renderer probe so Electron never opens against a half-ready
        # dev host on a cold start.
        if (Test-StereovisorRenderer) {
            return
        }
        if ($script:AppProcess -and $script:AppProcess.HasExited) {
            throw "The Stereovisor renderer stopped before the app window opened."
        }
        Start-Sleep -Milliseconds 500
    }
    throw "The Stereovisor renderer did not start within 60 seconds."
}

function Stop-StereovisorProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    if ($ProcessId -le 0) {
        return
    }
    # A child that exits between the walk and the kill makes taskkill write to
    # stderr. Under "Stop" that becomes a terminating error, which would abort
    # the launcher from inside its own cleanup path.
    $PreviousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & taskkill.exe /PID $ProcessId /T /F *> $null
    }
    catch {
        Write-Host "Could not fully stop process tree $ProcessId." -ForegroundColor DarkYellow
    }
    finally {
        $ErrorActionPreference = $PreviousErrorAction
    }
}

function Start-StereovisorApp {
    $NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $NpmCommand) {
        $NpmCommand = Get-Command npm -ErrorAction Stop
    }
    # The Electron window must appear before AI setup; keep its dev-host
    # process hidden so the optional service console is the only extra window.
    $script:AppProcess = Start-Process -FilePath $NpmCommand.Source `
        -ArgumentList @("run", "dev:app") `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -PassThru
    Wait-StereovisorRenderer
}

function Ensure-StereovisorCore {
    $CorePython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
    $ElectronExecutable = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
    if ((Test-Path -LiteralPath $CorePython) -and (Test-Path -LiteralPath $ElectronExecutable)) {
        return
    }
    Write-Host "Preparing the Stereovisor core environment before opening the app..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "setup-core.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Core setup failed with exit code $LASTEXITCODE."
    }
}

function Start-StereovisorService {
    $ServiceWindowStyle = if ($ShowConsole) { "Normal" } else { "Hidden" }
    return Start-Process -FilePath "powershell.exe" `
        -ArgumentList @(
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            (Join-Path $ProjectRoot "service\scripts\start-service.ps1")
        ) `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle $ServiceWindowStyle `
        -PassThru
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
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$($ServicePort)/api/health" -TimeoutSec 2
        return $Health.status -eq "ok" -and $Health.version -eq $AppVersion -and $Health.localOnly -eq $true
    }
    catch {
        return $false
    }
}

function Test-StereovisorAiService {
    try {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$($ServicePort)/api/health" -TimeoutSec 2
        $RequiredProviders = @("runtime", "segmentation", "matting", "depth", "inpainting")
        return $Health.status -eq "ok" -and
            $Health.version -eq $AppVersion -and
            $Health.localOnly -eq $true -and
            $Health.activeEngine -eq "ai" -and
            $Health.startupState -eq "ready" -and
            @($RequiredProviders | Where-Object {
                -not $Health.providers.PSObject.Properties[$_].Value.available
            }).Count -eq 0
    }
    catch {
        return $false
    }
}

function Test-StereovisorInstallation {
    $RequiredFiles = @(
        (Join-Path $ProjectRoot ".venv-ai\Scripts\python.exe"),
        (Join-Path $ProjectRoot ".venv-powerpaint\Scripts\python.exe"),
        (Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"),
        (Join-Path $ModelRoot "grounding-dino-base\.stereovisor-ready"),
        (Join-Path $ModelRoot "sam2.1-hiera-small\.stereovisor-ready"),
        (Join-Path $ModelRoot "da3-small\.stereovisor-ready"),
        (Join-Path $ModelRoot "inspyrenet\ckpt_base.pth"),
        (Join-Path $ModelRoot "big-lama.pt")
    )
    return @($RequiredFiles | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0
}

function Stop-OrphanedStereovisorService {
    if (Test-StereovisorRenderer) { return $false }
    $serviceScript = (Join-Path $ProjectRoot "service\scripts\run-service.py").ToLowerInvariant()
    $managedProcessIds = @()
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $ServicePort -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
        if (-not $process -or -not $process.CommandLine -or -not $process.CommandLine.ToLowerInvariant().Contains($serviceScript)) {
            continue
        }
        $current = $process
        while ($current -and $current.CommandLine -and (
                $current.CommandLine.ToLowerInvariant().Contains($serviceScript) -or
                $current.CommandLine.ToLowerInvariant().Contains((Join-Path $ProjectRoot "service\scripts\start-service.ps1").ToLowerInvariant())
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
    for ($attempt = 0; $attempt -lt 20 -and (Test-TcpPort -Port $ServicePort); $attempt++) {
        Start-Sleep -Milliseconds 250
    }
    return $true
}

try {
    $RendererReady = Test-StereovisorRenderer
    $AiServiceReady = Test-StereovisorAiService
    if ($RendererReady -and $AiServiceReady) {
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

    if ($AiServiceReady) {
        if (Test-TcpPort -Port 5173) {
            throw "Stereovisor cannot start because port 5173 is occupied by another process. Close that process and run Stereovisor again."
        }
        $env:STEREOVISOR_MODE = "ai"
        $env:STEREOVISOR_DEVICE = "cuda"
        $env:STEREOVISOR_MODEL_ROOT = Join-Path $ProjectRoot "service\.models"
        Write-Host "Reusing the running Stereovisor local service..." -ForegroundColor Cyan
        Start-StereovisorApp
        Wait-Process -Id $AppProcess.Id
        exit $AppProcess.ExitCode
    }

    [void](Stop-OrphanedStereovisorService)
    $BusyPorts = @()
    if (Test-TcpPort -Port 5173) { $BusyPorts += "5173" }
    if (Test-TcpPort -Port $ServicePort) { $BusyPorts += "$ServicePort" }
    if ($BusyPorts.Count -gt 0) {
        throw "Stereovisor cannot start because port(s) $($BusyPorts -join ', ') are occupied by another process. Close that process and run Stereovisor again."
    }

    $env:STEREOVISOR_MODE = "ai"
    $env:STEREOVISOR_DEVICE = "cuda"
    $env:STEREOVISOR_MODEL_ROOT = $ModelRoot

    # A stopped service is not an uninstalled application. Once the local
    # runtime and required weights exist, start that offline service directly
    # and open the editor only after its live provider checks pass.
    if (Test-StereovisorInstallation) {
        Remove-Item Env:\STEREOVISOR_PREPARATION_ONLY -ErrorAction SilentlyContinue
        $env:STEREOVISOR_PYTHON = Join-Path $ProjectRoot ".venv-ai\Scripts\python.exe"
        Write-Host "Starting the installed Stereovisor local service..." -ForegroundColor Cyan
        $ServiceProcess = Start-StereovisorService
        for ($attempt = 0; $attempt -lt 240 -and -not (Test-StereovisorAiService); $attempt++) {
            if ($ServiceProcess.HasExited) { break }
            Start-Sleep -Milliseconds 500
        }
        if (Test-StereovisorAiService) {
            Start-StereovisorApp
            Wait-Process -Id $AppProcess.Id
            exit $AppProcess.ExitCode
        }

        # An apparently complete but damaged installation returns to the
        # preparation path, where ensure-ready.ps1 can repair it.
        if ($ServiceProcess -and -not $ServiceProcess.HasExited) {
            Stop-StereovisorProcessTree -ProcessId $ServiceProcess.Id
        }
        $ServiceProcess = $null
        for ($attempt = 0; $attempt -lt 20 -and (Test-TcpPort -Port $ServicePort); $attempt++) {
            Start-Sleep -Milliseconds 250
        }
    }

    # Claim the bootstrap before the health service can answer. Without this the
    # renderer's first poll would read a stale status file and briefly show a
    # "not ready" card on every launch.
    New-Item -ItemType Directory -Force -Path $ModelRoot | Out-Null
    New-Item -ItemType File -Force -Path $BootstrapMarker | Out-Null
    $BootstrapClaimed = $true
    Publish-BootstrapStatus -State "starting" -Detail "Starting the local Stereovisor services." -Provider "runtime" -Progress 1

    # First-time setup uses a dedicated progress surface. The editor is not
    # rendered until the prepared AI service verifies every required provider.
    $env:STEREOVISOR_PREPARATION_ONLY = "1"

    # The preparation window can show its startup gate while the Python core is
    # being provisioned. Only defer the window when Electron itself is absent.
    $ElectronExecutable = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
    if (Test-Path -LiteralPath $ElectronExecutable) {
        Start-StereovisorApp
        Ensure-StereovisorCore
    }
    else {
        Ensure-StereovisorCore
        Start-StereovisorApp
    }

    # A core-only service gives the renderer a live health endpoint while the
    # CUDA environment and model files are being prepared. It is replaced by
    # the selected AI runtime after ensure-ready.ps1 completes.
    $env:STEREOVISOR_PYTHON = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
    $BootstrapServiceProcess = Start-StereovisorService

    # The app is already visible and shows its connecting state while this
    # synchronous preparation installs/validates the local AI stack.
    try {
        . (Join-Path $PSScriptRoot "ensure-ready.ps1")
    }
    catch {
        # Keep the core health service and locked editor alive so the user can
        # see the actionable bootstrap failure instead of losing the window.
        Write-Host "Local AI preparation is blocked: $($_.Exception.Message)" -ForegroundColor Red
        Wait-Process -Id $AppProcess.Id
        exit 1
    }

    # The core health service is replaced by the prepared CUDA runtime here.
    # Hold the bootstrap marker across the swap so the startup gate keeps
    # showing an honest "initializing" state instead of a transient failure.
    New-Item -ItemType File -Force -Path $BootstrapMarker | Out-Null
    # ensure-ready.ps1 only returns once every required model is downloaded and
    # validated, so the gate can hold a complete readout across the swap.
    foreach ($Provider in @("runtime", "segmentation", "matting", "depth", "inpainting")) {
        Complete-BootstrapProvider -Provider $Provider
    }
    Publish-BootstrapStatus -State "initializing" -Detail "Starting the local AI service." -Provider "runtime" -Progress 100
    Stop-StereovisorProcessTree -ProcessId $BootstrapServiceProcess.Id
    for ($attempt = 0; $attempt -lt 20 -and (Test-TcpPort -Port $ServicePort); $attempt++) {
        Start-Sleep -Milliseconds 250
    }
    Write-Host "Starting Stereovisor with local AI..." -ForegroundColor Green
    $ServiceProcess = Start-StereovisorService
    for ($attempt = 0; $attempt -lt 240 -and -not (Test-StereovisorService); $attempt++) {
        if ($ServiceProcess.HasExited) { break }
        Start-Sleep -Milliseconds 500
    }
    Remove-Item -LiteralPath $BootstrapMarker -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $AppProcess.Id
    exit $AppProcess.ExitCode
}
catch {
    Write-Host ""
    Write-Host "Stereovisor could not start:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
finally {
    if ($BootstrapClaimed) {
        Remove-Item -LiteralPath $BootstrapMarker -Force -ErrorAction SilentlyContinue
    }
    if ($BootstrapServiceProcess -and -not $BootstrapServiceProcess.HasExited) {
        Stop-StereovisorProcessTree -ProcessId $BootstrapServiceProcess.Id
    }
    if ($ServiceProcess -and -not $ServiceProcess.HasExited -and -not $ShowConsole) {
        Stop-StereovisorProcessTree -ProcessId $ServiceProcess.Id
    }
    if ($AppProcess -and -not $AppProcess.HasExited) {
        Stop-StereovisorProcessTree -ProcessId $AppProcess.Id
    }
}
