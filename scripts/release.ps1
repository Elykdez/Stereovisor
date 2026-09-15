# Stereovisor release, part 1 of 2: verify, commit, tag, package.
# Stops before anything is published. Run .\scripts\publish.ps1 after the smoke test.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" -ForegroundColor DarkGray }

# Every git and npm call below assumes the repository root, so anchor there
# rather than trusting the caller's working directory.
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path .\versions.json)) {
  throw "Expected the repository root at $(Get-Location) but found no versions.json."
}

$versions = Get-Content .\versions.json -Raw | ConvertFrom-Json
$client = $versions.client
$service = $versions.service
Write-Host "Client $client, service $service" -ForegroundColor Green

Step "Untracking AGENTS.md"
# Already-tracked files ignore .gitignore, so it needs an explicit index removal.
git ls-files --error-unmatch AGENTS.md 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  git rm --cached AGENTS.md
  Note "Removed from the index. Your local copy is untouched."
} else {
  Note "Already untracked."
}

Step "Verifying .github/workflows/ci-cd.yml"
if (-not (Test-Path .\.github\workflows\ci-cd.yml)) {
  throw "The committed cross-platform CI workflow is missing."
}
Note "Using the committed Windows, Apple Silicon macOS, and Linux release workflow."

Step "Running npm run check"
npm run check
if ($LASTEXITCODE -ne 0) { throw "npm run check failed. Nothing has been committed." }

Step "Committing"
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Note "Nothing staged; working tree already matches HEAD."
} else {
  git commit -m "Prepare cross-platform release"
  if ($LASTEXITCODE -ne 0) { throw "Commit failed." }
}

git push origin main
if ($LASTEXITCODE -ne 0) { throw "Push failed." }

Step "Tagging"
foreach ($pair in @(@("client", $client), @("service", $service))) {
  $tag = "$($pair[0])-v$($pair[1])"
  git rev-parse -q --verify "refs/tags/$tag" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Note "$tag already exists; leaving it alone."
  } else {
    git tag -a $tag -m "$($pair[0]) $($pair[1])"
    Note "Created $tag."
  }
}
git push origin "client-v$client" "service-v$service"
if ($LASTEXITCODE -ne 0) { throw "Tag push failed." }

Step "Packaging for Windows"
Note "This local step builds Windows; CI builds and tests macOS and Linux from the client tag."
npm run package
if ($LASTEXITCODE -ne 0) { throw "Packaging failed." }

Step "Artifacts"
Get-ChildItem release\Stereovisor-$client-*.exe | Select-Object Name, Length

Write-Host "`nSmoke-test before publishing:" -ForegroundColor Yellow
Write-Host "  1. Run release\win-unpacked\Stereovisor.exe"
Write-Host "  2. About should read $client"
Write-Host "  3. Options -> enable the service console; its first line should read"
Write-Host "     'Stereovisor service $service'"
Write-Host "`nThen run .\scripts\publish.ps1" -ForegroundColor Yellow
