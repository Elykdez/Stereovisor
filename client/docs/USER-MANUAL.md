# Stereovisor User Manual

English | [简体中文](USER-MANUAL.zh-CN.md) | [한국어](USER-MANUAL.ko.md) | [日本語](USER-MANUAL.ja.md)

Stereovisor turns one photograph into a layered 2.5D scene you can move a camera
through. Everything runs on your own machine.

This manual describes the application as the user sees it. For implementation
detail see [`client/docs/README.md`](README.md) and
[`service/docs/README.md`](../../service/docs/README.md).

## 1. Install And First Launch

**Windows** - double-click `Run Stereovisor.cmd`, or install
`release/Stereovisor-<version>-setup.exe` and use the desktop shortcut.

**Apple Silicon macOS** - double-click `Run Stereovisor.command`, or open the
`.dmg` and drag the app to Applications.

**x64 Linux** - run `./Run\ Stereovisor.sh`, install the `.deb`, or mark the
AppImage executable and launch it.

The first launch shows the **Local AI startup** screen while the local AI runtime
is prepared and model weights are downloaded. Five providers report readiness:

| Provider | What it does |
| --- | --- |
| Local AI runtime | The Python environment the models run in |
| Segmentation models | Finds and cuts out the objects |
| Matting model | Tightens a cutout edge on request |
| Depth model | Orders the layers front to back |
| Inpainting model | Paints the background back in |

Each reports **Ready**, **Needs setup**, or **Unavailable**. The editor unlocks
when the required providers are ready. Keep the window open; the first download
can take several minutes and later launches go straight to the editor.

Just looking around? `Run Stereovisor Preview.cmd` / `.command` / `.sh` starts the
**Preview engine**, a sample-only mode that downloads no weights and does no AI
work. The header badge always says which engine is running: **Local AI** or
**Preview engine**.

On Windows the package ships Electron, the service code, and the setup scripts;
the Python runtime, AI libraries, and model weights are fetched on first launch.
No system Python, Git, or npm is required. Both Windows variants need an internet
connection and enough free disk space for that first setup, later launches reuse
what was downloaded, and an interrupted download resumes on the next launch.
Closing the app stops setup. The build is unsigned, so Windows SmartScreen may
warn on first run.

The macOS and Linux packages include their Python runtime and AI libraries;
model weights still download on first launch. Linux release builds use CPU
inference by default and warn that PowerPaint cannot use GPU when CUDA is absent.

## 2. The Window

- **Left rail** - **Source** (`Open image`, `Use sample scene`), the **Pipeline**
  status list, server and compute status, and the **Local only** notice.
- **Center stage** - the **Composition**. Drag the image to move the camera. The
  view switches between `Full composition`, `Background plate`, and
  `Original image`.
- **Right inspector** - the **Layer inspector**: `Proposals` while you review
  masks, `Scene stack` once the scene is built.
- **Top actions** - `Import project`, `Reset`, `Export`, `Demo`, `PNG`.

## 3. The Workflow

The **Pipeline** list tracks four stages.

1. **Import image** - click `Open image`, or drop a PNG, JPEG, or WebP up to
   40 MB onto the stage. `Use sample scene` loads the bundled example.
2. **Segment objects** - a detector proposes the subjects, a segmenter cuts each
   one out, and a depth model orders them. Progress and `Cancel processing`
   appear in the left rail.
3. **Refine + confirm** - review the proposed layers and confirm the ones that
   belong to the foreground.
4. **Build scene** - the confirmed cutouts are joined into one removal mask and
   the space behind them is painted back in.

The model's answer is a starting point, not a verdict. Every proposal can be
kept, dropped, merged, renamed, tightened, or replaced by one you paint yourself.

## 4. Reviewing And Editing Layers

Each row in `Proposals` carries an `ON`/`OFF` build state, the layer name, and a
state badge: `Rough`, `Refined`, `Confirmed`, or `Added layer`.

**Selecting.** Clicking a layer selects it without changing its build state.
Click more layers to build a multi-selection, then use `Toggle selected` to
invert their build state, `Merge selected` to union their masks into one layer,
or `Clear` to drop the selection. A merge resets the layer to `Rough` and has to
be confirmed again.

**Editing a mask.** `Edit` opens the mask brush over the canvas:

| Control | Purpose |
| --- | --- |
| `Add` / `Erase` | Brush mode |
| `Size` | Brush diameter |
| `Edge blur` | Softness of the painted edge |
| `Undo` / `Redo` | Step through brush history |
| `Reset` | Back to the stored mask |
| `Apply mask` | Save the painted mask as-is |
| `Apply + refine` | Save it and tighten it against real image edges |
| `Cancel` | Discard the edit |

`Refine` tightens a mask and never grows it. The painted area is the outer bound.
Refining a detected layer stays inside that layer's original proposal, so
repeated passes cannot drift onto a neighbouring subject.

**Adding a layer the detector missed.** `Add layer` in the build panel (or
`Add area`) puts you in brush mode. Paint the region and confirm: it is appended
as a normal layer, selected and unconfirmed, and joins the background rebuild
like any other.

**Naming.** Edit the heading above the canvas while brushing a new layer or
whenever an existing mask is reopened with `Edit`. A blank name becomes the next
`Area NN`.

**Deleting.** `Delete` removes a layer with its mask, cutout, and proposal
assets.

**History.** `Undo` and `Redo` restore the complete layer set and its mask
assets, including deletes and merges. `Ctrl+Z` and `Ctrl+Y` work while the
selection toolbar is focused.

**Confirming.** `Confirm N masks` locks the current selection as the foreground
and enables the background rebuild.

## 5. Building The Background Plate

`Build background plate` collects the confirmed cutouts, expands the combined
mask past the edge contamination, and paints the hidden background in.

**Local inpainter** - choose one:

| Option | Behavior |
| --- | --- |
| `Big LaMa - structural fill` | Fast, non-diffusion. Good for texture and structure. |
| `PowerPaint - advanced full redraw` | Full diffusion redraw at denoise 1.00. Original masked pixels are discarded. Requires the optional HQ weights. |

**Background prompt (optional)** - describe what should be behind the subjects.
Leave it blank to have the prompt generated automatically when the optional VLM
is installed.

`Rebuild background` runs the fill. `Rebuild hidden background` uses the
confirmed object masks plus an optional extra hole mask, which you paint with
`Add hole mask` / `Edit hole mask` and then fill with `Inpaint holes`.

**Layer inpaint** repaints inside a single cutout rather than the background.
Pick the focused layer, brush the area, optionally give an `Inpaint prompt`, and
run `Inpaint layer`. `Move anchor` and `Reset anchor` reposition a layer within
the scene.

Inpainting steps default to 25 and can be set between 5 and 100 in Options.
More steps means slower and usually cleaner.

## 6. The Camera

The **Parallax rig** groups the controls. Camera motion never invokes a model, so
it stays interactive.

**View**

| Control | Range |
| --- | --- |
| `Horizontal` | -1.00 to 1.00 |
| `Vertical` | -1.00 to 1.00 |
| `Zoom` | 1.00x to 1.35x |

**Scene depth**

| Control | Range |
| --- | --- |
| `Strength` | 0 to 100% parallax travel |
| `Center layers` | 0 to 100% pull toward the center |
| `Scene scale` | 0.50x to 2.00x |

**Lens focus**

| Control | Range |
| --- | --- |
| `Depth of field` | 0.0 to 24.0 px of blur |
| `Focus depth` | 0 to 100%, the plane that stays sharp |

`Preview motion` plays the automatic move, `Stop motion` ends it, and `Reset`
returns the rig to its defaults. You can also drag the image on the stage
directly.

**Inverse depth** in the layer panel flips the relationship: near layers move
less, distant layers and the background move more. It is saved with the project
and applies to the exported video.

**Per layer**, the inspector exposes `Depth`, `Scale`, `Feather`, and a signed
`Blur` offset shown as `auto + offset = final` pixels, so one layer can be
corrected without touching the rest.

## 7. Exporting

| Action | Result |
| --- | --- |
| `PNG` | The current composited frame at source resolution |
| `Demo` | Four seconds of parallax, H.264 MP4 up to 1280 px on the longest edge. WebM is the fallback where MP4 recording is unavailable. |
| `Export` | A portable `.stereovisor` package holding every processed asset plus the exact editor state, up to 512 MB |
| `Import project` | Loads a package into a fresh workspace and restores camera and layer state |

`Motion speed`, `Horizontal amount`, and `Vertical amount` in Options drive both
the exported demo and the live motion preview.

## 8. Options

`File > Options...` (`Ctrl+,`). The language selector is also in the header.

**Appearance** - `Reduce motion` and `Reduce graphic effects` disable the job
overlay and automatic movement. The operating system's reduced-motion preference
is respected as well.

**Camera** - `Default zoom`, `Default strength`, `Motion speed`,
`Horizontal amount`, `Vertical amount`.

**Inference**

| Setting | Effect |
| --- | --- |
| `Segmentation density` | `Sparse` keeps broad subjects, `Balanced` adds common scene props, `Dense` proposes smaller objects |
| `Object vocabulary` | A comma-separated label list. Any entry overrides the density's built-in labels. |
| `Use VLM vocabulary proposer` | Lets a local vision-language model suggest the label list. Runs only when the vocabulary is blank. |
| `Default background method` | Which inpainter is preselected |
| `Inpainting steps` | Diffusion steps, default 25, range 5 to 100 |

**Advanced** - `Server address`, `Server access token`, `Show service console`,
`Job polling interval`.

The service console is hidden by default. Enabled from Advanced, it appears on
the next launch, keeps running after the editor closes, and is reused by later
launches; close the console itself to stop it. With the option off, the hidden
service is owned by the app and stops with it.

`Save` applies the pending edits; `Cancel` discards them.

## 9. Menus And Shortcuts

The native menu follows the language selected in the app, not the operating
system menu language.

| Menu | Entries |
| --- | --- |
| `File` | `Options...`, `Exit` |
| `Edit` | `Undo`, `Redo`, `Cut`, `Copy`, `Paste`, `Select All` |
| `View` | `Reload`, `Force Reload`, `Toggle Developer Tools`, `Reset Zoom`, `Zoom In`, `Zoom Out`, `Toggle Full Screen` |
| `Help` | `About Stereovisor` |

| Shortcut | Action |
| --- | --- |
| `Ctrl+,` | Open Options |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo the layer set, while the selection toolbar is focused |

## 10. Using A Service On Another Machine

Stereovisor normally starts its own local service. To use one running elsewhere,
set `Server address` in `File > Options... > Advanced` to that machine's address,
for example `http://192.168.1.50:5772`, and `Server access token` to the secret
that server was started with. An explicit address also stops the app from
starting its own bundled service on the next launch.

Anyone holding the token can reach every project on that server, and plain HTTP
exposes the token to anyone inspecting the traffic. Use it only on a trusted
network.

## 11. Troubleshooting

| Symptom | What to do |
| --- | --- |
| "The local AI stack is not installed" | Run `service/scripts/setup-ai.ps1`, then restart Stereovisor |
| The editor stays locked on the startup screen | One provider is still `Needs setup` or `Unavailable`. Leave the window open during the first download. |
| The image is rejected | Use PNG, JPEG, or WebP at 40 MB or less |
| Export reports the project is too large | Project packages are limited to 512 MB |
| The demo exports as WebM instead of MP4 | The runtime has no MP4 recorder; WebM is the intended fallback |
| A job was still running when the app was closed | The editor restores the running job's progress and `Cancel` on the next launch. Reloading never cancels server-owned work. |
| The first launch takes a long time before the editor opens | On Windows the runtime and model weights are downloaded then. Leave it open; an interrupted download resumes on the next launch. |
| Windows SmartScreen warns on first run | Expected for a locally built, unsigned executable |
| The processing effects are distracting | Turn on `Reduce graphic effects`, or `Reduce motion` |
| A refine made the mask worse | `Undo` restores the previous alpha. Refinement reads the original proposal, so a second pass does not compound the first. |

## 12. Privacy

Source images and generated assets stay on your machine. The service has no
cloud-provider adapter; the network is used only to acquire model weights that
are not already present. The **Local only** notice in the left rail reflects
this, and preview processing is never presented as AI processing.
