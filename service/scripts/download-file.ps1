# Dot-sourced resumable downloader shared by the setup scripts. pip streams a
# multi-gigabyte wheel in a single request and restarts from byte zero whenever
# the CDN connection stalls, so a slow or lossy link never finishes the CUDA
# Torch download. Fetching the file here with byte-range resume keeps every
# transferred byte across a stall, a retry, and a rerun of the whole setup.
$ErrorActionPreference = "Stop"

function Get-CurlPath {
    # "curl" is an Invoke-WebRequest alias in Windows PowerShell, so only the
    # bundled executable will do.
    $System32Curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (Test-Path -LiteralPath $System32Curl) {
        return $System32Curl
    }
    $Command = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }
    throw "curl.exe was not found. Windows 10 1803 and newer ship it in System32; install curl and run Stereovisor again."
}

function Test-FileSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Expected.ToUpperInvariant()
}

function Get-ResumableFile {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string]$Sha256,
        [string]$Label,
        [int]$Attempts = 8
    )

    if (-not $Label) { $Label = Split-Path -Leaf $Destination }
    if (Test-Path -LiteralPath $Destination) {
        if (-not $Sha256 -or (Test-FileSha256 -Path $Destination -Expected $Sha256)) {
            Write-Host "Reusing the cached $Label." -ForegroundColor Cyan
            return
        }
        Remove-Item -LiteralPath $Destination -Force
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    $Partial = "$Destination.partial"
    $Curl = Get-CurlPath
    $Publisher = Get-Command Publish-BootstrapStatus -ErrorAction SilentlyContinue

    for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
        $Resumed = 0
        if (Test-Path -LiteralPath $Partial) {
            $Resumed = (Get-Item -LiteralPath $Partial).Length
        }
        if ($Attempt -gt 1) {
            $Transferred = [Math]::Round($Resumed / 1MB)
            Write-Host "Resuming $Label at $Transferred MB (attempt $Attempt of $Attempts)." -ForegroundColor Yellow
            if ($Publisher) {
                Publish-BootstrapStatus -State "downloading" -Detail "Resuming the $Label download at $Transferred MB." -Provider "runtime" -Progress 20
            }
        }

        # Same transfer options the Electron runtime download uses.
        # --speed-limit/--speed-time abort a socket that has gone quiet instead
        # of blocking on it, so a stalled CDN connection becomes a fast resume
        # rather than an hour without progress. The outer loop exists because a
        # multi-gigabyte wheel can outlast even curl's own retry budget.
        & $Curl `
            --location `
            --fail `
            --continue-at - `
            --connect-timeout 30 `
            --speed-limit 1024 `
            --speed-time 30 `
            --retry 20 `
            --retry-all-errors `
            --retry-delay 2 `
            --progress-bar `
            --output $Partial `
            $Uri
        $ExitCode = $LASTEXITCODE

        # A partial that is already complete makes the server reject the resume
        # range, so the checksum decides the outcome before the exit code does.
        if ($Sha256 -and (Test-FileSha256 -Path $Partial -Expected $Sha256)) {
            Move-Item -LiteralPath $Partial -Destination $Destination -Force
            return
        }
        if ($ExitCode -eq 0) {
            if ($Sha256) {
                Write-Host "The downloaded $Label failed its checksum. Discarding it and starting over." -ForegroundColor Yellow
                Remove-Item -LiteralPath $Partial -Force
                continue
            }
            Move-Item -LiteralPath $Partial -Destination $Destination -Force
            return
        }

        # 33: the server refused the byte range. 36: the local partial no longer
        # matches the remote file. Neither can be resumed, so start clean.
        if ($ExitCode -eq 33 -or $ExitCode -eq 36) {
            Remove-Item -LiteralPath $Partial -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds ([Math]::Min(30, 5 * $Attempt))
    }

    throw "Downloading $Label from $Uri did not finish after $Attempts attempts."
}
