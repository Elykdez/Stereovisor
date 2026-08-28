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
  - Canvas 2D compositor              - DINO-T + SAM 2.1 instances
  - camera controls                   - InSPyReNet + DA3 layers
  - PNG/WebM export                   - LaMa / Qwen + PowerPaint
  - project load/export               - validated package import/export
```

This boundary keeps native/model packages outside the renderer, allows the service to be tested independently, and avoids serializing large pixel buffers through Electron IPC.

The service has no cloud-provider adapter. Network access is used only to acquire model weights when they are not already present.

## 2. Processing Pipeline

### Analyze

1. Decode and normalize the source into RGB without changing dimensions.
2. Run Grounding DINO-T once with the configured vocabulary and suppress duplicate boxes.
3. Prompt SAM 2.1 Small with all retained boxes in one batch.
4. Release both segmentation models before starting matting.
5. For each instance, crop with padding and run InSPyReNet `base`; retain the SAM mask if the salient matte is empty.
6. Release InSPyReNet, then run Depth Anything 3 Small for relative layer ordering.
7. Assign semantic-layer depth from the depth map and optionally extract one non-semantic near plane.
8. Save RGBA cutouts, grayscale masks, the depth map, labels, confidence, and per-stage VRAM peaks.

Every GPU provider is loaded for one stage and explicitly released before the next. The service lock prevents simultaneous jobs, and every stage records peak CUDA allocation against the 8192 MB limit.

### Build Scene

1. Load alpha masks for user-selected layers.
2. Compute a per-pixel maximum union.
3. Dilate the union by a user-independent safety radius proportional to image size.
4. Feather only the inspection/export mask; keep a binary mask for LaMa.
5. In full-redraw mode, run Qwen3-VL only when a manual prompt is absent, release it, then invoke PowerPaint in its isolated CPU-offload environment.
6. Start PowerPaint from random latents for all scheduler steps, equivalent to denoise strength 1.0.
7. Composite generated pixels with a binary mask so no source pixel is blended back inside the removal region.
8. In fast structural-fill mode, run Big LaMa against the original RGB image and binary removal mask.
9. Save the background plate, selected provider, generated prompt, and stage metrics.
10. Release the inpainter and clear unused CUDA cache after the stage completes.

### Render

1. Preload source/background and cutout images once.
2. Render the background with overscan.
3. Sort visible layers from far to near.
4. Translate each layer by `cameraOffset * parallaxStrength * depth`.
5. Apply zoom around the canvas center.
6. Render continuously only while an image is loading, the pointer is moving, or motion preview is active.
7. For demo export, render the same cached layers to a capped 1280-pixel canvas and encode four seconds of camera motion with Chromium MediaRecorder.

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
- `POST /api/analyze`: multipart source image; returns a project with proposals.
- `POST /api/projects/{id}/inpaint`: selected layer IDs, `lama`/`powerpaint` mode, and an optional prompt; returns the updated project.
- `GET /api/projects/{id}/assets/{name}`: validated project asset delivery.
- `POST /api/projects/{id}/export`: camera/layer state in, `.stereovisor` package out.
- `POST /api/projects/import`: `.stereovisor` package in, restored project and camera state out.

All errors use `{ "code": string, "message": string, "detail"?: string }`.

## 5. Renderer Design

The interface has three stable zones:

- Left rail: upload/sample action and workflow status.
- Center stage: the composited image, direct camera dragging, and a compact camera toolbar.
- Right inspector: foreground selection during analysis, then visibility/depth controls in the editor.
- Top actions: load a project at any time; export the portable project whenever a scene exists; export PNG/WebM after the background is built.

The visual language is a dark graphite workspace with warm ivory text and a restrained acid-lime accent. This keeps the image dominant and avoids a generic dashboard appearance. Dense controls use a monospace label style while titles remain editorial.

## 6. Implementation Sequence

1. Establish shared types and service API.
2. Implement project storage and preview pipeline.
3. Add production Grounding DINO-T, SAM 2.1, InSPyReNet, DA3, LaMa, Qwen3-VL, and PowerPaint providers behind the same interfaces.
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
- Missing asset: return 404 without exposing arbitrary filesystem paths.

## 8. Packaging Plan

Version 0.3 runs from source. `Run Stereovisor.cmd` creates the main and PowerPaint virtual environments, pins the upstream DA3 and PowerPaint source revisions, and downloads all model weights on first launch. Later launches validate and reuse these assets. WebM export uses Electron's bundled Chromium encoder, so FFmpeg is not installed or distributed. Packaging and signing remain separate.
