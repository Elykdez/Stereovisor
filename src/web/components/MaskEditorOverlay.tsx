import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { useAppTranslation } from "../i18n";
import { resolveAssetUrl } from "../lib/api";

export type MaskBrushMode = "add" | "erase";

export interface MaskEditorTarget {
  key: string;
  name: string;
  maskUrl: string | null;
}

export interface MaskEditorHandle {
  exportMask: () => Promise<Blob>;
  reset: () => void;
  undo: () => void;
  redo: () => void;
}

export interface MaskHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

interface Props {
  target: MaskEditorTarget;
  width: number;
  height: number;
  displaySize: [number, number];
  mode: MaskBrushMode;
  brushSize: number;
  blurRadius: number;
  onDirtyChange: (dirty: boolean) => void;
  onHistoryChange: (state: MaskHistoryState) => void;
  onReadyChange: (ready: boolean) => void;
  onError: (message: string) => void;
}

interface HistoryEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
}

const MAX_HISTORY_ACTIONS = 100;
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;

function readAlpha(context: CanvasRenderingContext2D, width: number, height: number): Uint8ClampedArray {
  const rgba = context.getImageData(0, 0, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let source = 3, target = 0; source < rgba.length; source += 4, target += 1) alpha[target] = rgba[source];
  return alpha;
}

function changedRegion(before: Uint8ClampedArray, after: Uint8ClampedArray, width: number, height: number): HistoryEntry | null {
  // Store only the changed rectangle. Large masks can then support useful
  // undo history without copying a full frame for every brush stroke.
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === after[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) return null;
  const regionWidth = right - left + 1;
  const regionHeight = bottom - top + 1;
  const beforeRegion = new Uint8ClampedArray(regionWidth * regionHeight);
  const afterRegion = new Uint8ClampedArray(regionWidth * regionHeight);
  for (let row = 0; row < regionHeight; row += 1) {
    const sourceStart = (top + row) * width + left;
    const targetStart = row * regionWidth;
    beforeRegion.set(before.subarray(sourceStart, sourceStart + regionWidth), targetStart);
    afterRegion.set(after.subarray(sourceStart, sourceStart + regionWidth), targetStart);
  }
  return { x: left, y: top, width: regionWidth, height: regionHeight, before: beforeRegion, after: afterRegion };
}

function writeAlphaRegion(context: CanvasRenderingContext2D, entry: HistoryEntry, alpha: Uint8ClampedArray): void {
  const pixels = context.createImageData(entry.width, entry.height);
  for (let source = 0, target = 0; source < alpha.length; source += 1, target += 4) {
    pixels.data[target] = 255;
    pixels.data[target + 1] = 255;
    pixels.data[target + 2] = 255;
    pixels.data[target + 3] = alpha[source];
  }
  context.putImageData(pixels, entry.x, entry.y);
}

function loadMask(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the editable mask."));
    image.src = resolveAssetUrl(source);
  });
}

export function imageToAlphaMask(image: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) throw new Error("Mask editing is unavailable in this renderer.");
  sourceContext.drawImage(image, 0, 0, width, height);
  const pixels = sourceContext.getImageData(0, 0, width, height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const alpha = Math.max(pixels.data[index], pixels.data[index + 1], pixels.data[index + 2]);
    pixels.data[index] = 255;
    pixels.data[index + 1] = 255;
    pixels.data[index + 2] = 255;
    pixels.data[index + 3] = alpha;
  }
  sourceContext.clearRect(0, 0, width, height);
  sourceContext.putImageData(pixels, 0, 0);
  return source;
}

export const MaskEditorOverlay = forwardRef<MaskEditorHandle, Props>(function MaskEditorOverlay(
  { target, width, height, displaySize, mode, brushSize, blurRadius, onDirtyChange, onHistoryChange, onReadyChange, onError },
  ref
) {
  const { t, layerName } = useAppTranslation();
  const visibleRef = useRef<HTMLCanvasElement>(null);
  const workRef = useRef<HTMLCanvasElement | null>(null);
  const initialRef = useRef<ImageData | null>(null);
  const initialAlphaRef = useRef<Uint8ClampedArray | null>(null);
  const readyRef = useRef(false);
  const strokeRef = useRef<{ x: number; y: number } | null>(null);
  const strokeStartRef = useRef<Uint8ClampedArray | null>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const historyIndexRef = useRef(0);
  const historyBytesRef = useRef(0);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const visualsRef = useRef({ mode, brushSize, blurRadius, displaySize });
  visualsRef.current = { mode, brushSize, blurRadius, displaySize };
  const callbacksRef = useRef({ onDirtyChange, onHistoryChange, onReadyChange, onError });
  callbacksRef.current = { onDirtyChange, onHistoryChange, onReadyChange, onError };

  const renderMask = useCallback(() => {
    const visible = visibleRef.current;
    const work = workRef.current;
    const context = visible?.getContext("2d");
    if (!visible || !work || !context) return;
    context.clearRect(0, 0, width, height);
    context.save();
    context.globalAlpha = 0.5;
    context.filter = visualsRef.current.blurRadius > 0 ? `blur(${visualsRef.current.blurRadius}px)` : "none";
    context.drawImage(work, 0, 0, width, height);
    context.restore();
    const cursor = cursorRef.current;
    if (cursor) {
      const displayWidth = Math.max(1, visualsRef.current.displaySize[0]);
      const pixelScale = width / displayWidth;
      context.save();
      context.beginPath();
      context.arc(cursor.x, cursor.y, visualsRef.current.brushSize / 2, 0, Math.PI * 2);
      context.strokeStyle = "rgba(0, 0, 0, 0.9)";
      context.lineWidth = Math.max(2, pixelScale * 3);
      context.stroke();
      context.beginPath();
      context.arc(cursor.x, cursor.y, visualsRef.current.brushSize / 2, 0, Math.PI * 2);
      context.strokeStyle = visualsRef.current.mode === "add" ? "#c7ff59" : "#ff9d86";
      context.lineWidth = Math.max(1, pixelScale);
      context.stroke();
      context.restore();
    }
  }, [height, width]);

  useEffect(() => {
    renderMask();
  }, [blurRadius, brushSize, displaySize, mode, renderMask]);

  const notifyHistory = useCallback((currentAlpha?: Uint8ClampedArray) => {
    const context = workRef.current?.getContext("2d", { willReadFrequently: true });
    const initial = initialAlphaRef.current;
    let dirty = false;
    if (context && initial) {
      const current = currentAlpha ?? readAlpha(context, width, height);
      dirty = current.some((value, index) => value !== initial[index]);
    }
    callbacksRef.current.onDirtyChange(dirty);
    callbacksRef.current.onHistoryChange({
      canUndo: historyIndexRef.current > 0,
      canRedo: historyIndexRef.current < historyRef.current.length
    });
  }, [height, width]);

  const commitHistory = useCallback((before: Uint8ClampedArray, after: Uint8ClampedArray) => {
    const entry = changedRegion(before, after, width, height);
    if (!entry) {
      notifyHistory(after);
      return;
    }
    if (historyIndexRef.current < historyRef.current.length) {
      const removed = historyRef.current.splice(historyIndexRef.current);
      historyBytesRef.current -= removed.reduce((total, item) => total + item.before.byteLength + item.after.byteLength, 0);
    }
    historyRef.current.push(entry);
    historyIndexRef.current += 1;
    historyBytesRef.current += entry.before.byteLength + entry.after.byteLength;
    while (
      // Bound both action count and raw pixel memory; whichever limit is hit
      // first removes the oldest entry while keeping the current cursor valid.
      historyRef.current.length > 1 &&
      (historyRef.current.length > MAX_HISTORY_ACTIONS || historyBytesRef.current > MAX_HISTORY_BYTES)
    ) {
      const removed = historyRef.current.shift();
      if (!removed) break;
      historyIndexRef.current -= 1;
      historyBytesRef.current -= removed.before.byteLength + removed.after.byteLength;
    }
    notifyHistory(after);
  }, [height, notifyHistory, width]);

  const undo = useCallback(() => {
    const context = workRef.current?.getContext("2d", { willReadFrequently: true });
    if (!context || historyIndexRef.current === 0) return;
    const entry = historyRef.current[historyIndexRef.current - 1];
    writeAlphaRegion(context, entry, entry.before);
    historyIndexRef.current -= 1;
    renderMask();
    notifyHistory();
  }, [notifyHistory, renderMask]);

  const redo = useCallback(() => {
    const context = workRef.current?.getContext("2d", { willReadFrequently: true });
    if (!context || historyIndexRef.current >= historyRef.current.length) return;
    const entry = historyRef.current[historyIndexRef.current];
    writeAlphaRegion(context, entry, entry.after);
    historyIndexRef.current += 1;
    renderMask();
    notifyHistory();
  }, [notifyHistory, renderMask]);

  useEffect(() => {
    // Each target gets a fresh working canvas and history. The cancellation
    // flag prevents a slow image load from reviving an editor that was closed.
    let cancelled = false;
    readyRef.current = false;
    callbacksRef.current.onReadyChange(false);
    callbacksRef.current.onDirtyChange(false);
    callbacksRef.current.onHistoryChange({ canUndo: false, canRedo: false });
    strokeRef.current = null;
    strokeStartRef.current = null;
    historyRef.current = [];
    historyIndexRef.current = 0;
    historyBytesRef.current = 0;
    void (async () => {
      try {
        const work = document.createElement("canvas");
        work.width = width;
        work.height = height;
        const context = work.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Mask editing is unavailable in this renderer.");
        if (target.maskUrl) {
          const image = await loadMask(target.maskUrl);
          context.drawImage(imageToAlphaMask(image, width, height), 0, 0);
        }
        if (cancelled) return;
        workRef.current = work;
        initialRef.current = context.getImageData(0, 0, width, height);
        initialAlphaRef.current = readAlpha(context, width, height);
        readyRef.current = true;
        callbacksRef.current.onReadyChange(true);
        renderMask();
      } catch (error) {
        if (!cancelled) callbacksRef.current.onError(error instanceof Error ? error.message : "Could not prepare the mask editor.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [height, renderMask, target.key, target.maskUrl, width]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const targetElement = event.target as HTMLElement | null;
      if (targetElement?.matches("input, textarea, select, [contenteditable='true']")) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  }, [redo, undo]);

  useImperativeHandle(ref, () => ({
    exportMask: async () => {
      const work = workRef.current;
      if (!work || !readyRef.current) throw new Error("Wait for the mask to finish loading.");
      const output = document.createElement("canvas");
      output.width = width;
      output.height = height;
      const context = output.getContext("2d");
      if (!context) throw new Error("Mask export is unavailable in this renderer.");
      context.fillStyle = "black";
      context.fillRect(0, 0, width, height);
      context.filter = blurRadius > 0 ? `blur(${blurRadius}px)` : "none";
      context.drawImage(work, 0, 0);
      context.filter = "none";
      // Encoding is asynchronous, so callers can keep the UI responsive while
      // the exact alpha mask is transferred to the service.
      return new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("The edited mask could not be encoded."))),
          "image/png"
        )
      );
    },
    reset: () => {
      const context = workRef.current?.getContext("2d");
      if (!context || !initialRef.current) return;
      const before = readAlpha(context, width, height);
      context.clearRect(0, 0, width, height);
      context.putImageData(initialRef.current, 0, 0);
      renderMask();
      commitHistory(before, readAlpha(context, width, height));
    },
    undo,
    redo
  }));

  function position(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * width,
      y: ((event.clientY - bounds.top) / bounds.height) * height
    };
  }

  function paint(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const context = workRef.current?.getContext("2d");
    if (!context || !readyRef.current) return;
    context.save();
    context.globalCompositeOperation = mode === "add" ? "source-over" : "destination-out";
    context.strokeStyle = "white";
    context.fillStyle = "white";
    context.lineWidth = brushSize;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.beginPath();
    context.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    callbacksRef.current.onDirtyChange(true);
    renderMask();
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!readyRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = position(event);
    cursorRef.current = point;
    strokeRef.current = point;
    const context = workRef.current?.getContext("2d", { willReadFrequently: true });
    strokeStartRef.current = context ? readAlpha(context, width, height) : null;
    paint(point, point);
  }

  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const point = position(event);
    cursorRef.current = point;
    if (!strokeRef.current) {
      renderMask();
      return;
    }
    paint(strokeRef.current, point);
    strokeRef.current = point;
  }

  function pointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    strokeRef.current = null;
    const context = workRef.current?.getContext("2d", { willReadFrequently: true });
    if (context && strokeStartRef.current) {
      commitHistory(strokeStartRef.current, readAlpha(context, width, height));
    }
    strokeStartRef.current = null;
  }

  function pointerLeave(): void {
    if (strokeRef.current) return;
    cursorRef.current = null;
    renderMask();
  }

  return (
    <canvas
      ref={visibleRef}
      width={width}
      height={height}
      className="mask-editor-canvas"
      style={{ width: `${displaySize[0]}px`, height: `${displaySize[1]}px` }}
      aria-label={t("scene.brushEditor", { name: layerName(target.name) })}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      onPointerLeave={pointerLeave}
    />
  );
});
