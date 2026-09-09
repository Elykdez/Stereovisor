# Dot-sourced status publisher shared by the launcher scripts. Every stage of a
# first launch writes the same small file that /api/health reads, so the app's
# startup gate can show real progress instead of an opaque wait.
$ErrorActionPreference = "Stop"

function Complete-BootstrapProvider {
    param([Parameter(Mandatory = $true)][string]$Provider)

    # Completed stages travel in the environment so child scripts keep reporting
    # the work their parent already finished. The core-only health service
    # cannot import the AI packages, so it has no other way to know.
    $Completed = @($env:STEREOVISOR_BOOTSTRAP_COMPLETED -split "," | Where-Object { $_ })
    if ($Completed -notcontains $Provider) {
        $Completed += $Provider
    }
    $env:STEREOVISOR_BOOTSTRAP_COMPLETED = $Completed -join ","
}

function Publish-BootstrapStatus {
    param(
        [Parameter(Mandatory = $true)][string]$State,
        [Parameter(Mandatory = $true)][string]$Detail,
        [string]$Provider,
        [Nullable[int]]$Progress
    )

    $StatusPath = $env:STEREOVISOR_BOOTSTRAP_STATUS
    if (-not $StatusPath) {
        return
    }
    $Lines = @($State, $Detail)
    if ($Provider) { $Lines += "provider=$Provider" }
    if ($null -ne $Progress) { $Lines += "progress=$([Math]::Max(0, [Math]::Min(100, $Progress)))" }
    if ($env:STEREOVISOR_BOOTSTRAP_COMPLETED) { $Lines += "completed=$env:STEREOVISOR_BOOTSTRAP_COMPLETED" }
    try {
        # Write beside the target and move into place so a concurrent health
        # read never observes a half-written status file.
        # The pid keeps this writer's staging file distinct from the one
        # prepare-models.py uses; a shared name lets the two collide.
        $Temporary = "$StatusPath.$PID.tmp"
        Set-Content -LiteralPath $Temporary -Value $Lines -Encoding utf8
        Move-Item -LiteralPath $Temporary -Destination $StatusPath -Force
    }
    catch {
        # Status is diagnostic only. A locked or read-only model directory must
        # never stop an otherwise valid preparation run.
        Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue
    }
}
