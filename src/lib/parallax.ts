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
  const normalizedDepth = clamp(depth, 0, 1);
  const travel = camera.strength * 0.0015 * normalizedDepth;
  return {
    x: -camera.x * travel * width,
    y: -camera.y * travel * height,
    scale: camera.zoom * (1 + normalizedDepth * (camera.zoom - 1) * 0.08)
  };
}

export function backgroundTransform(camera: CameraState): LayerTransform {
  const overscan = 1 + camera.strength * 0.0007;
  return {
    x: camera.x * camera.strength * 0.00012,
    y: camera.y * camera.strength * 0.00012,
    scale: camera.zoom * overscan
  };
}

export function visibleLayers<T extends { visible: boolean; depth: number; order: number }>(layers: T[]): T[] {
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
  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  return [Math.max(2, Math.floor(width * scale / 2) * 2), Math.max(2, Math.floor(height * scale / 2) * 2)];
}
