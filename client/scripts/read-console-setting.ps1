$ErrorActionPreference = "SilentlyContinue"

$SettingsPaths = @(
    (Join-Path $env:APPDATA "stereovisor\settings.json"),
    (Join-Path $env:APPDATA "Stereovisor\settings.json")
)

foreach ($SettingsPath in $SettingsPaths) {
    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        continue
    }
    try {
        $Settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
        if ($Settings.service.showConsole -eq $true) {
            "1"
        }
        break
    }
    catch {
        break
    }
}
