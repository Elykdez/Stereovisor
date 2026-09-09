$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ElectronRoot = Join-Path $ProjectRoot "node_modules\electron"
$PackagePath = Join-Path $ElectronRoot "package.json"
$ChecksumsPath = Join-Path $ElectronRoot "checksums.json"

if (-not (Test-Path -LiteralPath $PackagePath) -or -not (Test-Path -LiteralPath $ChecksumsPath)) {
    throw "Install npm dependencies before installing the Electron runtime."
}

$ElectronPackage = Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json
$Version = $ElectronPackage.version
$Filename = "electron-v$Version-win32-x64.zip"
$Checksums = Get-Content -LiteralPath $ChecksumsPath -Raw | ConvertFrom-Json
$ExpectedHash = $Checksums.PSObject.Properties[$Filename].Value
if (-not $ExpectedHash) {
    throw "Electron checksum is unavailable for $Filename."
}

$DistPath = Join-Path $ElectronRoot "dist"
$ExecutablePath = Join-Path $DistPath "electron.exe"
$InstalledVersionPath = Join-Path $DistPath "version"
if ((Test-Path -LiteralPath $ExecutablePath) -and (Test-Path -LiteralPath $InstalledVersionPath)) {
    $InstalledVersion = (Get-Content -LiteralPath $InstalledVersionPath -Raw).Trim().TrimStart("v")
    if ($InstalledVersion -eq $Version) {
        Write-Host "Electron $Version is already installed."
        exit 0
    }
}

$CachePath = Join-Path $ProjectRoot ".cache"
New-Item -ItemType Directory -Path $CachePath -Force | Out-Null
$ArchivePath = Join-Path $CachePath $Filename
$Url = "https://github.com/electron/electron/releases/download/v$Version/$Filename"

& curl.exe -L --fail --retry 20 --retry-all-errors --retry-delay 2 --connect-timeout 30 --speed-time 30 --speed-limit 1024 --continue-at - --output $ArchivePath $Url
if ($LASTEXITCODE -ne 0) {
    throw "Electron download failed. Re-run this script to resume $Filename."
}

$ActualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualHash -ne $ExpectedHash.ToLowerInvariant()) {
    throw "Electron archive checksum mismatch."
}

New-Item -ItemType Directory -Path $DistPath -Force | Out-Null
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DistPath -Force
Set-Content -LiteralPath (Join-Path $ElectronRoot "path.txt") -Value "electron.exe" -NoNewline -Encoding ascii
Write-Host "Electron $Version installed and verified."
