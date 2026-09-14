# Stereovisor

Stereovisor is a local-first Electron studio that turns one image into a layered 2.5D parallax scene. It proposes foreground objects, refines their alpha, joins their masks, reconstructs the hidden background, and renders an adjustable virtual-camera preview.

The product contract is in [docs/SRS.md](docs/SRS.md), and the implementation design is in [docs/DESIGN.md](docs/DESIGN.md).

## Repository Layout

- `client/` owns the React renderer, Electron host, static assets, tests, build configuration, and client-only utilities.
- `service/` owns the Python API and pipeline source, service tests, requirements, model/runtime utilities, and local data caches.
- `scripts/` contains only launch, setup, and smoke-test orchestration that coordinates both sides.

## Quick Start

### Apple Silicon macOS

Install Node.js 22 and Python 3.12, then double-click `Run Stereovisor.command`.
The launcher replaces incompatible copied Windows environments and uses the
standard project directories `.venv`, `.venv-ai`, and `.venv-powerpaint`. It
installs the local PyTorch runtime, verifies the model cache, and starts the app
with Apple Metal (MPS) acceleration. PyTorch's CPU fallback is enabled for model
operations that MPS does not implement. PowerPaint remains available, but because
it requires CUDA for GPU acceleration it loads and runs on CPU on Apple Silicon;
the editor shows this performance warning. Use
`Run Stereovisor Preview.command` for the lightweight sample-only engine.

The same workflows are available from Terminal:

```bash
npm run setup
./scripts/run-ai.sh
./scripts/run-preview.sh
```

Only Apple Silicon (`arm64`) is supported. Intel and universal macOS builds are
intentionally excluded.

### Windows

On Windows, double-click `Run Stereovisor.cmd`. The first launch shows a dedicated preparation window instead of the editor while the local CUDA Python runtime and required model weights are installed. It lists all five startup items - local AI runtime, segmentation, matting, depth, and inpainting - and reports `Starting`, `Downloading`, `Initializing`, or `Ready` with per-item progress, including the one-time CUDA runtime installation. The editor appears only after the running local service confirms every required provider. Later launches distinguish a stopped service from a missing installation: they start the prepared offline service automatically, wait for its live readiness check, and then open the editor without running model preparation again. The launcher builds the project-owned `.venv-ai` environment, reuses compatible CUDA Torch assets, and otherwise installs the pinned CUDA wheel.

For the lightweight sample-only preview, double-click `Run Stereovisor Preview.cmd`.

To run an isolated launch smoke test without touching your saved projects or
settings, use `npm run smoke`. It uses the project-managed `.venv-ai` CUDA
runtime and existing model cache with temporary project and Electron user-data
folders. Use `npm run smoke -- -Preview` to exercise a completely empty model
folder and the locked first-launch screen; that mode also drives a bootstrap
status through the launcher helper and asserts the per-provider startup
progress the mask renders. Both modes clean their temporary workspace
automatically.

## Apple Silicon Packaging

Double-click `Build Stereovisor.command`, or run `npm run package`, on an Apple
Silicon Mac. The build downloads and checksum-verifies a pinned relocatable
Python 3.12 runtime into `.python-runtime`, installs the local service, AI, and
isolated PowerPaint dependencies into it, and creates:

- `release/Stereovisor-0.1.0-mac-arm64.dmg`
- `release/Stereovisor-0.1.0-mac-arm64.zip`

The package contains only arm64 Electron, Python, and native dependencies. Model
weights are still downloaded to the per-user application-data folder on first
launch. The local build uses an ad-hoc signature; notarization requires an Apple
Developer ID and is outside this repository's local build flow.

Validate the built app, archive structure, bundled service, and sample workflow
with:

```bash
npm run smoke:package:mac
```

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
- `Demo MP4` renders a four-second H.264 parallax preview at up to 1280 pixels for playback in standard system video players. The Motion speed, Horizontal amount, and Vertical amount options control its motion as well as the live motion preview. It uses Electron's bundled Chromium encoder, so FFmpeg is not required; WebM remains a fallback on runtimes without MP4 recording support.
- `PNG` exports the current composited frame at source resolution.

The final camera rig groups view, scene-depth, and lens controls. Depth of field derives background and foreground blur from the selected focus depth; each layer retains a signed blur offset for local artistic correction.

Generated samples are available as [a reloadable project](docs/media/sample-project.stereovisor) and [its parallax WebM](docs/media/sample-parallax-demo.webm).

## Segmentation Layer Editing

During mask review, clicking a layer selects it without changing its ON/OFF build state. Click additional layers to build a multi-selection, then use `Toggle selected` to invert their build state or `Merge selected` to union their masks into one editable foreground layer. A merge resets that layer to `Rough` and requires confirmation again. `Undo` and `Redo` restore the complete layer set and its mask assets; `Ctrl+Z` and `Ctrl+Y` also work when the selection toolbar is focused.

`Add layer` in the Build scene panel brushes a foreground layer the detector did not propose. Painting an area and choosing `Add layer` appends it to the layer list as a normal layer that is selected, unconfirmed, and part of the background rebuild like any other. `Apply + refine` optimizes a brushed mask instead: hand-painted layers are aligned to image edges with mask-guided segmentation rather than salient-subject matting, so an arbitrary region is refined without being replaced by the nearest object.

Refinement tightens a mask and never grows it: the painted area is the outer bound, and the region it may re-decide scales with the object rather than the canvas, so a boundary that is tens of pixels off still snaps onto real edges. Refining a detected layer is deliberately more conservative - it stays inside that layer's original detector proposal and keeps the stored mask whenever the matte looks unreliable, so repeated passes cannot drift onto a neighbouring subject.

Name a layer from the editable heading above the canvas, both while brushing a new one and whenever an existing layer's mask is reopened with `Edit`. Leaving a new name blank assigns the next `Area NN`. `Delete` on a layer card removes that layer and its mask, cutout, and proposal assets; deletion is recorded in the same reversible layer history as merging, so `Undo` restores it with its assets intact.

## Local AI Setup

The production stack is Grounding DINO-B, SAM 2.1 Small, InSPyReNet `base`, Depth Anything 3 Small, and Big LaMa. An explicit HQ option adds local Qwen3-VL 2B prompt generation and PowerPaint v2.1 refinement. GPU stages run sequentially, report peak allocation, and enforce an 8 GB VRAM budget. PowerPaint uses a separate dependency environment and CUDA CPU offload when CUDA is available; without CUDA it remains usable in CPU-only mode and the editor warns about the slower fallback.

Inference options include segmentation density: `Sparse` keeps broad subject layers, `Balanced` proposes common scene props, and `Dense` lowers the proposal floor for smaller objects. The Options dialog also accepts a custom comma-separated vocabulary; leaving it blank uses the selected density's built-in labels. An opt-in VLM vocabulary proposer can run Qwen3-VL before detection when the manual vocabulary is blank. It is disabled by default, and `STEREOVISOR_OBJECT_LABELS` remains available for headless runs.

When its validated checkpoint is installed, `PowerPaint - full redraw` is selected by default. It runs the complete diffusion schedule (the equivalent of denoise `1.00`) and discards original pixels throughout the expanded removal mask. `Big LaMa - structural fill` remains available as the faster non-diffusion option.

```powershell
.\service\scripts\setup-ai.ps1
$env:STEREOVISOR_MODE = "ai"
npm run dev
```

The first AI run installs both local runtimes, pins the DA3 and PowerPaint sources, and downloads model weights into `service/.models`. It is a large one-time download; later runs reuse it. Set `STEREOVISOR_SKIP_HQ=1` before the first run only if the optional Qwen3-VL/PowerPaint assets should be omitted.

The setup fails instead of silently installing CPU-only Torch when the CUDA wheel cannot be acquired. Preview mode remains available while the CUDA installation is retried.

The CUDA Torch and Torchvision wheels are downloaded into `.cache/wheels` before pip installs them, and an interrupted transfer resumes from the bytes already on disk on the next run. Set `STEREOVISOR_TORCH_WHEEL_BASE` to a mirror of the PyTorch `cu128` wheel directory when `download.pytorch.org` is slow; the pinned SHA-256 checksums still have to match.

Optional controls. Use `mps` on Apple Silicon and `cuda` on Windows:

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

## Service API

The renderer and the local Python service talk over one HTTP contract, and the
service runs on the same machine as the app by default. It listens on
`127.0.0.1:5772`.

Start only the server from the repository root with:

```powershell
npm run dev:service
```

That command defaults to the lightweight preview engine. To run a prepared AI
environment instead, select its Python and mode before starting it:

```powershell
$env:STEREOVISOR_PYTHON = (Resolve-Path ".venv-ai\Scripts\python.exe")
$env:STEREOVISOR_MODE = "ai"
$env:STEREOVISOR_DEVICE = "cuda"
npm run dev:service
```

Server and client configuration are independent. Both default to port `5772`,
so the shipped Electron app stays synchronized without configuration. In
`File > Options... > Advanced`, leave **Server address** blank to use the bundled
service at `http://127.0.0.1:5772`, or enter the full `http://host:port` origin of
an independently running server. An explicit address also prevents Electron
from starting its bundled service on the next launch.

To make a server reachable from the LAN, bind it to all interfaces and require
a strong shared token:

```powershell
$env:STEREOVISOR_SERVICE_HOST = "0.0.0.0"
$env:STEREOVISOR_SERVICE_PORT = "5772"
$env:STEREOVISOR_AUTH_TOKEN = "replace-with-a-long-random-secret"
npm run dev:service
```

Open inbound TCP port `5772` in the server machine's firewall, then set the
client's **Server address** to the server's LAN address, for example
`http://192.168.1.50:5772`, and set **Server access token** to the same secret.
If a browser renderer is served from an origin other than the defaults, add its
exact origin to the server's comma-separated `STEREOVISOR_ALLOWED_ORIGINS`.

All HTTP routes, including image assets, require `Authorization: Bearer ...`
when the server binds beyond loopback. The event socket carries the same secret
in a WebSocket subprotocol because browser WebSockets cannot set an
Authorization header. This is shared-workspace authentication, not user
isolation: every client with the token can access the server's projects. Plain
HTTP also exposes the token to anyone able to inspect LAN traffic, so use this
only on a trusted LAN or place the service behind a TLS reverse proxy. Do not
publish port `5772` directly to the internet.

Job progress and startup readiness arrive over a WebSocket at `/api/events`
instead of repeated polling. If the socket is unavailable the client falls back
to its original polling cadence, so behavior is unchanged either way.

Individual AI components are addressable through
`GET /api/capabilities` and the `POST /api/jobs/capabilities/<id>` routes -
segmentation, depth, matting, Big LaMa fill, and the two Qwen3-VL prompts. Every
inference request returns a job ID and shares the same observable FIFO queue,
including requests from multiple LAN clients. Read the result from
`GET /api/jobs/<jobId>` and cancel with `POST /api/jobs/<jobId>/cancel`. Run
the supported single-process launcher shown above; multiple Uvicorn workers do
not share the in-memory queue consumer. Run `npm run openapi` to write the full
schema to `openapi.json`.

## Localization

The React UI uses `i18next` and `react-i18next`. English, Japanese, Korean, and Simplified Chinese are authored together in `client/src/i18n/translations.csv`; `client/src/i18n/generated.ts` and `client/electron/nativeMessages.ts` are generated and must not be edited directly. Native menu/dialog rows use the `native.*` key prefix.

Keep the CSV UTF-8 with a BOM and CRLF line endings so it opens cleanly in spreadsheet tools. Every locale cell is required, and each translation must preserve the English interpolation placeholders. After editing it, run:

```powershell
npm run i18n:generate
npm run i18n:check
```

The app chooses a supported system language on first launch, persists the user's selector choice, falls back to English for unknown service diagnostics, and applies the selected locale to Electron's native file dialogs.

## Options and Settings

The header language selector is also available from `File > Options...` (`Ctrl+,`). Options are grouped into Appearance, Camera, Inference, and Advanced sections. The registered settings in `client/src/settings.ts` cover language, motion accessibility, camera defaults, automatic preview motion, inference behavior, local-worker polling, the client service address and token, and the optional local service console. The service console is hidden by default and can be enabled for the next launch from Advanced, or with `STEREOVISOR_SHOW_CONSOLE=1` when using `Run Stereovisor.cmd`. A visible service console remains running after the editor closes, and later launches reuse that compatible local server; close the console itself to stop it. With the option disabled, the hidden service remains owned by the app and stops when the app closes.

Native menu and dialog labels are authored with the other locales in `client/src/i18n/translations.csv` under the `native.*` keys. The generator writes `client/electron/nativeMessages.ts`, so File, Edit, View, and Help commands follow the selected locale instead of the operating system menu language. `Help > About Stereovisor` opens the custom in-app About window with the current project version and a brief description.

Electron stores the normalized versioned configuration at the platform user-data location as `settings.json` (for example `%APPDATA%/stereovisor/settings.json` on Windows). Browser development uses `localStorage` with the same schema. Values are clamped to safe ranges before they are written, and Save/Cancel keeps pending edits separate from the active configuration.

## Verification

```powershell
npm run check
```

This runs TypeScript checks, renderer tests, Python service tests, and a production renderer/Electron build.
