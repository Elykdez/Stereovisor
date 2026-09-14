# Stereovisor Design Plan

## 1. System Shape

Stereovisor uses two local processes with a narrow HTTP contract.

```text
Electron main process
  - window lifecycle
  - starts/stops Python service
  - native save/open dialogs
            |
            v
React renderer  <---- HTTP/JSON ---->  FastAPI vision service
  - workflow state                    - project asset store
  - layer list                        - Grounded instance proposals
  - Canvas 2D compositor              - DINO-B + SAM 2.1 instances
  - camera controls                   - InSPyReNet + DA3 layers
  - PNG/MP4 export                    - LaMa / Qwen + PowerPaint
  - project load/export               - validated package import/export
```

This boundary keeps native/model packages outside the renderer, allows the service to be tested independently, and avoids serializing large pixel buffers through Electron IPC.

The service has no cloud-provider adapter. Network access is used only to acquire model weights when they are not already present.

## 2. Processing Pipeline

### Analyze

1. Decode and normalize the source into RGB without changing dimensions.
2. If the VLM proposer is enabled and the manual vocabulary is blank, run Qwen3-VL to propose object labels, convert its output to a bounded vocabulary, and release it. Otherwise skip the VLM stage entirely.
3. Run Grounding DINO-B once with the manual, VLM-proposed, or density-profile vocabulary and suppress duplicate boxes.
4. Prompt SAM 2.1 Small with all retained boxes in one batch.
5. Release both segmentation models before starting depth estimation.
6. Run Depth Anything 3 Small for relative layer ordering, then optionally extract one non-semantic near plane.
7. Save rough RGBA cutouts, grayscale masks, the depth map, labels, confidence, and per-stage VRAM peaks. Matting is deferred until the user requests refinement.
8. On refinement, crop the original image to the edited proposal AABB and run InSPyReNet `base`; intersect its soft alpha with the stable proposal and retain that proposal if the salient matte collapses.
9. Keep the edited proposal in a separate `*-proposal-mask.png` asset. A later refine reads this asset instead of the previous refined alpha, so repeated passes cannot drift to an undesignated fragment.

Refinement snapshots are stored per layer under `.mask-history/<layer-key>`. A refine pushes the current alpha and state to undo history, clears redo history, and leaves the proposal asset unchanged. Undo/redo swaps snapshots, regenerates the cutout, and increments `maskRevision` so the renderer reloads the correct pixels.

Every GPU provider is loaded for one stage and explicitly released before the next. The service lock prevents simultaneous jobs, and every stage records peak CUDA allocation against the 8192 MB limit. The sequence is Qwen3-VL vocabulary proposal (optional) -> Grounding DINO-B -> SAM 2.1 -> DA3 -> InSPyReNet (per refinement) -> Qwen3-VL background prompt (optional) -> PowerPaint or Big LaMa.

Jobs also carry the current model, compute device, loading/inference/cleanup phase,
and the latest available GPU-memory snapshot. This comes from model activity,
including PowerPaint's CPU/GPU offload runner, rather than the health endpoint's
preferred device. The durable job store supplies phase elapsed time and time
since the last model report; polling never invokes CUDA or claims new activity.
Qwen reports generated tokens and checks cancellation between tokens. Its text
description input is limited to 1024 pixels on the longest edge; scene assets
and masks retain their original resolution. The UI shows measured activity and
memory pressure without inventing a completion estimate or CPU fallback.
The health response also exposes server-wide activity for the compact sidebar,
including work submitted by other clients and a worker finishing cancellation.
Health events update more frequently during work and return to their idle cadence
when the queue is empty. The sidebar keeps its two-line status and distinguishes
local/remote connection, server readiness/activity, and CPU/GPU availability or
compute mode. The latest reported GPU name, memory use, and memory warning appear
below that status during work. The job banner keeps its stage description and
progress bar without a second model-detail readout.

The service console emits timestamped `gpu.compute` JSON records at model/device
and phase changes, on memory-pressure changes, and at most every ten seconds
during repeated activity. Records include the job ID, process ID, model, device,
GPU name, device-wide used/free/total memory in MiB, and reported token/step counts.
Cleanup samples again after releasing in-process models; subprocess completion
and failure records explicitly identify memory retained from the last report.
These are GPU-memory snapshots, not GPU utilization percentages or per-model
allocations. Missing telemetry stays null. Cancellation and failure preserve
the last work phase, and service INFO logs are enabled without verbose dependency
logging. No images, prompts, or model tensors are included in these records.

### Build Scene

1. Load alpha masks for user-selected layers.
2. Compute a per-pixel maximum union.
3. Dilate the union by a user-independent safety radius proportional to image size.
4. Feather only the inspection/export mask; keep a binary mask for LaMa.
5. In full-redraw mode, run Qwen3-VL only when a manual prompt is absent, release it, then invoke PowerPaint in its isolated CPU-offload environment.
6. Start PowerPaint from random latents for the persisted Inference step count (25 by default), equivalent to denoise strength 1.0.
7. Composite generated pixels with a binary mask so no source pixel is blended back inside the removal region.
8. In fast structural-fill mode, run Big LaMa against the original RGB image and binary removal mask.
9. Save the background plate, selected provider, generated prompt, and stage metrics.
10. Release the inpainter and clear unused CUDA cache after the stage completes.

### Render

While an inpaint job runs, the background progress mosaic stays beneath the
foreground cutouts. A separate WebGL2 shader briefly flickers on each rendered
foreground layer, combining RGB-separated echoes, cyan/magenta rims, torn scan
bands, pixelated fragments, and short dark dropouts. Between these staggered
bursts the foreground is untouched. It uses the same layer transforms and clock.
Reduced effects, reduced motion (including the OS preference), and unavailable
WebGL disable the foreground overlay. Its textures are cached for the active
job and released when the effect stops. Exported frames and model input use
the compositor without the job effects.

The layer-panel explanation in both Steps 3 and 4 includes an opt-in Inverse
depth toggle, saved with the project camera and preserved through the build.
It applies during review dragging while keeping the source aligned at rest.
It uses `1 - depth` for parallax travel and depth-driven zoom,
including the background plate, with additional overscan for its larger travel.
Layer stacking, depth-of-field focus, and stored layer depths keep their original
meaning. Mask editing, source review at rest, and inpainting stay camera-neutral.

1. Preload source/background and cutout images once.
2. Render the background with overscan.
3. Sort visible layers from far to near.
4. Translate each layer by `cameraOffset * parallaxStrength * depth`.
5. Apply zoom around the canvas center.
6. Derive depth-of-field blur from each layer's distance to the camera focus plane, then add the layer's signed blur correction without rewriting layer state.
7. Render continuously only while an image is loading, the pointer is moving, or motion preview is active.
8. For demo export, render the same cached layers to a capped 1280-pixel canvas and encode four seconds of camera motion with Chromium MediaRecorder.

### Portable Project

1. Send current camera and editable layer state to the local service.
2. Convert project asset URLs to package-relative filenames.
3. Write every processed PNG under `assets/` and record byte length plus SHA-256 in `manifest.json`.
4. On load, validate archive size, entries, format version, references, checksums, and PNG decoding.
5. Assign a fresh project ID, rewrite asset URLs, and atomically move the validated scene into the project store.

The `.stereovisor` extension identifies a ZIP container. The manifest is the restoration contract; archive directory layout is not used as implicit state.

## 3. Data Contract

```ts
type Project = {
  id: string;
  width: number;
  height: number;
  sourceUrl: string;
  backgroundUrl: string | null;
  unionMaskUrl: string | null;
  depthMapUrl: string | null;
  backgroundPrompt: string | null;
  inpaintProvider: "preview" | "big-lama" | "powerpaint" | null;
  vramPeaksMb: Record<string, number>;
  engine: "ai" | "preview";
  layers: Array<{
    id: string;
    name: string;
    cutoutUrl: string;
    maskUrl: string;
    depth: number;
    order: number;
    selected: boolean;
    visible: boolean;
    bounds: [number, number, number, number];
    kind: "instance" | "depth-plane";
    confidence: number;
  }>;
};
```

The renderer stores camera/editor state. The service manifest stores generated asset identity and the initial layer estimates.

Portable manifests store both sets of state so a load operation restores the exact editable composition rather than only the backend's initial estimates.

## 4. API

- `GET /api/health`: service version, active mode, dependency and model readiness.
- `POST /api/jobs/analyze`: multipart source image; returns a job ID.
- `POST /api/jobs/projects/{id}/inpaint`: selected layer IDs, `lama`/`powerpaint` mode, and an optional prompt; returns a job ID.
- `GET /api/jobs/{id}`: authoritative state and the typed result after completion.
- `GET /api/projects/{id}/assets/{name}`: validated project asset delivery.
- `POST /api/projects/{id}/export`: camera/layer state in, `.stereovisor` package out.
- `POST /api/projects/import`: `.stereovisor` package in, restored project and camera state out.
- `POST /api/jobs/{id}/cancel`: request cooperative cancellation and return the job's cancelled state.

All errors use `{ "code": string, "message": string, "detail"?: string }`.

The service listens on `127.0.0.1:5772` by default. Server-side
`STEREOVISOR_SERVICE_HOST` and `STEREOVISOR_SERVICE_PORT` are independent of the
client's Advanced `service.origin` setting. A non-loopback bind is refused unless
`STEREOVISOR_AUTH_TOKEN` is set; in that mode every HTTP route requires the
matching bearer token and `/api/events` requires its WebSocket subprotocol form.
`npm run openapi` writes the full document to `openapi.json`.

### Event channel

`GET /api/events` upgrades to a WebSocket that pushes state changes so clients do not poll for them. Frames carry `topic` (`job` or `health`) and a per-topic monotonic `seq`.

Three rules keep HTTP authoritative:

1. A job frame never carries `result`. On `state: "completed"` the client reads `GET /api/jobs/{id}` for the authoritative project or capability result.
2. Clients read current state over HTTP, then subscribe. Frames older than the applied `seq` are discarded, so a dropped frame cannot strand the UI.
3. If the socket is unavailable, clients fall back to the original polling cadence. Degraded mode is the pre-socket behavior exactly.

Readiness has no natural push source, so one server-side watch recomputes health once a second while at least one subscriber is connected and broadcasts only on change. CORS does not cover the WebSocket handshake, so the browser-sent `Origin` is checked against the same allowlist.

### Job queue

Jobs are durable. `service/src/jobs.py` keeps state in SQLite beside the projects it
produces, with results in a separate table so status polling never reads the
payload blob. A job therefore survives a service restart: a renderer that
reconnects reads a real terminal state instead of a 404.

The editor persists its active job ID, workflow kind, and project snapshot per
service origin. After reload or reopen it restores the existing job's progress
and Cancel control before allowing new submissions, and collects work that
finished while the window was closed. Completion and cancellation clear this
recovery record; reloading does not cancel server-owned work.

`service/src/jobqueue.py` puts one FIFO worker in front of the local GPU, which is
all the hardware allows anyway. Making that explicit means a waiting job reports
`queuePosition` - how many jobs are ahead of it, mirrored into `message` so
existing UI needs no change - instead of silently occupying a request thread
inside the pipeline lock. Submitting is now cheap: `POST /api/jobs/...` enqueues
and returns without waiting on inference. Workflow and capability requests from
every client share this queue. Cancelling a queued job removes it immediately
and recomputes the positions behind it.

Two consequences follow from durability:

- **Interrupted work fails honestly.** GPU work cannot be resumed, so anything
  left `queued` or `running` by a crash is marked failed on the next startup
  with an explanatory message, rather than appearing to run with no worker.
- **Finished work is swept.** Terminal jobs are evicted an hour after their last
  update, so a long-lived install does not accumulate results forever.

Splitting the API and the worker into separate processes later means replacing
the in-process consumer with one that polls the same database. The queue
boundary does not move. The current guarantee applies to the supported
single-process service launcher; multiple Uvicorn worker processes are not a
supported deployment because each would own a separate in-memory consumer.

### Capability API

The workflow routes above compose whole operations. These address one AI component each, for callers that need a single stage:

- `GET /api/capabilities`: inventory of every component - model, gating provider, readiness, device, VRAM budget, and accepted parameters.
- `POST /api/jobs/capabilities/segmentation:detect`: image in, queued instances with masks/labels/scores out.
- `POST /api/jobs/capabilities/depth:estimate`: image in, queued depth preview out.
- `POST /api/jobs/capabilities/matting:refine`: image plus rough mask in, queued alpha out.
- `POST /api/jobs/capabilities/inpainting:fill`: image plus mask in, queued Big LaMa fill out.
- `POST /api/jobs/capabilities/vlm:vocabulary`, `POST /api/jobs/capabilities/vlm:caption`: image in, queued labels or a background prompt out.

Every route is a thin front for a function in `service/src/providers.py`, which calls the same implementation the pipeline uses; a capability must never become a second copy of a stage. The POST returns `{ "jobId": "..." }`; `GET /api/jobs/{id}` carries the typed result, with image output encoded as base64 PNG. The explicit queue provides admission control while the pipeline lock remains a defensive serialization boundary around model allocation.

PowerPaint is listed in the inventory with `endpoint: null`. It remains reachable through workflow jobs because its standalone request still needs a project and prompt contract, not because the job store is limited to project results.

## 5. Renderer Design

The interface has three stable zones:

- Left rail: upload/sample action and workflow status.
- Center stage: the composited image, direct camera dragging, and a compact camera toolbar.
- Right inspector: foreground selection during analysis, then visibility/depth controls in the editor.
- Top actions: load a project at any time; export the portable project whenever a scene exists; export PNG/MP4 after the background is built.

The visual language is a dark graphite workspace with warm ivory text and a restrained acid-lime accent. This keeps the image dominant and avoids a generic dashboard appearance. Dense controls use a monospace label style while titles remain editorial.

## 6. Implementation Sequence

1. Establish shared types and service API.
2. Implement project storage and preview pipeline.
3. Add production Grounding DINO-B, SAM 2.1, InSPyReNet, DA3, LaMa, Qwen3-VL, and PowerPaint providers behind the same interfaces.
4. Build the upload/analyze/select/inpaint workflow.
5. Build the cached Canvas compositor and camera controls.
6. Add Electron lifecycle, service launch, and native export.
7. Add unit, service, build, and browser interaction verification.

## 7. Failure Handling

- Decode failure: reject before creating a project.
- Missing AI stack in `ai` mode: return HTTP 503 with the exact bootstrap command.
- Empty segmentation result: keep the project source and return an actionable error.
- Individual matte rejection: preserve the corresponding SAM instance mask.
- Matting runtime failure: abort the AI job; do not silently mix hard preview masks into an AI result.
- Inpaint failure: retain analyzed layers and allow retry.
- Cancellation: mark the job cancelled immediately, poll cancellation at stage boundaries, kill a running PowerPaint subprocess, and skip the final project write.
- Missing asset: return 404 without exposing arbitrary filesystem paths.

## 8. Packaging Plan

Version 0.3 runs from source. `Run Stereovisor.cmd` creates the main and PowerPaint virtual environments, pins the upstream DA3 and PowerPaint source revisions, and downloads model weights behind a dedicated preparation window on first launch. Later launches start the installed local service directly while offline and open the editor after its live provider check; they re-enter preparation only when required assets are missing or damaged. H.264 MP4 export uses Electron's bundled Chromium encoder, with WebM fallback, so FFmpeg is not installed or distributed. Packaging and signing remain separate.
