# Client Reference

The client is the half of Stereovisor the user touches: a React renderer inside
an Electron host. It owns workflow state, the layer list, the Canvas 2D
compositor, camera controls, export, and project load/save. It owns no model
code and no native inference dependency; everything AI-shaped is a request to
the local service documented in [`service/docs`](../../service/docs/README.md).

See [`docs/DESIGN.md`](../../docs/DESIGN.md) for the cross-cutting design and
[`docs/SRS.md`](../../docs/SRS.md) for the requirements this implements.

## Layout

- `src/App.tsx` - workflow state machine and top-level composition.
- `src/components/` - stage canvas, layer inspector, mask editor overlay, camera
  controls, settings and about dialogs, server status, startup gate.
- `src/lib/` - service client, event socket, compositor helpers, parallax math,
  mask mosaic and inpaint-focus effects, WebGL shader loaders, startup.
- `src/lib/shaders/` - GLSL for the mask mosaic, inpaint focus, and foreground
  job effects.
- `src/i18n/` - localization source CSV and generated bundle.
- `src/settings.ts` - the registered settings schema and clamping.
- `electron/` - main process, preload bridge, service lifecycle, native menus.
- `public/`, `index.html`, `vite.config.mts`, `tsconfig*.json` - assets and build.

## Development

```powershell
npm run dev            # service + renderer + Electron
npm run dev:app        # renderer + Electron against an already-running service
npm run dev:renderer   # Vite only, on 127.0.0.1:5173
```

`npm run dev` starts the lightweight preview engine by default. To develop
against a prepared AI environment, select its Python and mode before launching:
see the service documentation.

## Renderer Design

The interface holds three stable zones plus a top action bar.

- **Left rail** - upload or sample action, and workflow status.
- **Center stage** - the composited image, direct camera dragging, and a compact
  camera toolbar.
- **Right inspector** - foreground selection during analysis, then visibility and
  depth controls in the editor.
- **Top actions** - load a project at any time; export the portable project
  whenever a scene exists; export PNG and MP4 once the background is built.

The visual language is a dark graphite workspace with warm ivory text and a
restrained acid-lime accent, so the image stays dominant and the app does not
read as a generic dashboard. Dense controls use a monospace label style while
titles stay editorial.

## Compositor And Camera

The render loop is deliberately cheap, because camera motion must never invoke
inference.

1. Preload the source or background plate and every cutout once.
2. Render the background with overscan so small camera moves cannot reveal empty
   canvas.
3. Sort visible layers far to near.
4. Translate each layer by `cameraOffset * parallaxStrength * depth`.
5. Apply zoom about the canvas center.
6. Derive depth-of-field blur from each layer's distance to the focus plane, then
   add that layer's signed blur correction without rewriting layer state.
7. Render continuously only while an image is loading, the pointer is moving, or
   motion preview is active.

The camera rig groups view, scene-depth, and lens controls. Depth of field
derives background and foreground blur from the selected focus depth; each layer
keeps a signed blur offset for local artistic correction.

An opt-in **Inverse depth** toggle appears in the layer panel during both mask
review and editing. It is saved with the project camera and survives the build.
It uses `1 - depth` for parallax travel and depth-driven zoom, including the
background plate, with extra overscan for the larger travel. Layer stacking,
focus, and stored layer depths keep their original meaning; mask editing, source
review at rest, and inpainting stay camera-neutral.

### Job effects

While an inpaint job runs, a background progress mosaic sits beneath the
foreground cutouts, and a WebGL2 shader briefly flickers across each rendered
foreground layer with RGB-separated echoes, cyan and magenta rims, torn scan
bands, pixelated fragments, and short dark dropouts. Between bursts the
foreground is untouched. Reduced effects, reduced motion (including the OS
preference), and unavailable WebGL all disable the overlay. Textures are cached
for the active job and released when the effect stops. Exported frames and model
input always use the plain compositor.

## Segmentation Layer Editing

During mask review, clicking a layer selects it without changing its ON/OFF build
state. Click more layers to build a multi-selection, then `Toggle selected` to
invert their build state or `Merge selected` to union their masks into one
editable foreground layer. A merge resets that layer to `Rough` and requires
confirmation again. `Undo` and `Redo` restore the complete layer set and its mask
assets; `Ctrl+Z` and `Ctrl+Y` work when the selection toolbar is focused.

`Add layer` in the Build scene panel brushes in a foreground layer the detector
never proposed. Painting an area and choosing `Add layer` appends it as a normal
layer: selected, unconfirmed, and part of the background rebuild like any other.
`Apply + refine` optimizes a brushed mask instead. Hand-painted layers are
aligned to image edges with mask-guided segmentation rather than salient-subject
matting, so an arbitrary region is refined instead of being replaced by the
nearest object.

Refinement tightens a mask and never grows it. The painted area is the outer
bound, and the region it may re-decide scales with the object rather than the
canvas, so a boundary tens of pixels off still snaps onto real edges. Refining a
detected layer is deliberately more conservative: it stays inside that layer's
original detector proposal and keeps the stored mask whenever the matte looks
unreliable, so repeated passes cannot drift onto a neighbouring subject.

Name a layer from the editable heading above the canvas, both while brushing a
new one and whenever an existing mask is reopened with `Edit`. A blank name gets
the next `Area NN`. `Delete` removes a layer with its mask, cutout, and proposal
assets, recorded in the same reversible history as merging, so `Undo` restores it
with assets intact.

## Export

- **PNG** - the current composited frame at source resolution. Alpha is
  preserved only where the composition itself is transparent.
- **Demo MP4** - four seconds of H.264 parallax at up to 1280 pixels on the
  longest edge, rendered from the same cached layers to a capped canvas and
  encoded with Chromium MediaRecorder. WebM is the fallback on runtimes without
  MP4 recording. Motion speed, Horizontal amount, and Vertical amount drive both
  this and the live motion preview.
- **Project file** - a portable `.stereovisor` package containing
  `manifest.json` and every processed source, mask, cutout, depth, union-mask,
  and background PNG.
- **Import project** - loads a package into a fresh local workspace and restores
  camera and layer editing state.

Electron uses native save dialogs; browser development falls back to downloads.

## Job Recovery

The editor persists its active job ID, workflow kind, and project snapshot per
service origin. After a reload or reopen it restores the running job's progress
and Cancel control before allowing new submissions, and collects work that
finished while the window was closed. Completion and cancellation clear the
recovery record. Reloading never cancels server-owned work.

Job progress and startup readiness arrive over the service WebSocket rather than
by polling. If the socket is unavailable the client falls back to its original
polling cadence, so behavior is unchanged either way.

## Localization

The UI uses `i18next` and `react-i18next`. English, Japanese, Korean, and
Simplified Chinese are authored together in `src/i18n/translations.csv`.
`src/i18n/generated.ts` and `electron/nativeMessages.ts` are generated and must
not be edited directly. Native menu and dialog rows use the `native.*` key
prefix, so File, Edit, View, and Help follow the selected locale instead of the
OS menu language.

Keep the CSV UTF-8 with a BOM and CRLF line endings so it opens cleanly in
spreadsheet tools. Every locale cell is required, and each translation must
preserve the English interpolation placeholders. After editing:

```powershell
npm run i18n:generate
npm run i18n:check
```

The app picks a supported system language on first launch, persists the user's
selector choice, falls back to English for unknown service diagnostics, and
applies the selected locale to Electron's native file dialogs.

### User manual

The end-user manual is maintained alongside the UI in the same four languages.
It is prose, not generated output, so `npm run i18n:check` does not cover it:
when a user-visible label changes, update the manual in every language by hand.

| Language | Manual |
| --- | --- |
| English | [`USER-MANUAL.md`](USER-MANUAL.md) |
| Japanese | [`USER-MANUAL.ja.md`](USER-MANUAL.ja.md) |
| Korean | [`USER-MANUAL.ko.md`](USER-MANUAL.ko.md) |
| Simplified Chinese | [`USER-MANUAL.zh-CN.md`](USER-MANUAL.zh-CN.md) |

Each manual quotes the UI labels as that locale renders them, so the strings in
a manual must match the corresponding column of `src/i18n/translations.csv`.

## Options And Settings

The header language selector is also in `File > Options...` (`Ctrl+,`), grouped
into Appearance, Camera, Inference, and Advanced. The registered settings in
`src/settings.ts` cover language, motion accessibility, camera defaults,
automatic preview motion, inference behavior, local-worker polling, the client
service address and token, and the optional local service console.

The service console is hidden by default. Enable it for the next launch from
Advanced, or set `STEREOVISOR_SHOW_CONSOLE=1` when using `Run Stereovisor.cmd`.
A visible console keeps running after the editor closes and later launches reuse
that compatible local server; close the console itself to stop it. With the
option disabled the hidden service is owned by the app and stops with it.

`Help > About Stereovisor` opens the in-app About window with the current
project version.

Electron stores the normalized versioned configuration at the platform user-data
location as `settings.json`, for example `%APPDATA%/stereovisor/settings.json` on
Windows. Browser development uses `localStorage` with the same schema. Values are
clamped to safe ranges before they are written, and Save/Cancel keeps pending
edits separate from the active configuration.

## Security Posture

Context isolation and sandboxing are enabled, renderer Node integration is
disabled, and the preload bridge exposes only narrow typed save-dialog methods.

## Packaging

### Windows

Double-click `Build Stereovisor.cmd`, which runs the production build and
electron-builder to produce both:

- `release/Stereovisor-1.0.0-setup.exe` - installer with a desktop shortcut.
- `release/Stereovisor-1.0.0-portable.exe` - portable executable.

The Windows package includes Electron, the local service code, and setup scripts.
Python environments, AI libraries, vendor sources, and model weights are fetched
on first launch. Python comes from the pinned official NuGet package; dependencies
come from Python/PyTorch package servers and pinned vendor source archives.
No system Python, Git, or npm installation is required. The preparation screen
reports progress before the local service starts, and closing the app stops setup.

The runtime is installed under the Windows per-user application-data folder in
`runtime/`; projects and downloaded models are stored there separately. An
unpacked build placed inside this repository can reuse `service/.models`.
Required core weights are prepared automatically; Qwen3-VL and PowerPaint model
weights stay opt-in.

Prefer the installed shortcut for daily use. Both Windows variants need an
internet connection and sufficient disk space for the first setup. Later launches
reuse the downloaded runtime. Interrupted downloads resume on the next launch.

Windows executable resources include the Stereovisor icon and metadata, and the
application runs at the current user's privilege level. Set `WIN_CSC_LINK` to a
trusted code-signing certificate and `WIN_CSC_KEY_PASSWORD` to its password when
packaging to sign the executable and installers. The CI release job uses the same
names as repository secrets and verifies the resulting signatures when they are
configured. Unsigned local builds can still trigger Windows SmartScreen.

### Apple Silicon

Double-click `Build Stereovisor.command`, or run `npm run package`, on an Apple
Silicon Mac. The build downloads and checksum-verifies a pinned relocatable
Python 3.12 runtime into `.python-runtime`, installs the service, AI, and
isolated PowerPaint dependencies into it, and creates:

- `release/Stereovisor-<version>-mac-arm64.dmg`
- `release/Stereovisor-<version>-mac-arm64.zip`

Only arm64 Electron, Python, and native dependencies are included; Intel and
universal builds are intentionally excluded. Model weights still download to the
per-user application-data folder on first launch. The local build uses an ad-hoc
signature; notarization needs an Apple Developer ID and is outside this
repository's local flow.

Validate the built app, archive structure, bundled service, and sample workflow:

```bash
npm run smoke:package:mac
```

### Linux

Run `./Build\ Stereovisor.sh` or `npm run package` on x64 Linux. The build
checksum-verifies a pinned relocatable Python 3.12 runtime, installs CPU PyTorch
and the isolated PowerPaint dependencies, and creates:

- `release/Stereovisor-<version>-linux-x64.AppImage`
- `release/Stereovisor-<version>-linux-x64.deb`

The AppImage is portable after `chmod +x`; the deb integrates with Debian and
Ubuntu desktops. Model weights download to the per-user application-data folder
on first launch. Linux inference uses CPU by default. Source builds can select a
compatible PyTorch CUDA wheel index with `STEREOVISOR_TORCH_INDEX_URL` before
running setup.

Validate both archives, the bundled Python/PowerPaint runtime, Electron, the
local service, and the sample workflow under an X server:

```bash
xvfb-run -a npm run smoke:package:linux
```

## Smoke Tests

`npm run smoke` runs an isolated platform-native launch smoke test using
temporary project, model, and Electron user-data folders so saved projects and
settings are untouched.

`npm run smoke -- -Preview` exercises a completely empty model folder and the
locked first-launch screen, drives a bootstrap status through the launcher
helper, and asserts the per-provider startup progress the mask renders.

Both modes clean their temporary workspace automatically.

## Verification

```powershell
npm test -- --run      # renderer unit tests
npm run typecheck      # both tsconfig projects
npm run i18n:check     # generated locales match the CSV
npm run build          # production renderer and Electron build
```
