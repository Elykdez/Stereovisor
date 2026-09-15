# Service Reference

The service is the half of Stereovisor that does the thinking: a local FastAPI
process that owns the project asset store, the model stack, and the inference
pipeline. It speaks one narrow HTTP contract to the renderer documented in
[`client/docs`](../../client/docs/README.md), which keeps native and model
packages out of Electron and avoids pushing large pixel buffers through IPC.

It has no cloud-provider adapter. The network is used only to acquire model
weights that are not already present.

See [`docs/DESIGN.md`](../../docs/DESIGN.md) for the cross-cutting design and
[`docs/SRS.md`](../../docs/SRS.md) for the requirements this implements.

## Layout

- `src/app.py` - FastAPI application and route definitions.
- `src/pipeline.py` - the analyze, build-scene, and refinement stages.
- `src/jobs.py` - durable job store backed by SQLite.
- `src/jobqueue.py` - the single FIFO worker in front of the GPU.
- `src/providers.py` - one function per addressable AI capability.
- `src/ai_models.py`, `src/depth.py`, `src/refinement.py` - model runners.
- `src/storage.py` - project directories, asset serving, package import/export.
- `src/compute.py`, `src/config.py`, `src/events.py`, `src/schemas.py` - device
  selection, configuration, the event channel, and typed payloads.
- `scripts/` - setup, model preparation, vendor pinning, the PowerPaint runner,
  OpenAPI export, and service launchers.
- `.models/`, `.projects/` - local model cache and project store. Neither is
  packaged into an installer.

## Running It

From the repository root:

```powershell
npm run dev:service
```

That defaults to the lightweight preview engine. To run a prepared AI
environment, select its Python and mode first:

```powershell
$env:STEREOVISOR_PYTHON = (Resolve-Path ".venv-ai\Scripts\python.exe")
$env:STEREOVISOR_MODE = "ai"
$env:STEREOVISOR_DEVICE = "cuda"
npm run dev:service
```

It listens on `127.0.0.1:5772` by default. Server and client configuration are
independent, and both default to port `5772`, so the shipped Electron app stays
synchronized with no configuration.

Run the supported single-process launcher. Multiple Uvicorn workers are not a
supported deployment, because each would own a separate in-memory queue consumer.

## Modes

| Mode | Behavior |
| --- | --- |
| `ai` | The production pipeline. Fails with installation guidance if dependencies are missing. |
| `preview` | Deterministic color-region proposals, hard alpha, blur synthesis. For onboarding, UI work, and tests. The UI always shows `Preview engine`. |
| `auto` | Production when every AI dependency is installed, otherwise preview with a reported reason. |

## Environment

| Variable | Purpose |
| --- | --- |
| `STEREOVISOR_MODE` | `ai`, `preview`, or `auto`. |
| `STEREOVISOR_DEVICE` | `cuda`, `mps`, `cpu`, or `auto`. |
| `STEREOVISOR_PYTHON` | Use an existing interpreter that already owns the AI packages. |
| `STEREOVISOR_SERVICE_HOST` | Bind address. Non-loopback requires an auth token. |
| `STEREOVISOR_SERVICE_PORT` | Listen port, default `5772`. |
| `STEREOVISOR_AUTH_TOKEN` | Shared bearer secret, required for any non-loopback bind. |
| `STEREOVISOR_ALLOWED_ORIGINS` | Comma-separated extra CORS origins for browser renderers. |
| `STEREOVISOR_OBJECT_LABELS` | Detection vocabulary for headless runs. |
| `STEREOVISOR_SKIP_HQ` | Omit the optional Qwen3-VL and PowerPaint assets on first setup. |
| `STEREOVISOR_TORCH_WHEEL_BASE` | Mirror of the PyTorch `cu128` wheel directory. Pinned SHA-256 checksums still must match. |
| `STEREOVISOR_SHOW_CONSOLE` | Show the service console window when launched from `Run Stereovisor.cmd`. |

## Model Stack

The production stack is Grounding DINO-B, SAM 2.1 Small, InSPyReNet `base`,
Depth Anything 3 Small, and Big LaMa. An explicit HQ option adds local Qwen3-VL
2B prompt generation and PowerPaint v2.1 refinement.

Every GPU provider is loaded for one stage and explicitly released before the
next, and the service lock prevents simultaneous jobs. CUDA stages record peak
allocation against an 8192 MB limit and fail explicitly above it. Apple Silicon
stages use MPS with PyTorch CPU fallback for unsupported operations. PowerPaint
runs in its own dependency environment with CUDA CPU offload where CUDA exists,
and CPU-only otherwise with a visible warning in the editor.

The order is:

```text
Qwen3-VL vocabulary (optional)
  -> Grounding DINO-B
  -> SAM 2.1 Small
  -> Depth Anything 3 Small
  -> InSPyReNet (per refinement)
  -> Qwen3-VL background prompt (optional)
  -> PowerPaint or Big LaMa
```

Segmentation density is a persisted setting: `Sparse` keeps broad subject layers,
`Balanced` proposes common scene props, and `Dense` lowers the proposal floor for
smaller objects. A custom comma-separated vocabulary overrides it; blank uses the
density's built-in labels. The opt-in VLM proposer runs before detection only
when the manual vocabulary is blank, and is released before Grounding DINO-B
loads.

When its validated checkpoint is installed, `PowerPaint - full redraw` is the
default. It runs the complete diffusion schedule from random latents, equivalent
to denoise strength 1.00, and discards original pixels throughout the expanded
removal mask. `Big LaMa - structural fill` remains the faster non-diffusion
option.

## Pipeline

### Analyze

1. Decode and normalize the source to RGB without changing dimensions.
2. Optionally run Qwen3-VL for a bounded label vocabulary, then release it.
3. Run Grounding DINO-B once and suppress duplicate boxes.
4. Prompt SAM 2.1 Small with all retained boxes in one batch.
5. Release both segmentation models.
6. Run Depth Anything 3 Small for relative ordering, then optionally extract one
   non-semantic near plane.
7. Save rough RGBA cutouts, grayscale masks, the depth map, labels, confidence,
   and per-stage VRAM peaks. Matting is deferred until refinement is requested.
8. On refinement, crop to the edited proposal AABB and run InSPyReNet `base`,
   intersect its soft alpha with the stable proposal, and keep the proposal if
   the salient matte collapses.
9. Keep the edited proposal as a separate `*-proposal-mask.png`. Later refines
   read that asset rather than the previous refined alpha, so repeated passes
   cannot drift onto an undesignated fragment.

Refinement snapshots live per layer under `.mask-history/<layer-key>`. A refine
pushes the current alpha and state to undo history, clears redo, and leaves the
proposal untouched. Undo and redo swap snapshots, regenerate the cutout, and
increment `maskRevision` so the renderer reloads the right pixels.

### Build scene

1. Load alpha masks for the selected layers.
2. Compute a per-pixel maximum union.
3. Dilate by a safety radius proportional to image size.
4. Feather only the inspection and export mask; keep a binary mask for LaMa.
5. In full-redraw mode, run Qwen3-VL only when no manual prompt exists, release
   it, then invoke PowerPaint in its isolated environment.
6. Start PowerPaint from random latents for the persisted step count, 25 by
   default, clamped to 5-100.
7. Composite generated pixels through a binary mask so no source pixel is blended
   back inside the removal region.
8. In fast mode, run Big LaMa against the original RGB and binary removal mask.
9. Save the background plate, provider, generated prompt, and stage metrics.
10. Release the inpainter and clear unused CUDA cache.

## HTTP API

### Workflow routes

- `GET /api/health` - service version, active mode, dependency and model readiness.
- `POST /api/jobs/analyze` - multipart source image; returns a job ID.
- `POST /api/jobs/projects/{id}/inpaint` - selected layer IDs, `lama` or
  `powerpaint` mode, optional prompt; returns a job ID.
- `GET /api/jobs/{id}` - authoritative state, and the typed result once complete.
- `POST /api/jobs/{id}/cancel` - cooperative cancellation; returns the cancelled state.
- `GET /api/projects/{id}/assets/{name}` - validated project asset delivery.
- `POST /api/projects/{id}/export` - camera and layer state in, `.stereovisor` out.
- `POST /api/projects/import` - `.stereovisor` in, restored project and camera out.

All errors use `{ "code": string, "message": string, "detail"?: string }`.

Source uploads accept PNG, JPEG, and WebP up to 40 MB. The declared content type
is only a pre-filter: a browser sends `application/octet-stream`, or nothing at
all, when the operating system has no mapping for an extension, so the format
Pillow actually decodes is the authority. An unsupported format returns 415
`UNSUPPORTED_IMAGE` whether or not it was labeled, and undecodable bytes return
422 `DECODE_FAILED`.

`npm run openapi` writes the full schema to `openapi.json` at the repository root.

### Capability routes

The workflow routes compose whole operations. These address one component each,
for callers that need a single stage:

- `GET /api/capabilities` - inventory of every component: model, gating provider,
  readiness, device, VRAM budget, accepted parameters.
- `POST /api/jobs/capabilities/segmentation:detect`
- `POST /api/jobs/capabilities/depth:estimate`
- `POST /api/jobs/capabilities/matting:refine`
- `POST /api/jobs/capabilities/inpainting:fill`
- `POST /api/jobs/capabilities/vlm:vocabulary`
- `POST /api/jobs/capabilities/vlm:caption`

Every route is a thin front for a function in `src/providers.py` calling the same
implementation the pipeline uses. A capability must never become a second copy of
a stage. Each POST returns `{ "jobId": "..." }`; `GET /api/jobs/{id}` carries the
typed result, with image output as base64 PNG.

PowerPaint appears in the inventory with `endpoint: null`. It stays reachable
through workflow jobs because a standalone request would still need a project and
prompt contract.

### Event channel

`GET /api/events` upgrades to a WebSocket that pushes state changes instead of
being polled. Frames carry `topic` (`job` or `health`) and a per-topic monotonic
`seq`. Three rules keep HTTP authoritative:

1. A job frame never carries `result`. On `state: "completed"` the client reads
   `GET /api/jobs/{id}`.
2. Clients read current state over HTTP, then subscribe. Frames older than the
   applied `seq` are discarded, so a dropped frame cannot strand the UI.
3. If the socket is unavailable, clients fall back to the original polling
   cadence. Degraded mode is exactly the pre-socket behavior.

Readiness has no natural push source, so one server-side watch recomputes health
once a second while at least one subscriber is connected, and broadcasts only on
change. CORS does not cover the WebSocket handshake, so the browser-sent `Origin`
is checked against the same allowlist.

## Job Queue

Jobs are durable. `src/jobs.py` keeps state in SQLite beside the projects it
produces, with results in a separate table so status polling never reads the
payload blob. A job survives a service restart, so a reconnecting renderer reads
a real terminal state instead of a 404.

`src/jobqueue.py` puts one FIFO worker in front of the local GPU, which is all
the hardware allows anyway. Making it explicit means a waiting job reports
`queuePosition` - how many jobs are ahead of it, mirrored into `message` - rather
than silently occupying a request thread inside the pipeline lock. Submitting is
cheap: `POST /api/jobs/...` enqueues and returns without waiting on inference.
Workflow and capability requests from every client share this queue. Cancelling a
queued job removes it immediately and recomputes the positions behind it.

Two consequences follow from durability:

- **Interrupted work fails honestly.** GPU work cannot resume, so anything left
  `queued` or `running` by a crash is marked failed on the next startup with an
  explanatory message, rather than appearing to run with no worker.
- **Finished work is swept.** Terminal jobs are evicted an hour after their last
  update, so a long-lived install does not accumulate results forever.

Splitting the API and worker into separate processes later means replacing the
in-process consumer with one that polls the same database. The queue boundary
does not move.

## Telemetry

Jobs carry the current model, compute device, loading/inference/cleanup phase,
and the latest GPU-memory snapshot, sourced from model activity including
PowerPaint's offload runner rather than the health endpoint's preferred device.
The durable job store supplies phase elapsed time and time since the last model
report; polling never invokes CUDA or claims new activity. Qwen reports generated
tokens and checks cancellation between tokens, and its text-description input is
limited to 1024 pixels on the longest edge while scene assets and masks keep
their original resolution.

The health response also exposes server-wide activity for the compact sidebar,
including work submitted by other clients and a worker finishing cancellation.
Health events speed up during work and return to an idle cadence when the queue
empties.

The service console emits timestamped `gpu.compute` JSON records at model, device,
and phase changes, on memory-pressure changes, and at most every ten seconds
during sustained activity. Records carry the job ID, process ID, model, device,
GPU name, device-wide used/free/total memory in MiB, and token or step counts.
Cleanup samples again after releasing in-process models; subprocess completion and
failure records identify memory retained from the last report. These are
GPU-memory snapshots, not utilization percentages or per-model allocations.
Missing telemetry stays null. No images, prompts, or model tensors are ever
included.

## Project Storage

Each project gets a unique directory beneath the application data directory
holding the source, masks, cutouts, background plate, and metadata. Only files
belonging to known project directories are served.

The `.stereovisor` extension identifies a ZIP container. Export converts asset
URLs to package-relative filenames, writes every processed PNG under `assets/`,
and records byte length plus SHA-256 in `manifest.json`. Import validates archive
size, entries, format version, references, checksums, and PNG decoding, then
assigns a fresh project ID, rewrites asset URLs, and atomically moves the
validated scene into the project store.

The manifest is the restoration contract; archive directory layout is never used
as implicit state.

## LAN Access

To reach the service from another machine, bind beyond loopback and require a
strong shared token:

```powershell
$env:STEREOVISOR_SERVICE_HOST = "0.0.0.0"
$env:STEREOVISOR_SERVICE_PORT = "5772"
$env:STEREOVISOR_AUTH_TOKEN = "replace-with-a-long-random-secret"
npm run dev:service
```

Open inbound TCP `5772` in the server's firewall, then set the client's **Server
address** in `File > Options... > Advanced` to the server's LAN address, for
example `http://192.168.1.50:5772`, and **Server access token** to the same
secret. An explicit address also prevents Electron from starting its bundled
service on the next launch. Add any non-default browser renderer origin to
`STEREOVISOR_ALLOWED_ORIGINS`.

A non-loopback bind is refused unless `STEREOVISOR_AUTH_TOKEN` is set. Every HTTP
route then requires `Authorization: Bearer ...`, including image assets. The event
socket carries the same secret in a WebSocket subprotocol, because browser
WebSockets cannot set an Authorization header.

This is shared-workspace authentication, not user isolation: every client holding
the token can reach every project on that server. Plain HTTP also exposes the
token to anyone inspecting LAN traffic. Use it only on a trusted LAN or behind a
TLS reverse proxy, and do not publish port `5772` to the internet.

## Failure Handling

| Condition | Behavior |
| --- | --- |
| Decode failure | Reject before creating a project. |
| Missing AI stack in `ai` mode | HTTP 503 with the exact bootstrap command. |
| Empty segmentation result | Keep the source and return an actionable error. |
| Individual matte rejection | Preserve the corresponding SAM instance mask. |
| Matting runtime failure | Abort the job; never mix hard preview masks into an AI result. |
| Inpaint failure | Retain analyzed layers and allow retry. |
| Cancellation | Mark cancelled immediately, poll at stage boundaries, kill a running PowerPaint subprocess, skip the final project write. |
| Missing asset | 404 without exposing filesystem paths. |

## AI Setup

```powershell
.\service\scripts\setup-ai.ps1
$env:STEREOVISOR_MODE = "ai"
npm run dev
```

The first AI run installs both local runtimes, pins the DA3 and PowerPaint
sources, and downloads weights into `service/.models`. It is a large one-time
download that later runs reuse. Set `STEREOVISOR_SKIP_HQ=1` before the first run
to omit the optional Qwen3-VL and PowerPaint assets.

Setup fails rather than silently installing CPU-only Torch when the CUDA wheel
cannot be acquired. Preview mode stays available while the CUDA install is
retried.

CUDA Torch and Torchvision wheels are downloaded into `.cache/wheels` before pip
installs them, and an interrupted transfer resumes from the bytes already on disk.
Set `STEREOVISOR_TORCH_WHEEL_BASE` to a mirror of the PyTorch `cu128` wheel
directory when `download.pytorch.org` is slow; the pinned SHA-256 checksums still
have to match.

If a CUDA-capable Python already owns the AI packages, select it without moving
models into Electron:

```powershell
$env:STEREOVISOR_PYTHON = "python"
$env:STEREOVISOR_MODE = "ai"
$env:STEREOVISOR_DEVICE = "cuda"
npm run dev
```

## Verification

```powershell
npm run test:service
```

## References

- [Grounding DINO in Transformers](https://huggingface.co/docs/transformers/model_doc/grounding-dino)
- [Grounding DINO-B checkpoint](https://huggingface.co/IDEA-Research/grounding-dino-base)
- [SAM 2 in Transformers](https://huggingface.co/docs/transformers/model_doc/sam2)
- [SAM 2.1 Small](https://huggingface.co/facebook/sam2.1-hiera-small)
- [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3)
- [InSPyReNet transparent-background](https://github.com/plemeri/transparent-background)
- [LaMa](https://github.com/advimman/lama)
- [Qwen3-VL 2B](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct)
- [PowerPaint](https://github.com/open-mmlab/PowerPaint)
