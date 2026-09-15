# Stereovisor v1.0.0 release runbook

Everything below has to run on your machine. This session can write files into
`E:\Workspace\Web\Stereovisor` but has no shell there, so it cannot run `git`,
`npm`, `electron-builder`, or `gh`.

Run from the repo root in PowerShell.

## 0. Save the CI workflow

`.github/workflows/ci.yml` is a protected path for remote tools, so it was not
written. Create it yourself from `ci.yml` delivered alongside this file:

```powershell
New-Item -ItemType Directory -Force .github\workflows
Copy-Item <path-to-downloaded>\ci.yml .github\workflows\ci.yml
```

## 1. Untrack AGENTS.md

`.gitignore` now lists it, but it is already tracked, so the ignore rule alone
does nothing. This removes it from the repo and from GitHub while keeping your
local copy on disk.

```powershell
git rm --cached AGENTS.md
```

## 2. Verify before committing

```powershell
npm run check
```

This now starts with `version:check`. If it reports a stale generated file, run
`npm run version:generate` and re-run the check.

## 3. Commit

```powershell
git add -A
git commit -m "Release v1.0.0: independent client and service versioning

Add versions.json as the single source for both component versions, with
scripts/version.mjs generating package.json and service/src/_version.py and
failing npm run check when either output is stale. Replace the three hardcoded
0.1.0 literals in the health schema, the FastAPI app, and the renderer version
fallback. Log the service version at startup so it appears in the console
window. Add CI and untrack AGENTS.md."
```

## 4. Tag both components

```powershell
git tag -a client-v1.0.0 -m "Client 1.0.0"
git tag -a service-v1.0.0 -m "Service 1.0.0"
git push origin main
git push origin client-v1.0.0 service-v1.0.0
```

## 5. Package for Windows

```powershell
npm run package
```

Writes `release\Stereovisor-1.0.0-setup.exe` and
`release\Stereovisor-1.0.0-portable.exe`. Both filenames pick up the version
from `package.json`, which `versions.json` now drives.

Smoke-test `release\win-unpacked\Stereovisor.exe` before publishing. Open About
and confirm it reads 1.0.0, then enable the service console in Options and
confirm the first log line reads `Stereovisor service 1.0.0`.

## 6. Publish the release

```powershell
gh release create client-v1.0.0 `
  --repo Elykdez/Stereovisor `
  --title "Stereovisor 1.0.0" `
  --notes "Client 1.0.0, service 1.0.0." `
  release\Stereovisor-1.0.0-setup.exe `
  release\Stereovisor-1.0.0-portable.exe
```

## 7. Make the repository public

Do a secrets pass first. The repo has 160 tracked files and this session has
not audited them.

```powershell
git log --all -p | Select-String -Pattern "AUTH_TOKEN|api[_-]?key|secret|BEGIN .*PRIVATE KEY" | Select-Object -First 40
```

History is public too once you flip this, so a token in an old commit is
exposed even if the current tree is clean.

```powershell
gh repo edit Elykdez/Stereovisor --visibility public --accept-visibility-change-consequences
```

## 8. Protect main

This matches the ruleset in your screenshot: restrict deletions, require linear
history, require a pull request before merging, block force pushes. The other
four boxes stay off.

```powershell
gh api --method POST repos/Elykdez/Stereovisor/rulesets `
  --input ruleset-main.json
```

`ruleset-main.json` is delivered alongside this file.

Verify:

```powershell
gh api repos/Elykdez/Stereovisor/rulesets
```

Note the ordering problem: a ruleset requiring a pull request blocks direct
pushes to `main`, so run this after step 4, not before.
