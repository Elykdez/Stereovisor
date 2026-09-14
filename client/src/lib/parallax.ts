import type { CameraState } from "../types";

export interface LayerTransform {
  x: number;
  y: number;
  scale: number;
}

export interface DemoMotionSettings {
  speed: number;
  horizontalAmount: number;
  verticalAmount: number;
}

export const DEFAULT_DEMO_MOTION: DemoMotionSettings = {
  speed: 1,
  horizontalAmount: 0.72,
  verticalAmount: 0.22,
};

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function depthOfFieldBlur(camera: CameraState, depth: number): number {
  const maximumBlur = clamp(camera.depthOfField ?? 0, 0, 24);
  const focusDepth = clamp(camera.focusDepth ?? 1, 0, 1);
  return maximumBlur * Math.abs(clamp(depth, 0, 1) - focusDepth);
}

export function renderedLayerBlur(camera: CameraState, depth: number, adjustment = 0): number {
  // Per-layer blur is deliberately a signed, non-destructive correction. A
  // camera change never writes back to the layer and the final clamp happens
  // only at render time.
  return clamp(depthOfFieldBlur(camera, depth) + clamp(adjustment, -24, 24), 0, 24);
}

export interface LayerAnchor {
  offsetX: number;
  offsetY: number;
  bounds?: [number, number, number, number];
  centerPull?: number;
  scale?: number;
}

export const NO_ANCHOR: LayerAnchor = { offsetX: 0, offsetY: 0 };

export function layerTransform(
  camera: CameraState,
  depth: number,
  width: number,
  height: number,
  anchor: LayerAnchor = NO_ANCHOR,
  sourceSize: [number, number] = [width, height],
): LayerTransform {
  // Depth affects both lateral travel and a tiny scale correction; clamping
  // keeps malformed imported layer values from producing runaway transforms.
  const normalizedDepth = clamp(camera.inverseDepth ? 1 - depth : depth, 0, 1);
  const travel = camera.strength * 0.0015 * normalizedDepth;
  // 50% is neutral; the lower half pushes bounds away from center and the
  // upper half pulls them toward center.
  const centerPull = clamp(
    (clamp(camera.centerPull ?? 0.5, 0, 1) - 0.5) * 2 +
    (clamp(anchor.centerPull ?? 0.5, 0, 1) - 0.5) * 2,
    -1, 1,
  );
  const sceneScale = clamp(camera.sceneScale ?? 1, 0.5, 2);
  const baseScale = sceneScale * camera.zoom * (1 + normalizedDepth * (camera.zoom - 1) * 0.08);
  const scale = baseScale * clamp(anchor.scale ?? 1, 0.5, 2);
  const [sourceWidth, sourceHeight] = sourceSize;
  const bounds = anchor.bounds;
  const boundsCenterX = bounds ? (bounds[0] + bounds[2]) / 2 : sourceWidth / 2;
  const boundsCenterY = bounds ? (bounds[1] + bounds[3]) / 2 : sourceHeight / 2;
  const boundsOffsetX = (sourceWidth / 2 - boundsCenterX) / Math.max(1, sourceWidth) * width;
  const boundsOffsetY = (sourceHeight / 2 - boundsCenterY) / Math.max(1, sourceHeight) * height;
  const centerX = boundsOffsetX * centerPull * scale;
  const centerY = boundsOffsetY * centerPull * scale;
  // The anchor is a plain composition-space nudge: it rides along with the
  // parallax travel rather than replacing it, so a repositioned layer still
  // moves with the camera.
  return {
    x: -camera.x * travel * width + clamp(anchor.offsetX, -1, 1) * width + centerX,
    y: -camera.y * travel * height + clamp(anchor.offsetY, -1, 1) * height + centerY,
    scale,
  };
}

export function backgroundTransform(camera: CameraState): LayerTransform {
  if (camera.inverseDepth) {
    const transform = layerTransform(camera, 0, 1, 1);
    // The background now travels most. Cover the exposed edge on either side.
    return { ...transform, scale: transform.scale + 2 * Math.max(Math.abs(transform.x), Math.abs(transform.y)) };
  }
  const displacement = Math.max(Math.abs(camera.x), Math.abs(camera.y));
  const overscan = 1 + camera.strength * 0.0007 * displacement;
  return {
    x: camera.x * camera.strength * 0.00012,
    y: camera.y * camera.strength * 0.00012,
    scale: clamp(camera.sceneScale ?? 1, 0.5, 2) * camera.zoom * overscan,
  };
}

export function visibleLayers<
  T extends { visible: boolean; depth: number; order: number },
>(layers: T[]): T[] {
  // Stable depth/order sorting determines the painter's order for the final
  // composition and is shared by the interactive canvas and video export.
  return layers
    .filter((layer) => layer.visible)
    .slice()
    .sort((a, b) => a.depth - b.depth || a.order - b.order);
}

export function demoCameraAt(
  camera: CameraState,
  progress: number,
  motion: DemoMotionSettings = DEFAULT_DEMO_MOTION,
): CameraState {
  const angle = clamp(progress, 0, 1) * Math.PI * 2 * clamp(motion.speed, 0.2, 2);
  return {
    ...camera,
    x: Math.sin(angle) * clamp(motion.horizontalAmount, 0, 1),
    y: Math.sin(angle * 2) * clamp(motion.verticalAmount, 0, 1),
  };
}

export function fitVideoDimensions(
  width: number,
  height: number,
  maximumEdge = 1280,
): [number, number] {
  // Video encoders commonly require even dimensions. Downscale only when the
  // source exceeds the requested edge; never upscale a small source.
  const scale = Math.min(1, maximumEdge / Math.max(width, height));
  return [
    Math.max(2, Math.floor((width * scale) / 2) * 2),
    Math.max(2, Math.floor((height * scale) / 2) * 2),
  ];
}

export function fitCanvasDimensions(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
): [number, number] {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  )
    return [0, 0];
  const scale = Math.min(
    containerWidth / imageWidth,
    containerHeight / imageHeight,
  );
  return [imageWidth * scale, imageHeight * scale];
}
