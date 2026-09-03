import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import {
  imageToAlphaMask,
  MaskEditorOverlay,
  type MaskBrushMode,
  type MaskEditorHandle,
  type MaskHistoryState,
  type MaskEditorTarget
} from "./MaskEditorOverlay";
import { resolveAssetUrl } from "../lib/api";
import { appLog } from "../lib/logger";
import { useAppTranslation } from "../i18n";
import { backgroundTransform, clamp, demoCameraAt, fitCanvasDimensions, fitVideoDimensions, layerTransform, visibleLayers, type LayerTransform } from "../lib/parallax";
import type { CameraState, SceneLayer, SceneProject } from "../types";

export interface SceneCanvasHandle {
  exportPng: () => Promise<void>;
  exportVideo: () => Promise<void>;
  exportComposition: () => Promise<Blob>;
  exportEditedMask: () => Promise<Blob>;
  resetEditedMask: () => void;
  undoEditedMask: () => void;
  redoEditedMask: () => void;
}

interface Props {
  project: SceneProject;
  camera: CameraState;
  interactive: boolean;
  reviewingSource: boolean;
  // Purely cosmetic: softens the stage while a build is running. It is a CSS
  // filter, so exports (which redraw offscreen) are untouched.
  processing: boolean;
  showInpaintMask: boolean;
  maskEditor: MaskEditorTarget | null;
  showCompositionWhileMaskEditing: boolean;
  brushMode: MaskBrushMode;
  brushSize: number;
  maskBlurRadius: number;
  // When set, a canvas drag repositions that layer's anchor instead of moving
  // the camera.
  anchorLayerId: string | null;
  onLayerAnchorChange: (layerId: string, offsetX: number, offsetY: number) => void;
  onMaskDirtyChange: (dirty: boolean) => void;
  onMaskHistoryChange: (state: MaskHistoryState) => void;
  onMaskReadyChange: (ready: boolean) => void;
  onMaskError: (message: string) => void;
  onCameraChange: (camera: CameraState) => void;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${source}`));
    image.src = resolveAssetUrl(source);
  });
}

function revisionedAssetUrl(source: string, revision: number | null): string {
  if (revision === null) return source;
  return `${source}${source.includes("?") ? "&" : "?"}maskRevision=${revision}`;
}

function downloadBlob(blob: Blob, name: string): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

export function drawScene(
  canvas: HTMLCanvasElement,
  project: SceneProject,
  camera: CameraState,
  images: Map<string, HTMLImageElement>,
  showInpaintMask = false,
  maskEditing = false,
  showCompositionWhileMaskEditing = false,
  anchorLayerId: string | null = null
): boolean {
  // Rendering is deliberately a pure projection of the current project and
  // camera state. Asset loading happens in the effect below, so a missing image
  // simply keeps the previous frame rather than throwing from the render loop.
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return false;
  const backgroundPath = project.backgroundUrl ?? project.sourceUrl;
  const background = images.get(backgroundPath);
  if (!background) return false;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const bg = backgroundTransform(camera);
  context.save();
  context.translate(canvas.width / 2 + bg.x * canvas.width, canvas.height / 2 + bg.y * canvas.height);
  context.scale(bg.scale, bg.scale);
  context.drawImage(background, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
  context.restore();

  if (maskEditing && !showCompositionWhileMaskEditing) return true;

  if (!project.backgroundUrl) {
    if (showInpaintMask) {
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = canvas.width;
      maskCanvas.height = canvas.height;
      const maskContext = maskCanvas.getContext("2d", { alpha: true });
      if (maskContext) {
        for (const layer of project.layers.filter((candidate) => candidate.selected)) {
          const image = images.get(layer.maskUrl);
          if (image) maskContext.drawImage(imageToAlphaMask(image, canvas.width, canvas.height), 0, 0);
        }
        if (project.extraMaskUrl) {
          const extra = images.get(project.extraMaskUrl);
          if (extra) maskContext.drawImage(imageToAlphaMask(extra, canvas.width, canvas.height), 0, 0);
        }
        context.save();
        context.globalAlpha = 0.5;
        context.translate(canvas.width / 2 + bg.x * canvas.width, canvas.height / 2 + bg.y * canvas.height);
        context.scale(bg.scale, bg.scale);
        context.drawImage(maskCanvas, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
        context.restore();
      }
      return true;
    }
  }

  const layers = project.backgroundUrl
    ? visibleLayers(project.layers)
    : project.layers
      .filter((layer) => layer.selected)
      .slice()
      .sort((a, b) => a.depth - b.depth || a.order - b.order);
  for (const layer of layers) {
    const image = images.get(layer.cutoutUrl);
    if (!image) continue;
    const transform = layerTransform(camera, layer.depth, canvas.width, canvas.height, layer);
    context.save();
    context.translate(canvas.width / 2 + transform.x, canvas.height / 2 + transform.y);
    context.scale(transform.scale, transform.scale);
    context.drawImage(image, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
    context.restore();
    if (layer.id === anchorLayerId) drawAnchorOutline(context, canvas, layer, transform);
  }
  return true;
}

function drawAnchorOutline(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  layer: SceneLayer,
  transform: LayerTransform
): void {
  // The bounds are in composition space and never move with the anchor, so the
  // marker rides the same transform the cutout was just drawn with.
  const [left, top, right, bottom] = layer.bounds;
  const edge = Math.max(2, Math.round(Math.max(canvas.width, canvas.height) / 400));
  context.save();
  context.translate(canvas.width / 2 + transform.x, canvas.height / 2 + transform.y);
  context.scale(transform.scale, transform.scale);
  context.translate(-canvas.width / 2, -canvas.height / 2);
  context.lineWidth = edge;
  context.setLineDash([edge * 4, edge * 3]);
  context.strokeStyle = "#c7f15a";
  context.strokeRect(left, top, right - left, bottom - top);
  context.setLineDash([]);
  context.fillStyle = "#c7f15a";
  context.beginPath();
  context.arc((left + right) / 2, (top + bottom) / 2, edge * 3, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

const DEMO_VIDEO_TYPES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp8",
  "video/webm;codecs=vp9",
  "video/webm"
] as const;

export function selectDemoVideoType(isSupported: (type: string) => boolean): string | null {
  return DEMO_VIDEO_TYPES.find((type) => isSupported(type)) ?? null;
}

export function demoVideoExtension(mimeType: string): "mp4" | "webm" {
  return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

async function recordDemoVideo(
  project: SceneProject,
  camera: CameraState,
  images: Map<string, HTMLImageElement>
): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") throw new Error("This runtime cannot encode demo video.");
  const mimeType = selectDemoVideoType((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("This runtime has no supported MP4 or WebM encoder.");

  const [width, height] = fitVideoDimensions(project.width, project.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const stream = canvas.captureStream(24);
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error("Demo video encoding failed."));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  const durationMs = 4000;
  const started = performance.now();
  if (!drawScene(canvas, project, demoCameraAt(camera, 0), images)) {
    throw new Error("The scene images are not ready for video export.");
  }
  recorder.start(250);
  while (performance.now() - started < durationMs) {
    const progress = (performance.now() - started) / durationMs;
    drawScene(canvas, project, demoCameraAt(camera, progress), images);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  drawScene(canvas, project, demoCameraAt(camera, 1), images);
  recorder.stop();
  const result = await stopped;
  stream.getTracks().forEach((track) => track.stop());
  if (!result.size) throw new Error("The video encoder produced an empty file.");
  return result;
}

export const SceneCanvas = forwardRef<SceneCanvasHandle, Props>(function SceneCanvas(
  {
    project,
    camera,
    interactive,
    reviewingSource,
    processing,
    showInpaintMask,
    maskEditor,
    showCompositionWhileMaskEditing,
    brushMode,
    brushSize,
    maskBlurRadius,
    anchorLayerId,
    onLayerAnchorChange,
    onMaskDirtyChange,
    onMaskHistoryChange,
    onMaskReadyChange,
    onMaskError,
    onCameraChange
  },
  ref
) {
  const { t, runtimeText, layerName } = useAppTranslation();
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskEditorRef = useRef<MaskEditorHandle>(null);
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const imageRevisionsRef = useRef<Map<string, string>>(new Map());
  const dragRef = useRef<{ x: number; y: number; camera: CameraState; anchor: { offsetX: number; offsetY: number } | null } | null>(null);
  const anchorLayer = anchorLayerId ? project.layers.find((layer) => layer.id === anchorLayerId) ?? null : null;
  const anchoring = anchorLayer !== null;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [displaySize, setDisplaySize] = useState<[number, number]>([0, 0]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const updateSize = () => {
      const next = fitCanvasDimensions(frame.clientWidth, frame.clientHeight, project.width, project.height);
      setDisplaySize((current) =>
        Math.abs(current[0] - next[0]) < 0.5 && Math.abs(current[1] - next[1]) < 0.5 ? current : next
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [project.height, project.width]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawScene(
      canvas,
      project,
      camera,
      imagesRef.current,
      showInpaintMask,
      Boolean(maskEditor),
      showCompositionWhileMaskEditing,
      anchorLayerId
    );
  }, [anchorLayerId, camera, maskEditor, project, showCompositionWhileMaskEditing, showInpaintMask]);

  useEffect(() => {
    // Cache by source plus mask revision. Edited masks keep the same URL, so
    // the revision query is the explicit cache-busting boundary.
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const assets = [
      { source: project.sourceUrl, revision: null },
      ...(project.backgroundUrl ? [{ source: project.backgroundUrl, revision: null }] : []),
      ...(project.extraMaskUrl ? [{ source: project.extraMaskUrl, revision: null }] : []),
      ...project.layers.flatMap((layer) => [
        { source: layer.cutoutUrl, revision: layer.maskRevision },
        { source: layer.maskUrl, revision: layer.maskRevision }
      ])
    ];
    const sources = assets.map((asset) => asset.source);
    const activeSources = new Set(sources);
    for (const source of imagesRef.current.keys()) {
      if (!activeSources.has(source)) {
        imagesRef.current.delete(source);
        imageRevisionsRef.current.delete(source);
      }
    }
    Promise.all(
      assets.map(async ({ source, revision }) => {
        const signature = `${source}|${revision ?? "static"}`;
        if (imageRevisionsRef.current.get(source) !== signature) {
          imagesRef.current.set(source, await loadImage(revisionedAssetUrl(source, revision)));
          imageRevisionsRef.current.set(source, signature);
        }
      })
    )
      .then(() => {
        if (!cancelled) {
          setLoading(false);
          appLog.info("scene.assets.loaded", { projectId: project.id, count: assets.length });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          appLog.error("scene.assets.failed", error, { projectId: project.id, count: assets.length });
          setLoadError(error instanceof Error ? error.message : "Could not load scene assets.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  useEffect(() => {
    if (!loading) render();
  }, [loading, render]);

  useImperativeHandle(ref, () => ({
    exportPng: async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      render();
      const dataUrl = canvas.toDataURL("image/png");
      appLog.info("workflow.png-export.started", { projectId: project.id });
      if (window.stereovisor?.savePng) {
        await window.stereovisor.savePng(dataUrl, `stereovisor-${project.id.slice(0, 8)}.png`);
        appLog.info("workflow.png-export.completed", { projectId: project.id });
        return;
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("PNG export failed."))), "image/png")
      );
      downloadBlob(blob, `stereovisor-${project.id.slice(0, 8)}.png`);
      appLog.info("workflow.png-export.completed", { projectId: project.id, bytes: blob.size });
    },
    exportVideo: async () => {
      if (loading) throw new Error("Wait for the scene images to finish loading.");
      if (loadError) throw new Error(loadError);
      const blob = await recordDemoVideo(project, camera, imagesRef.current);
      const extension = demoVideoExtension(blob.type);
      const name = `stereovisor-${project.id.slice(0, 8)}-demo.${extension}`;
      if (window.stereovisor?.saveVideo) {
        await window.stereovisor.saveVideo(await blob.arrayBuffer(), name);
        appLog.info("workflow.video-export.completed", { projectId: project.id, bytes: blob.size, type: blob.type });
        return;
      }
      downloadBlob(blob, name);
      appLog.info("workflow.video-export.completed", { projectId: project.id, bytes: blob.size, type: blob.type });
    },
    exportComposition: async () => {
      if (loading) throw new Error("Wait for the scene images to finish loading.");
      if (loadError) throw new Error(loadError);
      const output = document.createElement("canvas");
      output.width = project.width;
      output.height = project.height;
      if (!drawScene(output, project, { x: 0, y: 0, zoom: 1, strength: camera.strength }, imagesRef.current)) {
        throw new Error("The full scene composition is not ready.");
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("The composition could not be encoded."))),
          "image/png"
        )
      );
      appLog.info("workflow.composition-export.completed", { projectId: project.id, bytes: blob.size });
      return blob;
    },
    exportEditedMask: async () => {
      if (!maskEditorRef.current) throw new Error("Choose a mask before applying brush changes.");
      return maskEditorRef.current.exportMask();
    },
    resetEditedMask: () => maskEditorRef.current?.reset(),
    undoEditedMask: () => maskEditorRef.current?.undo(),
    redoEditedMask: () => maskEditorRef.current?.redo()
  }));

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!interactive) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      camera: { ...camera },
      anchor: anchorLayer ? { offsetX: anchorLayer.offsetX, offsetY: anchorLayer.offsetY } : null
    };
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!interactive) return;
    const drag = dragRef.current;
    if (!drag) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (drag.anchor && anchorLayer) {
      // The canvas is drawn to fit the frame, so a pixel of pointer travel is
      // the same fraction of the composition either way.
      onLayerAnchorChange(
        anchorLayer.id,
        clamp(drag.anchor.offsetX + (event.clientX - drag.x) / bounds.width, -1, 1),
        clamp(drag.anchor.offsetY + (event.clientY - drag.y) / bounds.height, -1, 1)
      );
      return;
    }
    onCameraChange({
      ...camera,
      x: clamp(drag.camera.x + ((event.clientX - drag.x) / bounds.width) * 2, -1, 1),
      y: clamp(drag.camera.y + ((event.clientY - drag.y) / bounds.height) * 2, -1, 1)
    });
  }

  function pointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  return (
    <div ref={frameRef} className="stage-frame" aria-busy={loading}>
      <canvas
        ref={canvasRef}
        width={project.width}
        height={project.height}
        className={`scene-canvas ${interactive ? "interactive" : "static"} ${anchoring ? "anchoring" : ""} ${processing ? "processing" : ""}`}
        style={{ width: `${displaySize[0]}px`, height: `${displaySize[1]}px` }}
        aria-label={
          maskEditor
            ? t("scene.maskEditorLabel", {
              surface: showCompositionWhileMaskEditing
                ? t("scene.fullComposition")
                : project.backgroundUrl
                  ? t("scene.backgroundPlate")
                  : t("scene.originalImage"),
              name: layerName(maskEditor.name)
            })
            : reviewingSource
              ? t("scene.originalPreviewLabel")
              : anchorLayer
                ? t("scene.anchorPreviewLabel", { name: layerName(anchorLayer.name) })
                : interactive
                  ? t("scene.parallaxPreviewLabel")
                  : t("scene.processingPreviewLabel")
        }
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      />
      {maskEditor && (
        <MaskEditorOverlay
          ref={maskEditorRef}
          target={maskEditor}
          width={project.width}
          height={project.height}
          displaySize={displaySize}
          mode={brushMode}
          brushSize={brushSize}
          blurRadius={maskBlurRadius}
          onDirtyChange={onMaskDirtyChange}
          onHistoryChange={onMaskHistoryChange}
          onReadyChange={onMaskReadyChange}
          onError={onMaskError}
        />
      )}
      {loading && <div className="stage-message">{t("scene.loading")}</div>}
      {loadError && <div className="stage-message error-text">{runtimeText(loadError)}</div>}
      {!loading && !loadError && (
        <div className="drag-hint">
          {maskEditor
            ? t(brushMode === "add" ? "scene.addTo" : "scene.eraseFrom", { name: layerName(maskEditor.name) })
            : reviewingSource
              ? t("scene.reviewHint")
              : anchorLayer
                ? t("scene.anchorHint", { name: layerName(anchorLayer.name) })
                : interactive
                  ? t("scene.dragHint")
                  : t("scene.building")}
        </div>
      )}
    </div>
  );
});
