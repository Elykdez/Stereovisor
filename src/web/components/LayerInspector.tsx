import { resolveAssetUrl } from "../lib/api";
import { useAppTranslation } from "../i18n";
import type { InpaintHistoryState, SceneLayer, WorkflowPhase } from "../types";

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
  maskHistory: Record<string, InpaintHistoryState>;
  maskHistoryBusy: { layerId: string; action: "undo" | "redo" } | null;
  onEditMask: (layer: SceneLayer) => void;
  onRefineMask: (layer: SceneLayer) => void;
  onUndoRefine: (layerId: string) => void;
  onRedoRefine: (layerId: string) => void;
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
  maskHistory,
  maskHistoryBusy,
  onEditMask,
  onRefineMask,
  onUndoRefine,
  onRedoRefine,
  onConfirmMask,
  onInpaintTarget,
  onFocusTarget,
  onChange
}: Props) {
  const { t, layerName } = useAppTranslation();
  const selecting = phase === "selecting";
  const maskOperationActive = editingLayerId !== null || inpaintingTargetId !== null || refiningLayerId !== null || confirmingLayerId !== null;

  function update(id: string, change: Partial<SceneLayer>): void {
    // Keep layer edits immutable; App owns the project snapshot and merges this
    // small change with the rest of the scene state.
    onChange(layers.map((layer) => (layer.id === id ? { ...layer, ...change } : layer)));
  }

  return (
    <section className="layers-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{selecting ? t("layers.proposals") : t("layers.sceneStack")}</span>
          <h2>{t("layers.foregroundCount", { count: layers.length })}</h2>
        </div>
        <span className="count-badge">{t("layers.onCount", { count: layers.filter((layer) => selecting ? layer.selected : layer.visible).length })}</span>
      </div>
      <p className="panel-note">
        {selecting
          ? t("layers.selectingHelp")
          : t("layers.editingHelp")}
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
              <strong>{t("layers.background")}</strong>
              <span>{t("layers.backgroundDetail")}</span>
            </div>
            <span className="mask-state confirmed">{t("layers.sceneLayer")}</span>
            <button
              type="button"
              className="mask-edit-button inpaint"
              disabled={maskOperationActive || !layerInpaintAvailable}
              title={layerInpaintAvailable ? t("layers.paintBackgroundTitle") : t("layers.powerpaintRequired")}
              onClick={() => {
                onFocusTarget("background");
                onInpaintTarget(null);
              }}
            >
              {inpaintingTargetId === "background" ? t("layers.painting") : t("layers.inpaint")}
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
                aria-label={t(enabled ? "layers.disable" : "layers.enable", { name: layerName(layer.name) })}
                disabled={maskOperationActive}
                onClick={() => {
                  if (!selecting) onFocusTarget(layer.id);
                  update(layer.id, selecting ? { selected: !enabled } : { visible: !enabled });
                }}
              >
                <img src={resolveAssetUrl(selecting ? layer.maskUrl : layer.cutoutUrl)} alt="" />
                <span className="toggle-indicator">{enabled ? t("layers.on") : t("layers.off")}</span>
              </button>
              <div className="layer-meta">
                <strong>{layerName(layer.name)}</strong>
                <span>{layer.kind === "depth-plane" ? t("layers.depthPlane") : `${Math.round(layer.confidence * 100)}%`} / {t("layers.depth", { value: Math.round(layer.depth * 100) })}</span>
              </div>
              {selecting && (
                <span className={`mask-state ${layer.confirmed ? "confirmed" : layer.refinementState}`}>
                  {layer.confirmed ? t("layers.confirmed") : layer.refinementState === "refined" ? t("layers.refined") : t("layers.rough")}
                </span>
              )}
              {!selecting && (
                <div className="scene-layer-controls">
                  <label className="depth-control">
                    <span className="sr-only">{t("layers.depthLabel", { name: layerName(layer.name) })}</span>
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
                    title={layerInpaintAvailable ? t("layers.paintLayerTitle", { name: layerName(layer.name) }) : t("layers.powerpaintRequired")}
                    onClick={() => {
                      onFocusTarget(layer.id);
                      onInpaintTarget(layer.id);
                    }}
                  >
                    {inpaintingTargetId === layer.id ? t("layers.painting") : t("layers.inpaint")}
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
                    {editingLayerId === layer.id ? t("layers.editing") : t("layers.edit")}
                  </button>
                  <button
                    type="button"
                    className="mask-edit-button refine"
                    disabled={!enabled || maskOperationActive || !aiRefineAvailable}
                    title={aiRefineAvailable ? t("layers.refineTitle") : t("layers.refineRequiresAI")}
                    onClick={() => onRefineMask(layer)}
                  >
                    {refiningLayerId === layer.id ? t("layers.refining") : t("mask.refine")}
                  </button>
                  {maskHistory[layer.id] && (maskHistory[layer.id].canUndo || maskHistory[layer.id].canRedo) && (
                    <>
                      <button
                        type="button"
                        className="mask-edit-button history"
                        disabled={maskOperationActive || maskHistoryBusy !== null || !maskHistory[layer.id].canUndo}
                        title={t("layers.undoRefineTitle")}
                        onClick={() => onUndoRefine(layer.id)}
                      >
                        {maskHistoryBusy?.layerId === layer.id && maskHistoryBusy.action === "undo" ? t("layers.undoing") : t("layers.undoRefine")}
                      </button>
                      <button
                        type="button"
                        className="mask-edit-button history"
                        disabled={maskOperationActive || maskHistoryBusy !== null || !maskHistory[layer.id].canRedo}
                        title={t("layers.redoRefineTitle")}
                        onClick={() => onRedoRefine(layer.id)}
                      >
                        {maskHistoryBusy?.layerId === layer.id && maskHistoryBusy.action === "redo" ? t("layers.redoing") : t("layers.redoRefine")}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="mask-edit-button confirm"
                    disabled={!enabled || maskOperationActive || layer.confirmed}
                    onClick={() => onConfirmMask(layer)}
                  >
                    {confirmingLayerId === layer.id ? t("layers.confirming") : layer.confirmed ? t("layers.confirmed") : t("layers.confirm")}
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
