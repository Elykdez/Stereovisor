import type { SceneProject } from "../types";

interface MergeProjectOptions {
  refreshLayerId?: string | null;
  refreshExtra?: boolean;
}

export function refreshedAssetUrl(url: string): string {
  // Asset endpoints are no-store, but an explicit query revision also forces
  // browser image elements to replace a previously decoded mask/cutout.
  return `${url.split("?")[0]}?v=${Date.now()}`;
}

export function mergeProjectResult(
  current: SceneProject | null,
  result: SceneProject,
  { refreshLayerId = null, refreshExtra = false }: MergeProjectOptions = {},
): SceneProject {
  if (!current) return result;
  // Server results carry authoritative generated assets while the renderer
  // preserves local ordering/visibility edits made during the current phase.
  const localLayers = new Map(current.layers.map((layer) => [layer.id, layer]));
  return {
    ...result,
    layers: result.layers.map((layer) => {
      const local = localLayers.get(layer.id);
      return {
        ...layer,
        depth: local?.depth ?? layer.depth,
        order: local?.order ?? layer.order,
        offsetX: local?.offsetX ?? layer.offsetX,
        offsetY: local?.offsetY ?? layer.offsetY,
        feather: local ? local.feather : layer.feather,
        blur: local?.blur ?? layer.blur,
        centerPull: local?.centerPull ?? layer.centerPull,
        scale: local?.scale ?? layer.scale,
        selected: local?.selected ?? layer.selected,
        visible: local?.visible ?? layer.visible,
        maskUrl:
          refreshLayerId === layer.id
            ? refreshedAssetUrl(layer.maskUrl)
            : (local?.maskUrl ?? layer.maskUrl),
        cutoutUrl:
          refreshLayerId === layer.id
            ? refreshedAssetUrl(layer.cutoutUrl)
            : (local?.cutoutUrl ?? layer.cutoutUrl),
        proposalMaskUrl:
          refreshLayerId === layer.id && layer.proposalMaskUrl
            ? refreshedAssetUrl(layer.proposalMaskUrl)
            : (local?.proposalMaskUrl ?? layer.proposalMaskUrl),
      };
    }),
    extraMaskUrl:
      refreshExtra && result.extraMaskUrl
        ? refreshedAssetUrl(result.extraMaskUrl)
        : current.extraMaskUrl,
  };
}
