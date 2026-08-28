import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { resolveAssetUrl } from "../lib/api";
import { backgroundTransform, clamp, demoCameraAt, fitVideoDimensions, layerTransform, visibleLayers } from "../lib/parallax";
import type { CameraState, SceneProject } from "../types";

export interface SceneCanvasHandle {
  exportPng: () => Promise<void>;
  exportVideo: () => Promise<void>;
}

interface Props {
  project: SceneProject;
  camera: CameraState;
  onCameraChange: (camera: CameraState) => void;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${source}`));
    image.src = resolveAssetUrl(source);
  });
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

function drawScene(
  canvas: HTMLCanvasElement,
  project: SceneProject,
  camera: CameraState,
  images: Map<string, HTMLImageElement>
): boolean {
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

  for (const layer of visibleLayers(project.layers)) {
    const image = images.get(layer.cutoutUrl);
    if (!image) continue;
    const transform = layerTransform(camera, layer.depth, canvas.width, canvas.height);
    context.save();
    context.translate(canvas.width / 2 + transform.x, canvas.height / 2 + transform.y);
    context.scale(transform.scale, transform.scale);
    context.drawImage(image, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
    context.restore();
  }
  return true;
}

async function recordDemoVideo(
  project: SceneProject,
  camera: CameraState,
  images: Map<string, HTMLImageElement>
): Promise<Blob> {
  if (typeof MediaRecorder === "undefined") throw new Error("This runtime cannot encode WebM video.");
  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) =>
    MediaRecorder.isTypeSupported(type)
  );
  if (!mimeType) throw new Error("This runtime has no supported WebM encoder.");

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
    recorder.onerror = () => reject(new Error("WebM encoding failed."));
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
  if (!result.size) throw new Error("The WebM encoder produced an empty video.");
  return result;
}

export const SceneCanvas = forwardRef<SceneCanvasHandle, Props>(function SceneCanvas(
  { project, camera, onCameraChange },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const dragRef = useRef<{ x: number; y: number; camera: CameraState } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawScene(canvas, project, camera, imagesRef.current);
  }, [camera, project]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const sources = [project.sourceUrl, project.backgroundUrl, ...project.layers.map((layer) => layer.cutoutUrl)].filter(
      (value): value is string => Boolean(value)
    );
    Promise.all(
      sources.map(async (source) => {
        if (!imagesRef.current.has(source)) {
          imagesRef.current.set(source, await loadImage(source));
        }
      })
    )
      .then(() => {
        if (!cancelled) setLoading(false);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load scene assets.");
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
      if (window.stereovisor?.savePng) {
        await window.stereovisor.savePng(dataUrl, `stereovisor-${project.id.slice(0, 8)}.png`);
        return;
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("PNG export failed."))), "image/png")
      );
      downloadBlob(blob, `stereovisor-${project.id.slice(0, 8)}.png`);
    },
    exportVideo: async () => {
      if (loading) throw new Error("Wait for the scene images to finish loading.");
      if (loadError) throw new Error(loadError);
      const blob = await recordDemoVideo(project, camera, imagesRef.current);
      const name = `stereovisor-${project.id.slice(0, 8)}-demo.webm`;
      if (window.stereovisor?.saveVideo) {
        await window.stereovisor.saveVideo(await blob.arrayBuffer(), name);
        return;
      }
      downloadBlob(blob, name);
    }
  }));

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, camera: { ...camera } };
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    const bounds = event.currentTarget.getBoundingClientRect();
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
    <div className="stage-frame" aria-busy={loading}>
      <canvas
        ref={canvasRef}
        width={project.width}
        height={project.height}
        className="scene-canvas"
        aria-label="Parallax scene preview. Drag to move the camera."
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      />
      {loading && <div className="stage-message">Loading layers...</div>}
      {loadError && <div className="stage-message error-text">{loadError}</div>}
      {!loading && !loadError && <div className="drag-hint">Drag image to move camera</div>}
    </div>
  );
});
