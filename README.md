# Stereovisor

Stereovisor is a local-first Electron studio that turns one image into a layered 2.5D parallax scene. It proposes foreground objects, refines their alpha, joins their masks, reconstructs the hidden background, and renders an adjustable virtual-camera preview.

The product contract is in [docs/SRS.md](docs/SRS.md), and the implementation design is in [docs/DESIGN.md](docs/DESIGN.md).

## Quick Start

On Windows, double-click `Run Stereovisor.cmd`. The first launch validates a local CUDA Python runtime and all local model weights before opening the editor. It builds the project-owned `.venv-ai` environment and reuses an already compatible CUDA Torch installation when available; otherwise it installs the pinned CUDA wheel. Later launches reuse the prepared environment.

For the lightweight sample-only preview, double-click `Run Stereovisor Preview.cmd`.

The equivalent command-line setup is:

```powershell
.\scripts\run-ai.ps1
```

The setup includes a resumable, SHA-256-verified Electron runtime download for unreliable connections.

Development starts with the explicitly labeled preview engine. Use the bundled sample scene to exercise the full workflow without downloading model weights.

## Project And Video Export

- `Project file` writes a portable `.stereovisor` package containing `manifest.json` and every processed source, mask, cutout, depth, union-mask, and background PNG.
- `Import project` loads that package into a fresh local workspace and restores camera and layer editing state.
- `Demo MP4` renders a four-second H.264 parallax preview at up to 1280 pixels for playback in standard system video players. It uses Electron's bundled Chromium encoder, so FFmpeg is not required; WebM remains a fallback on runtimes without MP4 recording support.
- `PNG` exports the current composited frame at source resolution.

Generated samples are available as [a reloadable project](docs/media/sample-project.stereovisor) and [its parallax WebM](docs/media/sample-parallax-demo.webm).

## Local AI Setup

The production stack is Grounding DINO-T, SAM 2.1 Small, InSPyReNet `base`, Depth Anything 3 Small, and Big LaMa. An explicit HQ option adds local Qwen3-VL 2B prompt generation and PowerPaint v2.1 refinement. GPU stages run sequentially, report peak allocation, and enforce an 8 GB VRAM budget. PowerPaint uses a separate dependency environment and CPU offload.

Inference options include segmentation density: `Sparse` keeps broad subject layers, `Balanced` proposes common scene props, and `Dense` lowers the proposal floor for smaller objects. `STEREOVISOR_OBJECT_LABELS` remains available for a custom comma-separated vocabulary when a specific subject set is needed.

When its validated checkpoint is installed, `PowerPaint - full redraw` is selected by default. It runs the complete diffusion schedule (the equivalent of denoise `1.00`) and discards original pixels throughout the expanded removal mask. `Big LaMa - structural fill` remains available as the faster non-diffusion option.

```powershell
.\scripts\setup-ai.ps1
$env:STEREOVISOR_MODE = "ai"
npm run dev
```

The first AI run installs both local runtimes, pins the DA3 and PowerPaint sources, and downloads model weights into `service/.models`. It is a large one-time download; later runs reuse it. Set `STEREOVISOR_SKIP_HQ=1` before the first run only if the optional Qwen3-VL/PowerPaint assets should be omitted.

The setup fails instead of silently installing CPU-only Torch when the CUDA wheel cannot be acquired. Preview mode remains available while the CUDA installation is retried.

Optional controls:

```powershell
$env:STEREOVISOR_DEVICE = "cuda" # or cpu / auto
$env:STEREOVISOR_MODE = "auto"   # ai / preview / auto
```

If a CUDA-capable Python already owns the local AI packages, select it without moving models into Electron:

```powershell
$env:STEREOVISOR_PYTHON = "python"
$env:STEREOVISOR_MODE = "ai"
$env:STEREOVISOR_DEVICE = "cuda"
npm run dev
```

## Localization

The React UI uses `i18next` and `react-i18next`. English, Simplified Chinese, Japanese, and Korean are authored together in `src/web/i18n/translations.csv`; `src/web/i18n/generated.ts` and `electron/nativeMessages.ts` are generated and must not be edited directly. Native menu/dialog rows use the `native.*` key prefix.

Keep the CSV UTF-8 with a BOM and CRLF line endings so it opens cleanly in spreadsheet tools. Every locale cell is required, and each translation must preserve the English interpolation placeholders. After editing it, run:

```powershell
npm run i18n:generate
npm run i18n:check
```

The app chooses a supported system language on first launch, persists the user's selector choice, falls back to English for unknown service diagnostics, and applies the selected locale to Electron's native file dialogs.

## Options and Settings

The header language selector is also available from `File > Options...` (`Ctrl+,`). Options are grouped into General, Appearance, Camera, and Advanced sections. The registered settings in `src/web/settings.ts` cover language, motion accessibility, camera defaults, automatic preview motion, the default background method, and local-worker polling.

Native menu and dialog labels are authored with the other locales in `src/web/i18n/translations.csv` under the `native.*` keys. The generator writes `electron/nativeMessages.ts`, so File, Edit, View, and Help commands follow the selected locale instead of the operating system menu language. `Help > About Stereovisor` opens the custom in-app About window with the current project version and a brief description.

Electron stores the normalized versioned configuration at the platform user-data location as `settings.json` (for example `%APPDATA%/stereovisor/settings.json` on Windows). Browser development uses `localStorage` with the same schema. Values are clamped to safe ranges before they are written, and Save/Cancel keeps pending edits separate from the active configuration.

## Verification

```powershell
npm run check
```

This runs TypeScript checks, renderer tests, Python service tests, and a production renderer/Electron build.
