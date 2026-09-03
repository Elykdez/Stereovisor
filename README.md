# Stereovisor

Stereovisor is a local-first Electron studio that turns one image into a layered 2.5D parallax scene. It proposes foreground objects, refines their alpha, joins their masks, reconstructs the hidden background, and renders an adjustable virtual-camera preview.

The product contract is in [docs/SRS.md](docs/SRS.md), and the implementation design is in [docs/DESIGN.md](docs/DESIGN.md).

## Quick Start

On Windows, double-click `Run Stereovisor.cmd`. The window opens immediately and shows the real editor behind a blurred startup mask while the local CUDA Python runtime and the model weights are prepared. The mask lists all five startup items - local AI runtime, segmentation, matting, depth, and inpainting - and reports `Starting`, `Downloading`, `Initializing`, or `Ready` with per-item progress, including the one-time CUDA runtime installation. Editing stays disabled until the running local service confirms every required provider; a stage the first-run preparation has finished is shown as progress but never unlocks the editor on its own. `File > Options...` and `Help > About` stay available while the mask is up. The launcher builds the project-owned `.venv-ai` environment, reuses the CUDA Torch already installed inside it when that installation is compatible, and otherwise installs the pinned CUDA wheel. Later launches reuse the prepared environment.

For the lightweight sample-only preview, double-click `Run Stereovisor Preview.cmd`.

To run an isolated launch smoke test without touching your saved projects or
settings, use `npm run smoke`. It uses the project-managed `.venv-ai` CUDA
runtime and existing model cache with temporary project and Electron user-data
folders. Use `npm run smoke -- -Preview` to exercise a completely empty model
folder and the locked first-launch screen; that mode also drives a bootstrap
status through the launcher helper and asserts the per-provider startup
progress the mask renders. Both modes clean their temporary workspace
automatically.

## Windows Packaging

Double-click `Build Stereovisor.cmd` to create a Windows desktop distribution. It
runs the production build and then electron-builder, producing both:

- `release/Stereovisor-0.1.0-setup.exe` - a normal Windows installer with a desktop shortcut.
- `release/Stereovisor-0.1.0-portable.exe` - a self-contained portable executable.

The package includes Electron, the local service code, the prepared Python
environments, and the pinned vendor sources. The model weights in
`service/.models` are intentionally not copied into the installer because they
are more than 15 GB and are hardware-dependent. A packaged app stores new
projects and model downloads under the Windows per-user application-data folder;
an unpacked portable build placed under this repository can reuse the existing
`service/.models` cache. On the first packaged launch, the bundled local
bootstrap prepares the required core weights automatically; optional Qwen3-VL
and PowerPaint weights remain opt-in.

The normal installed shortcut is recommended for daily use. The portable
executable must unpack its bundled runtime on first launch, which can take
several minutes before the Electron window appears; do not terminate it during
that extraction. If a launch is force-quit during model preparation, the next
launch clears the stale preparation marker and resumes safely.

The package is unsigned, so Windows SmartScreen may show an initial warning.
This is expected for a locally built executable; signing can be added later with
a code-signing certificate.

The equivalent command-line setup is:

```powershell
.\scripts\run-ai.ps1
```

The setup includes resumable, SHA-256-verified downloads for the Electron runtime and the multi-gigabyte CUDA Torch wheels, so an unreliable connection resumes where it stopped instead of restarting from zero.

Development starts with the explicitly labeled preview engine. Use the bundled sample scene to exercise the full workflow without downloading model weights.

## Project And Video Export

- `Project file` writes a portable `.stereovisor` package containing `manifest.json` and every processed source, mask, cutout, depth, union-mask, and background PNG.
- `Import project` loads that package into a fresh local workspace and restores camera and layer editing state.
- `Demo MP4` renders a four-second H.264 parallax preview at up to 1280 pixels for playback in standard system video players. It uses Electron's bundled Chromium encoder, so FFmpeg is not required; WebM remains a fallback on runtimes without MP4 recording support.
- `PNG` exports the current composited frame at source resolution.

Generated samples are available as [a reloadable project](docs/media/sample-project.stereovisor) and [its parallax WebM](docs/media/sample-parallax-demo.webm).

## Segmentation Layer Editing

During mask review, clicking a layer selects it without changing its ON/OFF build state. Click additional layers to build a multi-selection, then use `Toggle selected` to invert their build state or `Merge selected` to union their masks into one editable foreground layer. A merge resets that layer to `Rough` and requires confirmation again. `Undo` and `Redo` restore the complete layer set and its mask assets; `Ctrl+Z` and `Ctrl+Y` also work when the selection toolbar is focused.

`Add layer` in the Build scene panel brushes a foreground layer the detector did not propose. Painting an area and choosing `Add layer` appends it to the layer list as a normal layer that is selected, unconfirmed, and part of the background rebuild like any other. `Apply + refine` optimizes a brushed mask instead: hand-painted layers are aligned to image edges with mask-guided segmentation rather than salient-subject matting, so an arbitrary region is refined without being replaced by the nearest object.

Refinement tightens a mask and never grows it: the painted area is the outer bound, and the region it may re-decide scales with the object rather than the canvas, so a boundary that is tens of pixels off still snaps onto real edges. Refining a detected layer is deliberately more conservative - it stays inside that layer's original detector proposal and keeps the stored mask whenever the matte looks unreliable, so repeated passes cannot drift onto a neighbouring subject.

Name a layer from the editable heading above the canvas, both while brushing a new one and whenever an existing layer's mask is reopened with `Edit`. Leaving a new name blank assigns the next `Area NN`. `Delete` on a layer card removes that layer and its mask, cutout, and proposal assets; deletion is recorded in the same reversible layer history as merging, so `Undo` restores it with its assets intact.

## Local AI Setup

The production stack is Grounding DINO-B, SAM 2.1 Small, InSPyReNet `base`, Depth Anything 3 Small, and Big LaMa. An explicit HQ option adds local Qwen3-VL 2B prompt generation and PowerPaint v2.1 refinement. GPU stages run sequentially, report peak allocation, and enforce an 8 GB VRAM budget. PowerPaint uses a separate dependency environment and CPU offload.

Inference options include segmentation density: `Sparse` keeps broad subject layers, `Balanced` proposes common scene props, and `Dense` lowers the proposal floor for smaller objects. The Options dialog also accepts a custom comma-separated vocabulary; leaving it blank uses the selected density's built-in labels. An opt-in VLM vocabulary proposer can run Qwen3-VL before detection when the manual vocabulary is blank. It is disabled by default, and `STEREOVISOR_OBJECT_LABELS` remains available for headless runs.

When its validated checkpoint is installed, `PowerPaint - full redraw` is selected by default. It runs the complete diffusion schedule (the equivalent of denoise `1.00`) and discards original pixels throughout the expanded removal mask. `Big LaMa - structural fill` remains available as the faster non-diffusion option.

```powershell
.\scripts\setup-ai.ps1
$env:STEREOVISOR_MODE = "ai"
npm run dev
```

The first AI run installs both local runtimes, pins the DA3 and PowerPaint sources, and downloads model weights into `service/.models`. It is a large one-time download; later runs reuse it. Set `STEREOVISOR_SKIP_HQ=1` before the first run only if the optional Qwen3-VL/PowerPaint assets should be omitted.

The setup fails instead of silently installing CPU-only Torch when the CUDA wheel cannot be acquired. Preview mode remains available while the CUDA installation is retried.

The CUDA Torch and Torchvision wheels are downloaded into `.cache/wheels` before pip installs them, and an interrupted transfer resumes from the bytes already on disk on the next run. Set `STEREOVISOR_TORCH_WHEEL_BASE` to a mirror of the PyTorch `cu128` wheel directory when `download.pytorch.org` is slow; the pinned SHA-256 checksums still have to match.

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

The React UI uses `i18next` and `react-i18next`. English, Japanese, Korean, and Simplified Chinese are authored together in `src/web/i18n/translations.csv`; `src/web/i18n/generated.ts` and `electron/nativeMessages.ts` are generated and must not be edited directly. Native menu/dialog rows use the `native.*` key prefix.

Keep the CSV UTF-8 with a BOM and CRLF line endings so it opens cleanly in spreadsheet tools. Every locale cell is required, and each translation must preserve the English interpolation placeholders. After editing it, run:

```powershell
npm run i18n:generate
npm run i18n:check
```

The app chooses a supported system language on first launch, persists the user's selector choice, falls back to English for unknown service diagnostics, and applies the selected locale to Electron's native file dialogs.

## Options and Settings

The header language selector is also available from `File > Options...` (`Ctrl+,`). Options are grouped into General, Appearance, Camera, and Advanced sections. The registered settings in `src/web/settings.ts` cover language, motion accessibility, camera defaults, automatic preview motion, the default background method, local-worker polling, and the optional local service console. The service console is hidden by default and can be enabled for the next launch from Advanced, or with `STEREOVISOR_SHOW_CONSOLE=1` when using `Run Stereovisor.cmd`.

Native menu and dialog labels are authored with the other locales in `src/web/i18n/translations.csv` under the `native.*` keys. The generator writes `electron/nativeMessages.ts`, so File, Edit, View, and Help commands follow the selected locale instead of the operating system menu language. `Help > About Stereovisor` opens the custom in-app About window with the current project version and a brief description.

Electron stores the normalized versioned configuration at the platform user-data location as `settings.json` (for example `%APPDATA%/stereovisor/settings.json` on Windows). Browser development uses `localStorage` with the same schema. Values are clamped to safe ranges before they are written, and Save/Cancel keeps pending edits separate from the active configuration.

## Verification

```powershell
npm run check
```

This runs TypeScript checks, renderer tests, Python service tests, and a production renderer/Electron build.
