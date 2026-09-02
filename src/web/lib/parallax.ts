import type { CameraState } from "../types";

export interface LayerTransform {
  x: number;
  y: number;
  scale: number;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function layerTransform(
  camera: CameraState,
  depth: number,
  width: number,
  height: number
): LayerTransform {
  // Depth affects both lateral travel and a tiny scale correction; clamping
  // keeps malformed imported layer values from producing runaway transforms.
  const normalizedDepth = clamp(depth, 0, 1);
  const travel = camera.strength * 0.0015 * normalizedDepth;
  return {
    x: -camera.x * travel * width,
    y: -camera.y * travel * height,
    scale: camera.zoom * (1 + normalizedDepth * (camera.zoom - 1) * 0.08)
  };
}

export function backgroundTransform(camera: CameraState): LayerTransform {
  const displacement = Math.max(Math.abs(camera.x), Math.abs(camera.y));
  const overscan = 1 + camera.strength * 0.0007 * displacement;
  return {
    x: camera.x * camera.strength * 0.00012,
    y: camera.y * camera.strength * 0.00012,
    scale: camera.zoom * overscan
  };
}

export function visibleLayers<T extends { visible: boolean; depth: number; order: number }>(layers: T[]): T[] {
  // Stable depth/order sorting determines the painter's order for the final
  // composition and is shared by the interactive canvas and video export.
  return layers
    .filter((layer) => layer.visible)
    .slice()
    .sort((a, b) => a.depth - b.depth || a.order - b.order);
}

export function demoCameraAt(camera: CameraState, progress: number): CameraState {
  const angle = clamp(progress, 0, 1) * Math.PI * 2;
  return {
    ...camera,
    x: Math.sin(angle) * 0.72,
    y: Math.sin(angle * 2) * 0.22
  };
}

export function fitVideoDimensions(width: number, height: number, maximumEdge = 1280): [number, number] {
  // Video encoders commonly require even dimensions. Downscale only when the
  // source exceeds the requested edge; never upscale a small source.
  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  return [Math.max(2, Math.floor(width * scale / 2) * 2), Math.max(2, Math.floor(height * scale / 2) * 2)];
}

export function fitCanvasDimensions(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number
): [number, number] {
  if (containerWidth <= 0 || containerHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) return [0, 0];
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  return [imageWidth * scale, imageHeight * scale];
}
