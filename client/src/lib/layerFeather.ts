// Feathering changes only alpha. The separate blur control below can soften
// RGB detail without making the cutout edge transparent in the same way.
const cache = new WeakMap<HTMLImageElement, { radius: number; canvas: HTMLCanvasElement }>();

export function featherLayerImage(image: HTMLImageElement, radius: number): CanvasImageSource {
  if (radius <= 0 || !(image.naturalWidth > 0) || !(image.naturalHeight > 0)) return image;
  const previous = cache.get(image);
  if (previous?.radius === radius) return previous.canvas;
  const output = document.createElement("canvas");
  output.width = image.naturalWidth;
  output.height = image.naturalHeight;
  const context = output.getContext("2d");
  const alpha = document.createElement("canvas");
  alpha.width = output.width;
  alpha.height = output.height;
  const alphaContext = alpha.getContext("2d");
  if (!context || !alphaContext) return image;
  context.drawImage(image, 0, 0);
  alphaContext.filter = `blur(${radius}px)`;
  alphaContext.drawImage(image, 0, 0);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(alpha, 0, 0);
  cache.set(image, { radius, canvas: output });
  return output;
}
