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

Step "Writing .github/workflows/ci-cd.yml"
New-Item -ItemType Directory -Force .github\workflows | Out-Null
$ci = @'
# Build, package and release the desktop app.
#
# Packaging runs only on a client-v* tag. The installer bundles both halves, so
# a service-v* tag is a history marker and does not produce an artifact.
#
# The version comes from versions.json, not from the tag. The tag is checked
# against it so a mistyped tag fails before anything is built.

name: CI/CD

env:
  NODE_VERSION: "22"
  PYTHON_VERSION: "3.12"
  NAME: "Stereovisor"

on:
  push:
    branches: [main]
    tags:
      - "client-v*"
      - "service-v*"
  pull_request:
    branches: [main]

jobs:
  client:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm

      - run: npm ci
      - run: npm run version:check
      - run: npm run i18n:check
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

  service:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}
          cache: pip

      - run: pip install -r service/requirements-core.txt

      # Preview mode keeps the suite off the CUDA stack and the model weights.
      - run: python -m pytest service/tests
        env:
          STEREOVISOR_MODE: preview

  package:
    if: startsWith(github.ref, 'refs/tags/client-v')
    needs: [client, service]
    runs-on: windows-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v5

      - uses: actions/setup-node@v5
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm

      - uses: actions/setup-python@v5
        with:
          python-version: ${{ env.PYTHON_VERSION }}

      - name: Resolve and verify version
        id: version
        shell: pwsh
        run: |
          $versions = Get-Content versions.json -Raw | ConvertFrom-Json
          $tagged = "${{ github.ref_name }}".Substring("client-v".Length)
          if ($versions.client -ne $tagged) {
            throw "Tag ${{ github.ref_name }} does not match versions.json client $($versions.client)."
          }
          "version=$($versions.client)" >> $env:GITHUB_OUTPUT
          "service=$($versions.service)" >> $env:GITHUB_OUTPUT

      - name: Free disk space
        shell: pwsh
        run: |
          # The three Python environments plus Electron do not fit alongside the
          # runner's preinstalled SDKs.
          Get-PSDrive C | Select-Object Used, Free
          Remove-Item -Recurse -Force "C:\Android", "C:\Program Files\dotnet\sdk" -ErrorAction SilentlyContinue
          Get-PSDrive C | Select-Object Used, Free

      - name: Install Node dependencies
        run: npm ci

      - name: Build the core Python environment
        shell: pwsh
        run: |
          python -m venv .venv
          .\.venv\Scripts\python.exe -m pip install --upgrade pip
          .\.venv\Scripts\python.exe -m pip install -r service\requirements-core.txt

      - name: Build the CUDA AI environments
        shell: pwsh
        # No GPU on a hosted runner, so the wheels install but the runtime probe
        # at the end of setup-ai.ps1 cannot pass. Skipping it is build-only.
        env:
          STEREOVISOR_SKIP_CUDA_VERIFY: "1"
        run: .\service\scripts\setup-ai.ps1

      - name: Package
        run: npm run package

      - name: Upload installers
        uses: actions/upload-artifact@v5
        with:
          name: ${{ env.NAME }}-windows-x64
          path: |
            release/${{ env.NAME }}-${{ steps.version.outputs.version }}-setup.exe
            release/${{ env.NAME }}-${{ steps.version.outputs.version }}-portable.exe
          if-no-files-found: error
          overwrite: true

  release:
    if: startsWith(github.ref, 'refs/tags/client-v')
    needs: package
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v5

      - uses: actions/download-artifact@v5
        with:
          merge-multiple: true

      - name: Resolve version
        id: version
        run: |
          VERSION=$(node -p "require('./versions.json').client")
          SERVICE=$(node -p "require('./versions.json').service")
          echo "version=$VERSION" >> $GITHUB_OUTPUT
          echo "service=$SERVICE" >> $GITHUB_OUTPUT

      - name: Create release
        uses: softprops/action-gh-release@v3
        with:
          name: ${{ env.NAME }} ${{ steps.version.outputs.version }}
          body: |
            Client ${{ steps.version.outputs.version }}, service ${{ steps.version.outputs.service }}.

            Windows x64. The installer ships the Python runtimes; model weights
            download on first launch.
          fail_on_unmatched_files: true
          files: |
            ${{ env.NAME }}-${{ steps.version.outputs.version }}-setup.exe
            ${{ env.NAME }}-${{ steps.version.outputs.version }}-portable.exe
'@
Set-Content -Path .github\workflows\ci-cd.yml -Value $ci -Encoding UTF8
Note "Written."

Step "Running npm run check"
npm run check
if ($LASTEXITCODE -ne 0) { throw "npm run check failed. Nothing has been committed." }

Step "Committing"
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Note "Nothing staged; working tree already matches HEAD."
} else {
  git commit -m "Untrack AGENTS.md and add CI"
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
Note "This is the slow one: the installer embeds .venv, .venv-ai and .venv-powerpaint."
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
