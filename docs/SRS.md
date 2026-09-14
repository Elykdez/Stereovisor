# Stereovisor Software Requirements Specification

Version 0.3 - 2026-08-28

## 1. Purpose

Stereovisor is a local-first desktop application that turns one still image into an editable 2.5D scene. It separates visually meaningful objects into transparent foreground layers, reconstructs the background behind those objects, and lets the user preview and export a camera-driven parallax composition.

The product is not a general image editor. Its core job is to reduce a photograph into a background plate plus a small, understandable stack of depth layers.

## 2. Product Principles

- Local by default: source images and generated assets remain on the user's machine.
- Inspectable AI: each model stage reports its provider, readiness, progress, and errors.
- Non-destructive: the source image is preserved and generated assets live in a project workspace.
- Editable result: model output is a starting point; users can include or exclude layers and adjust depth.
- Responsive preview: camera movement is rendered in the Electron renderer and never invokes AI per frame.

## 3. Users and Primary Flow

The primary user is a designer or content creator who wants a parallax still without manually cutting every object.

1. The user opens or drops a PNG, JPEG, or WebP image.
2. The application analyzes the image and proposes object layers.
3. The user chooses which proposed layers become foreground.
4. The application joins the selected alpha masks, expands the removal boundary, and inpaints a clean background plate.
5. The scene opens in the parallax editor.
6. The user changes camera position, zoom, parallax strength, layer visibility, and per-layer depth.
7. The user exports the current view as a PNG or a short H.264 MP4 parallax video.
8. The user can export a portable project and load it later with all processed images and editor state restored.

## 4. Functional Requirements

### FR-1 Image Input

- Accept PNG, JPEG, and WebP files up to 40 MB.
- Reject unsupported or undecodable input with a clear message.
- Preserve the source dimensions and aspect ratio.
- Offer a bundled sample scene for evaluation and tests.

### FR-2 Object Analysis

- Production mode shall run Grounding DINO-B locally to find repeated open-vocabulary subjects.
- Grounding DINO boxes shall prompt SAM 2.1 Small locally to produce one instance mask per detected subject.
- Filter tiny, near-full-frame, duplicate, and low-value detections.
- Return at most 24 semantic instance layers so dense group portraits can retain individual characters.
- Expose a persisted comma-separated detection vocabulary override; blank uses the selected density's built-in labels.
- Expose an opt-in Qwen3-VL vocabulary proposer that is disabled by default, runs only when the manual vocabulary is blank, and releases the VLM before Grounding DINO-B loads.
- Accept custom detection labels through `STEREOVISOR_OBJECT_LABELS` for headless runs without changing application code.

### FR-3 Foreground Matting

- Refine each accepted instance with InSPyReNet `base` to preserve soft edges where possible.
- Intersect the refined alpha with the instance proposal so neighboring objects do not leak into a layer.
- Preserve the user-edited proposal separately from the refined alpha and use it as stable guidance on every subsequent refine.
- Never replace a stable proposal with a small salient fragment from an undesignated area; fall back to the proposal when refinement confidence collapses.
- Preserve the SAM 2.1 instance mask when InSPyReNet cannot produce a usable salient-object matte for that crop.
- Expose persisted `Sparse`, `Balanced`, and `Dense` segmentation density settings for controlling the detector vocabulary and proposal floor.
- Keep a per-layer refinement history with undo/redo controls and `Ctrl+Z`/`Ctrl+Y` shortcuts during mask review.
- Store each foreground layer as a full-canvas transparent PNG.

### FR-4 Depth Decomposition

- Run Depth Anything 3 Small locally after segmentation and matting models have been released.
- Assign each semantic instance an initial editable depth from the median relative depth inside its mask.
- For sparse scenes, derive one additional near-depth foreground plane from non-semantic pixels.
- Do not create a duplicate depth plane when semantic masks already cover most of the image.
- Preserve an inspectable grayscale depth-map asset.

### FR-5 Background Reconstruction

- Join the selected layer alpha channels into one removal mask.
- Dilate the joined mask to remove edge contamination before reconstruction.
- Prefer local PowerPaint v2.1 with CUDA CPU offload when available, and retain CPU-only execution with a visible warning when CUDA is unavailable.
- Expose a persisted Inference setting for PowerPaint denoising steps, defaulting to 25 and clamped to 5-100.
- PowerPaint shall start from pure noise for a full-redraw equivalent to denoise strength 1.0.
- Discard every original pixel inside the expanded removal mask when compositing the PowerPaint result.
- Retain Big LaMa as an explicitly labeled fast structural-fill option.
- In HQ mode, use a manual background prompt when supplied; otherwise generate a concise prompt locally with Qwen3-VL 2B.
- Preserve the joined mask and reconstructed background as inspectable project assets.

### FR-6 Layer Editor

- Display the background plate and every foreground layer in a composited stage.
- Allow layer visibility, selection-for-inpaint, depth, and ordering changes.
- Show mask previews and stable layer names.
- Keep camera motion independent from AI inference.

### FR-7 Camera and Parallax

- Support horizontal and vertical camera offset, zoom, and parallax strength.
- Allow direct pointer dragging on the stage.
- Offer an automatic motion preview.
- Apply larger translation to layers with greater foreground depth.
- Overscan the background so small camera moves do not reveal empty canvas.
- Provide a global depth-of-field amount and focus plane that derive blur from scene depth.
- Treat per-layer blur as a signed adjustment to the derived blur without overwriting the layer value.

### FR-8 Export

- Export the current composite at source resolution as PNG.
- Preserve alpha only where the composition itself has transparency.
- Export a four-second looping parallax demonstration as H.264 MP4 at up to 1280 pixels on its longest edge, with WebM fallback when MP4 recording is unavailable.
- Export a versioned `.stereovisor` project package containing every processed PNG and a JSON manifest.
- Record current camera, depth-of-field, focus, layer depth, order, visibility, selection, bounds, engine, and inpainting metadata in the manifest.
- Store each asset's byte length and SHA-256 checksum for import verification.
- Use native save dialogs in Electron and browser downloads during development.

### FR-9 Model Readiness

- Report whether production AI dependencies are installed.
- Identify active segmentation, matting, depth, inpainting, prompt, and refinement providers.
- Report optional prompt/refinement providers as ready only after their validated snapshot marker and required checkpoint files exist.
- The one-click runner shall install dependencies, pin model source revisions, download weights, and validate CUDA on Windows or MPS on Apple Silicon before opening the editor.
- Never present preview processing as AI processing.
- If production mode is explicitly requested and unavailable, fail with installation guidance.
- While a local job is running, expose a Cancel action. Cancellation shall stop the worker at the next safe stage boundary, terminate an active PowerPaint subprocess, and leave the last saved project state intact.

### FR-10 Project Storage

- Create a unique project directory beneath the application data directory.
- Store source, masks, cutouts, background plate, and project metadata.
- Serve only files belonging to known project directories.
- Load `.stereovisor` packages into a fresh local project directory and rewrite their asset URLs.
- Reject unsupported versions, unsafe paths, missing assets, invalid PNGs, and checksum mismatches.

## 5. Non-Functional Requirements

### Performance

- Camera interaction target: 60 fps for up to 24 2K layers on a typical discrete GPU.
- Production inference shall fit an 8 GB VRAM budget by loading GPU stages sequentially and releasing segmentation tensors before inpainting.
- Grounding DINO-B, SAM 2.1, InSPyReNet, Depth Anything 3, Qwen3-VL, and the selected inpainter shall never remain GPU-resident together.
- PowerPaint shall run in an isolated Python environment, using model CPU offload with CUDA and CPU-only loading when CUDA is unavailable.
- Each CUDA stage shall report its measured peak allocation and fail explicitly if it exceeds 8192 MB; MPS stages shall report their selected device without claiming unavailable CUDA telemetry.
- No model inference or image decoding during an animation frame.
- Release InSPyReNet after each refinement operation; no GPU model may remain resident across stage boundaries.
- Analyze and inpaint off the Electron renderer thread.
- Encode demo video with Chromium's local H.264 MP4 encoder, falling back to WebM when needed; do not require FFmpeg or a cloud service.

### Security

- Enable Electron context isolation and sandboxing.
- Disable renderer Node integration.
- Expose only narrow, typed save-dialog methods through the preload bridge.
- Bind the model service to loopback only and restrict CORS to local development origins.
- Validate file size, media type, identifiers, and resolved asset paths.

### Reliability

- Generated project assets are immutable per processing stage.
- A failed analysis or inpaint operation must leave the source usable for retry.
- A cancelled job must report a distinct cancelled state and must not commit its in-progress result over the saved project.
- Service errors include a machine-readable code and a human-readable message.

### Accessibility

- All controls are keyboard reachable and visibly focused.
- Inputs have text labels; state is not communicated by color alone.
- Respect reduced-motion preferences for automatic camera preview.

## 6. Modes

### Production AI Mode

- Detection: Grounding DINO-B.
- Instance segmentation: SAM 2.1 Small.
- Matting: InSPyReNet `base` with dynamic resizing and a per-job CUDA or MPS session.
- Depth: Depth Anything 3 Small, selected for relative ordering and the 8 GB budget.
- Default inpainting: local Big LaMa TorchScript model.
- Optional Qwen3-VL 2B vocabulary proposal and background-prompt generation; PowerPaint v2.1 provides full-redraw refinement.
- Model files download on first production use and remain in the user's model cache.
- All inference runs in the locally operated Python service. An authenticated
  LAN client may use that service from another machine; no third-party cloud
  inference endpoint is supported by the service contract.

### Preview Mode

- Uses deterministic color-region proposals, hard alpha, and blur synthesis.
- Exists for onboarding, UI development, and automated tests.
- The interface must display `Preview engine` whenever it is active.

### Auto Mode

- Uses the production pipeline when all AI dependencies are installed.
- Otherwise uses preview mode and reports why production AI is unavailable.

## 7. Out of Scope for 0.1

- Manual pixel painting and polygon editing.
- Video input, multi-frame tracking, and audio.
- Physically correct 3D reconstruction.
- Cloud inference or account synchronization.
- Packaged installers and code signing.

## 8. Acceptance Criteria

- `npm run check` passes type checking, renderer unit tests, service tests, and a production build.
- The bundled sample produces at least two foreground layers in preview mode.
- A production project reports semantic labels, layer kinds, a depth-map URL, and per-stage VRAM peaks.
- Joining selected masks changes the background plate inside the union while leaving pixels outside the expanded union unchanged within tolerance.
- Camera controls visibly move foreground layers by different amounts based on depth.
- Disabling a layer removes it from the composite without rerunning analysis.
- PNG export produces a non-empty file at source resolution.
- Project export followed by load restores every referenced image, current layer state, and camera state under a new local project ID.
- Demo export produces a non-empty four-second H.264 MP4, or a WebM fallback, without installing FFmpeg.
- The app clearly distinguishes production AI from preview processing.

## 9. Technical References

- [Grounding DINO in Transformers](https://huggingface.co/docs/transformers/model_doc/grounding-dino)
- [Grounding DINO-B checkpoint](https://huggingface.co/IDEA-Research/grounding-dino-base)
- [SAM 2 in Transformers](https://huggingface.co/docs/transformers/model_doc/sam2)
- [SAM 2.1 Small](https://huggingface.co/facebook/sam2.1-hiera-small)
- [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3)
- [InSPyReNet transparent-background](https://github.com/plemeri/transparent-background)
- [LaMa](https://github.com/advimman/lama)
- [Qwen3-VL 2B](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct)
- [PowerPaint](https://github.com/open-mmlab/PowerPaint)
