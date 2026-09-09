param(
    [switch]$Preview,
    [switch]$KeepWorkspace
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ServicePort = if ($env:STEREOVISOR_SERVICE_PORT) { $env:STEREOVISOR_SERVICE_PORT } else { "5772" }
$CorePythonPath = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$AiPythonPath = Join-Path $ProjectRoot ".venv-ai\Scripts\python.exe"
$PythonPath = if ($Preview) { $CorePythonPath } else { $AiPythonPath }
$NpmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
$ElectronExecutable = Join-Path $ProjectRoot "node_modules\electron\dist\electron.exe"
$RunId = [Guid]::NewGuid().ToString("N")
$SmokeRoot = Join-Path ([IO.Path]::GetTempPath()) "stereovisor-smoke-$RunId"
$ProjectsRoot = Join-Path $SmokeRoot "projects"
$ModelsRoot = if ($Preview) { Join-Path $SmokeRoot "models" } else { Join-Path $ProjectRoot "service\.models" }
$UserDataRoot = Join-Path $SmokeRoot "user-data"
$ServiceProcess = $null
$RendererProcess = $null
$ElectronProcess = $null
$OriginalEnvironment = @{
    STEREOVISOR_MODE = $env:STEREOVISOR_MODE
    STEREOVISOR_PROJECT_ROOT = $env:STEREOVISOR_PROJECT_ROOT
    STEREOVISOR_MODEL_ROOT = $env:STEREOVISOR_MODEL_ROOT
    STEREOVISOR_APP_ROOT = $env:STEREOVISOR_APP_ROOT
    STEREOVISOR_BOOTSTRAP_STATUS = $env:STEREOVISOR_BOOTSTRAP_STATUS
    STEREOVISOR_BOOTSTRAP_COMPLETED = $env:STEREOVISOR_BOOTSTRAP_COMPLETED
    VITE_DEV_SERVER_URL = $env:VITE_DEV_SERVER_URL
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    if ($ProcessId -le 0) {
        return
    }
    # A child that exits between the walk and the kill makes taskkill write to
    # stderr, which "Stop" would turn into a terminating error and fail an
    # otherwise passing run from inside the cleanup block.
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

function Wait-Http {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [int]$Attempts = 60
    )
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        try {
            return Invoke-RestMethod -Uri $Uri -TimeoutSec 2
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    }
    throw "Timed out waiting for $Uri."
}

try {
    # A terminal hosted inside another Electron app exports this, which would
    # make our electron.exe run main.js as plain Node and exit immediately.
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

    if (-not (Test-Path -LiteralPath $PythonPath)) {
        throw "The project-managed Python environment is missing: $PythonPath"
    }
    if (-not $NpmCommand) {
        throw "npm.cmd was not found in PATH."
    }
    if (-not (Test-Path -LiteralPath $ElectronExecutable)) {
        throw "The project-managed Electron runtime is missing: $ElectronExecutable"
    }
    # Without this the run would connect to whatever already answers on these
    # ports and report on a service it never started.
    $BusyPorts = @(5173, [int]$ServicePort) | Where-Object {
        Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue
    }
    if ($BusyPorts.Count -gt 0) {
        throw "Port(s) $($BusyPorts -join ', ') are already in use. Close the running Stereovisor instance and run the smoke test again."
    }

    New-Item -ItemType Directory -Force -Path $ProjectsRoot, $UserDataRoot | Out-Null
    if ($Preview) { New-Item -ItemType Directory -Force -Path $ModelsRoot | Out-Null }
    $env:STEREOVISOR_MODE = if ($Preview) { "preview" } else { "ai" }
    $env:STEREOVISOR_PROJECT_ROOT = $ProjectsRoot
    $env:STEREOVISOR_MODEL_ROOT = $ModelsRoot
    $env:STEREOVISOR_APP_ROOT = $ProjectRoot
    $env:VITE_DEV_SERVER_URL = "http://127.0.0.1:5173"

    $ServiceProcess = Start-Process -FilePath $PythonPath `
        -ArgumentList @((Join-Path $ProjectRoot "service\scripts\run-service.py")) `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -PassThru
    $RendererProcess = Start-Process -FilePath $NpmCommand `
        -ArgumentList @("run", "dev:renderer") `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -PassThru

    $health = Wait-Http -Uri "http://127.0.0.1:$($ServicePort)/api/health"
    $renderer = Wait-Http -Uri "http://127.0.0.1:5173/"
    $ExpectedEngine = if ($Preview) { "preview" } else { "ai" }
    if ($health.localOnly -ne $true -or $health.activeEngine -ne $ExpectedEngine) {
        throw "The isolated service did not report the expected $ExpectedEngine engine."
    }
    $RequiredProviders = @("runtime", "segmentation", "matting", "depth", "inpainting")
    if (-not $Preview) {
        $MissingProviders = $RequiredProviders | Where-Object {
            $ProviderStatus = $health.providers.PSObject.Properties[$_].Value
            -not $ProviderStatus.available
        }
        if ($MissingProviders.Count -gt 0 -or $health.startupState -ne "ready") {
            throw "The project-managed AI environment is not ready: $($MissingProviders -join ', ')."
        }
    }
    else {
        # An empty model folder is the real first-launch shape. Drive one
        # bootstrap status through the launcher helper and confirm the health
        # endpoint reports the progress the startup gate renders.
        $env:STEREOVISOR_BOOTSTRAP_STATUS = Join-Path $ModelsRoot ".stereovisor-bootstrap-status"
        $env:STEREOVISOR_BOOTSTRAP_COMPLETED = ""
        . (Join-Path $ProjectRoot "service\scripts\bootstrap-status.ps1")
        New-Item -ItemType File -Force -Path (Join-Path $ModelsRoot ".stereovisor-bootstrap-running") | Out-Null
        Complete-BootstrapProvider -Provider "runtime"
        Publish-BootstrapStatus -State "downloading" -Detail "Downloading depth model (42%)." -Provider "depth" -Progress 42

        $preparing = Invoke-RestMethod -Uri "http://127.0.0.1:$($ServicePort)/api/health" -TimeoutSec 5
        $ProviderState = { param($name) $preparing.providers.PSObject.Properties[$name].Value }
        if ($preparing.startupState -ne "downloading" -or $preparing.startupProgress -ne 42) {
            throw "The first-launch health endpoint did not report the active download."
        }
        if ((& $ProviderState "runtime").state -ne "ready" -or (& $ProviderState "runtime").available -ne $false) {
            throw "The first-launch health endpoint did not report the prepared local AI runtime."
        }
        if ((& $ProviderState "depth").progress -ne 42 -or (& $ProviderState "segmentation").state -ne "waiting") {
            throw "The first-launch health endpoint did not report per-provider startup progress."
        }

        Remove-Item -LiteralPath (Join-Path $ModelsRoot ".stereovisor-bootstrap-running") -Force
        Remove-Item -LiteralPath $env:STEREOVISOR_BOOTSTRAP_STATUS -Force
        $stopped = Invoke-RestMethod -Uri "http://127.0.0.1:$($ServicePort)/api/health" -TimeoutSec 5
        if ($stopped.startupState -ne "blocked") {
            throw "The health endpoint kept a transient startup state after preparation stopped."
        }
    }
    if (-not ($renderer -match "<title>Stereovisor</title>")) {
        throw "The isolated renderer did not serve the Stereovisor document."
    }

    # Electron opens visibly on purpose: a hidden window style suppresses the
    # main window title, and this test exists to prove that window appears.
    $ElectronProcess = Start-Process -FilePath $ElectronExecutable `
        -ArgumentList @(".", "--user-data-dir=$UserDataRoot") `
        -WorkingDirectory $ProjectRoot `
        -PassThru
    # A cold Electron start takes several seconds on an idle machine and
    # noticeably longer on a loaded one, so this budget is generous on purpose:
    # a slow window is not the failure this test exists to catch.
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        $window = Get-Process -Id $ElectronProcess.Id -ErrorAction SilentlyContinue
        if ($window -and $window.MainWindowTitle -eq "Stereovisor") { break }
        if ($ElectronProcess.HasExited) { throw "Electron exited during the isolated smoke test." }
        Start-Sleep -Milliseconds 500
    }
    $window = Get-Process -Id $ElectronProcess.Id -ErrorAction SilentlyContinue
    if (-not $window -or $window.MainWindowTitle -ne "Stereovisor") {
        throw "Electron did not open a Stereovisor window in the isolated smoke test."
    }

    if ($Preview) {
        $started = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($ServicePort)/api/jobs/sample" -TimeoutSec 10
        $job = $null
        for ($attempt = 0; $attempt -lt 120; $attempt++) {
            $job = Invoke-RestMethod -Uri "http://127.0.0.1:$($ServicePort)/api/jobs/$($started.jobId)" -TimeoutSec 5
            if ($job.state -eq "completed") { break }
            if ($job.state -in @("failed", "cancelled")) {
                throw "The isolated sample workflow ended in state '$($job.state)': $($job.message)"
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not $job -or $job.state -ne "completed") {
            throw "The isolated sample workflow did not finish within 30 seconds."
        }
        $sample = $job.result
        if (-not $sample.id -or @($sample.layers).Count -lt 2) {
            throw "The isolated sample workflow did not create a layered project."
        }
    }
    $EnvironmentName = if ($Preview) { ".venv preview" } else { ".venv-ai CUDA" }
    Write-Host "Stereovisor smoke test passed ($EnvironmentName, isolated user data, renderer, Electron, and local service)." -ForegroundColor Green
}
finally {
    if ($ElectronProcess -and -not $ElectronProcess.HasExited) { Stop-ProcessTree -ProcessId $ElectronProcess.Id }
    if ($RendererProcess -and -not $RendererProcess.HasExited) { Stop-ProcessTree -ProcessId $RendererProcess.Id }
    if ($ServiceProcess -and -not $ServiceProcess.HasExited) { Stop-ProcessTree -ProcessId $ServiceProcess.Id }
    foreach ($name in $OriginalEnvironment.Keys) {
        if ($null -eq $OriginalEnvironment[$name]) {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item "Env:$name" $OriginalEnvironment[$name]
        }
    }
    if (-not $KeepWorkspace -and (Test-Path -LiteralPath $SmokeRoot)) {
        # Electron keeps its cache files open for a moment after its process
        # tree exits, so the first delete can fail with "access denied". Retry
        # briefly, then warn: teardown must never turn a passing smoke test
        # into a failing exit code.
        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            try {
                Remove-Item -LiteralPath $SmokeRoot -Recurse -Force -ErrorAction Stop
                break
            }
            catch {
                Start-Sleep -Milliseconds 500
            }
        }
        if (Test-Path -LiteralPath $SmokeRoot) {
            Write-Host "Smoke workspace could not be removed and was left at $SmokeRoot" -ForegroundColor DarkYellow
        }
    }
    elseif (Test-Path -LiteralPath $SmokeRoot) {
        Write-Host "Smoke workspace retained at $SmokeRoot" -ForegroundColor Yellow
    }
}
