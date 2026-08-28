import { resolveAssetUrl } from "../lib/api";
import type { SceneLayer, WorkflowPhase } from "../types";

interface Props {
  layers: SceneLayer[];
  phase: WorkflowPhase;
  editingLayerId: string | null;
  refiningLayerId: string | null;
  confirmingLayerId: string | null;
  aiRefineAvailable: boolean;
  backgroundUrl: string | null;
  inpaintingTargetId: string | null;
  focusedTargetId: string | null;
  layerInpaintAvailable: boolean;
  onEditMask: (layer: SceneLayer) => void;
  onRefineMask: (layer: SceneLayer) => void;
  onConfirmMask: (layer: SceneLayer) => void;
  onInpaintTarget: (layerId: string | null) => void;
  onFocusTarget: (targetId: string) => void;
  onChange: (layers: SceneLayer[]) => void;
}

export function LayerInspector({
  layers,
  phase,
  editingLayerId,
  refiningLayerId,
  confirmingLayerId,
  aiRefineAvailable,
  backgroundUrl,
  inpaintingTargetId,
  focusedTargetId,
  layerInpaintAvailable,
  onEditMask,
  onRefineMask,
  onConfirmMask,
  onInpaintTarget,
  onFocusTarget,
  onChange
}: Props) {
  const selecting = phase === "selecting";
  const maskOperationActive = editingLayerId !== null || inpaintingTargetId !== null || refiningLayerId !== null || confirmingLayerId !== null;

  function update(id: string, change: Partial<SceneLayer>): void {
    onChange(layers.map((layer) => (layer.id === id ? { ...layer, ...change } : layer)));
  }

  return (
    <section className="layers-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{selecting ? "Proposals" : "Scene stack"}</span>
          <h2>{layers.length} foreground layers</h2>
        </div>
        <span className="count-badge">{layers.filter((layer) => selecting ? layer.selected : layer.visible).length} on</span>
      </div>
      <p className="panel-note">
        {selecting
          ? "Edit rough proposals, optionally refine their alpha, then confirm every enabled foreground mask."
          : "Near layers move farther. Hide or tune each cutout without rerunning AI."}
      </p>
      <div className="layer-list">
        {!selecting && backgroundUrl && (
          <article
            className={`layer-card enabled background-layer ${inpaintingTargetId === "background" ? "editing" : ""} ${focusedTargetId === "background" ? "focused" : ""}`}
            tabIndex={0}
            aria-current={focusedTargetId === "background" ? "true" : undefined}
            onPointerDown={() => onFocusTarget("background")}
            onFocus={() => onFocusTarget("background")}
          >
            <div className="layer-toggle layer-preview">
              <img src={resolveAssetUrl(backgroundUrl)} alt="" />
              <span className="toggle-indicator">BG</span>
            </div>
            <div className="layer-meta">
              <strong>Background</strong>
              <span>Background plate / 0 depth</span>
            </div>
            <span className="mask-state confirmed">Scene layer</span>
            <button
              type="button"
              className="mask-edit-button inpaint"
              disabled={maskOperationActive || !layerInpaintAvailable}
              title={layerInpaintAvailable ? "Paint an area to fully redraw on the background" : "Layer inpainting requires local PowerPaint"}
              onClick={() => {
                onFocusTarget("background");
                onInpaintTarget(null);
              }}
            >
              {inpaintingTargetId === "background" ? "Painting" : "Inpaint"}
            </button>
          </article>
        )}
        {layers.map((layer) => {
          const enabled = selecting ? layer.selected : layer.visible;
          return (
            <article
              className={`layer-card ${enabled ? "enabled" : ""} ${editingLayerId === layer.id ? "editing" : ""} ${!selecting && focusedTargetId === layer.id ? "focused" : ""}`}
              key={layer.id}
              tabIndex={selecting ? undefined : 0}
              aria-current={!selecting && focusedTargetId === layer.id ? "true" : undefined}
              onPointerDown={() => { if (!selecting) onFocusTarget(layer.id); }}
              onFocus={() => { if (!selecting) onFocusTarget(layer.id); }}
            >
              <button
                type="button"
                className="layer-toggle"
                aria-pressed={enabled}
                aria-label={`${enabled ? "Disable" : "Enable"} ${layer.name}`}
                disabled={maskOperationActive}
                onClick={() => {
                  if (!selecting) onFocusTarget(layer.id);
                  update(layer.id, selecting ? { selected: !enabled } : { visible: !enabled });
                }}
              >
                <img src={resolveAssetUrl(selecting ? layer.maskUrl : layer.cutoutUrl)} alt="" />
                <span className="toggle-indicator">{enabled ? "ON" : "OFF"}</span>
              </button>
              <div className="layer-meta">
                <strong>{layer.name}</strong>
                <span>{layer.kind === "depth-plane" ? "Depth plane" : `${Math.round(layer.confidence * 100)}%`} / {Math.round(layer.depth * 100)} depth</span>
              </div>
              {selecting && (
                <span className={`mask-state ${layer.confirmed ? "confirmed" : layer.refinementState}`}>
                  {layer.confirmed ? "Confirmed" : layer.refinementState === "refined" ? "Refined" : "Rough"}
                </span>
              )}
              {!selecting && (
                <div className="scene-layer-controls">
                  <label className="depth-control">
                    <span className="sr-only">{layer.name} depth</span>
                    <input
                      type="range"
                      min="0.05"
                      max="1"
                      step="0.01"
                      value={layer.depth}
                      onChange={(event) => update(layer.id, { depth: Number(event.target.value) })}
                    />
                  </label>
                  <button
                    type="button"
                    className="mask-edit-button inpaint"
                    disabled={!enabled || maskOperationActive || !layerInpaintAvailable}
                    title={layerInpaintAvailable ? `Paint an area to fully redraw on ${layer.name}` : "Layer inpainting requires local PowerPaint"}
                    onClick={() => {
                      onFocusTarget(layer.id);
                      onInpaintTarget(layer.id);
                    }}
                  >
                    {inpaintingTargetId === layer.id ? "Painting" : "Inpaint"}
                  </button>
                </div>
              )}
              {selecting && (
                <div className="mask-actions">
                  <button
                    type="button"
                    className="mask-edit-button"
                    disabled={!enabled || maskOperationActive}
                    onClick={() => onEditMask(layer)}
                  >
                    {editingLayerId === layer.id ? "Editing" : "Edit"}
                  </button>
                  <button
                    type="button"
                    className="mask-edit-button refine"
                    disabled={!enabled || maskOperationActive || !aiRefineAvailable}
                    title={aiRefineAvailable ? "Refine this rough mask with local mask-guided processing" : "Refine requires the Local AI engine"}
                    onClick={() => onRefineMask(layer)}
                  >
                    {refiningLayerId === layer.id ? "Refining..." : "Refine"}
                  </button>
                  <button
                    type="button"
                    className="mask-edit-button confirm"
                    disabled={!enabled || maskOperationActive || layer.confirmed}
                    onClick={() => onConfirmMask(layer)}
                  >
                    {confirmingLayerId === layer.id ? "Confirming..." : layer.confirmed ? "Confirmed" : "Confirm"}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
