# Stereovisor release, part 2 of 2: GitHub release, public visibility, main ruleset.
# Run only after .\scripts\release.ps1 succeeded and the packaged app passed its smoke test.
# Two steps here are not reversible from a script. Each asks first.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Repo = "Elykdez/Stereovisor"

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }
function Confirm($prompt) {
  $answer = Read-Host "$prompt [y/N]"
  return $answer -eq "y"
}

# Anchor on the repository root so the release\ artifact paths below resolve
# regardless of where this was invoked from.
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path .\versions.json)) {
  throw "Expected the repository root at $(Get-Location) but found no versions.json."
}

$versions = Get-Content .\versions.json -Raw | ConvertFrom-Json
$client = $versions.client
$service = $versions.service

$setup = "release\Stereovisor-$client-setup.exe"
$portable = "release\Stereovisor-$client-portable.exe"
foreach ($artifact in @($setup, $portable)) {
  if (-not (Test-Path $artifact)) { throw "Missing $artifact. Run .\scripts\release.ps1 first." }
}

Step "Publishing the GitHub release"
# Pushing the tag also triggers the CI/CD package job, which may have created
# this release already. Upload into it rather than colliding with it.
gh release view "client-v$client" --repo $Repo 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Note "Release client-v$client already exists (CI likely got there first)."
  if (Confirm "Overwrite its assets with the locally built installers?") {
    gh release upload "client-v$client" --repo $Repo --clobber $setup $portable
    if ($LASTEXITCODE -ne 0) { throw "Asset upload failed." }
  } else {
    Note "Left the existing assets alone."
  }
} else {
  gh release create "client-v$client" --repo $Repo `
    --title "Stereovisor $client" `
    --notes "Client $client, service $service. Windows only." `
    $setup $portable
  if ($LASTEXITCODE -ne 0) { throw "Release creation failed." }
}

Step "Scanning history for credentials"
# Visibility applies to the whole history, so a token in an old commit is
# exposed even when the current tree is clean.
$hits = git log --all -p |
  Select-String -Pattern "AUTH_TOKEN|api[_-]?key|secret|password|BEGIN .*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{16,}" |
  Select-Object -First 40
if ($hits) {
  Write-Host "Possible credentials in history:" -ForegroundColor Red
  $hits | ForEach-Object { Write-Host "  $_" }
  Write-Host "These are keyword matches, not confirmed secrets. Read them before continuing." -ForegroundColor Yellow
} else {
  Note "No keyword matches. Absence of matches is not proof; the pattern list is not exhaustive."
}

Step "Making $Repo public"
Write-Host "This exposes every commit in the history, not just the current tree." -ForegroundColor Yellow
if (Confirm "Make $Repo public?") {
  gh repo edit $Repo --visibility public --accept-visibility-change-consequences
  if ($LASTEXITCODE -ne 0) { throw "Visibility change failed." }
  Note "Public."
} else {
  Note "Skipped. The ruleset step below still works on a private repo."
}

Step "Protecting main"
Note "Restrict deletions, require linear history, require a pull request, block force pushes."
Note "After this, direct pushes to main stop working."
if (Confirm "Apply the ruleset?") {
  $ruleset = @'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "required_linear_history" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    }
  ]
}
'@
  $temp = New-TemporaryFile
  Set-Content -Path $temp -Value $ruleset -Encoding UTF8
  gh api --method POST "repos/$Repo/rulesets" --input $temp
  $applied = $LASTEXITCODE
  Remove-Item $temp -Force
  if ($applied -ne 0) { throw "Ruleset creation failed." }
  Note "Applied."
} else {
  Note "Skipped."
}

Step "Done"
gh repo view $Repo --json name,visibility,url | Write-Host
