import { useEffect, useState } from "react";
import { resolveServiceAsset } from "../lib/api";
import { useAppTranslation } from "../i18n";
import { onServiceOriginChange } from "../lib/serviceOrigin";
import type { InpaintHistoryState, SceneLayer, WorkflowPhase } from "../types";

interface Props {
  layers: SceneLayer[];
  phase: WorkflowPhase;
  inverseDepth?: boolean;
  onInverseDepthChange?: (inverseDepth: boolean) => void;
  editingLayerId: string | null;
  refiningLayerId: string | null;
  confirmingLayerId: string | null;
  backgroundUrl: string | null;
  inpaintingTargetId: string | null;
  focusedTargetId: string | null;
  layerInpaintAvailable: boolean;
  maskHistory: Record<string, InpaintHistoryState>;
  maskHistoryBusy: { layerId: string; action: "undo" | "redo" } | null;
  selectedLayerIds: string[];
  mergeHistory: InpaintHistoryState | null;
  mergeHistoryBusy: "undo" | "redo" | null;
  merging: boolean;
  deletingLayerId: string | null;
  disabled?: boolean;
  onEditMask: (layer: SceneLayer) => void;
  onCancelEdit: () => void;
  onDeleteLayer: (layerId: string) => void;
  onUndoRefine: (layerId: string) => void;
  onRedoRefine: (layerId: string) => void;
  onConfirmMask: (layer: SceneLayer) => void;
  onSelectLayer: (layerId: string) => void;
  onClearSelection: () => void;
  onToggleSelected: () => void;
  onMergeSelected: () => void;
  onUndoMerge: () => void;
  onRedoMerge: () => void;
  onInpaintTarget: (layerId: string | null) => void;
  onFocusTarget: (targetId: string) => void;
  onChange: (layers: SceneLayer[]) => void;
}

function ServiceImage({ source }: { source: string }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let revoke: () => void = () => undefined;
    const load = () => {
      const requested = ++generation;
      void resolveServiceAsset(source)
        .then((asset) => {
          if (disposed || requested !== generation) {
            asset.revoke();
            return;
          }
          revoke();
          revoke = asset.revoke;
          setUrl(asset.url);
        })
        .catch(() => {
          if (!disposed && requested === generation) setUrl("");
        });
    };
    const unsubscribe = onServiceOriginChange(load);
    load();
    return () => {
      disposed = true;
      generation += 1;
      unsubscribe();
      revoke();
    };
  }, [source]);

  return <img src={url || undefined} alt="" />;
}

export function LayerInspector({
  layers,
  phase,
  inverseDepth = false,
  onInverseDepthChange,
  editingLayerId,
  refiningLayerId,
  confirmingLayerId,
  backgroundUrl,
  inpaintingTargetId,
  focusedTargetId,
  layerInpaintAvailable,
  maskHistory,
  maskHistoryBusy,
  selectedLayerIds,
  mergeHistory,
  mergeHistoryBusy,
  merging,
  deletingLayerId,
  disabled: startupBlocked = false,
  onEditMask,
  onCancelEdit,
  onDeleteLayer,
  onUndoRefine,
  onRedoRefine,
  onConfirmMask,
  onSelectLayer,
  onClearSelection,
  onToggleSelected,
  onMergeSelected,
  onUndoMerge,
  onRedoMerge,
  onInpaintTarget,
  onFocusTarget,
  onChange
}: Props) {
  const { t, layerName } = useAppTranslation();
  const selecting = phase === "selecting";
  const disabled = startupBlocked || phase === "inpainting";
  const maskOperationActive = editingLayerId !== null || inpaintingTargetId !== null || refiningLayerId !== null || confirmingLayerId !== null;
  // Cancelling an open editor stays available; a running refine or confirm has
  // to finish first because it is already rewriting that layer's mask.
  const maskJobActive = refiningLayerId !== null || confirmingLayerId !== null;
  const selectionLocked = disabled || maskOperationActive || merging;
  const selected = new Set(selectedLayerIds);

  function update(id: string, change: Partial<SceneLayer>): void {
    if (disabled) return;
    // Keep layer edits immutable; App owns the project snapshot and merges this
    // small change with the rest of the scene state.
    onChange(layers.map((layer) => (layer.id === id ? { ...layer, ...change } : layer)));
  }

  return (
    <section className={`layers-panel ${disabled ? "editor-locked" : ""}`} aria-disabled={disabled}>
      {startupBlocked && <div className="editor-lock-note" role="status">{t("startup.blockedDetail")}</div>}
      <div className="panel-note">
        {selecting
          ? t("layers.selectingHelp")
          : t(inverseDepth ? "camera.inverseDepthHelp" : "layers.editingHelp")}
        {onInverseDepthChange && (
          <label className="settings-toggle layer-depth-toggle" title={t("camera.inverseDepthHelp")}>
            <strong>{t("camera.inverseDepth")}</strong>
            <input
              type="checkbox"
              aria-label={t("camera.inverseDepth")}
              checked={inverseDepth}
              disabled={selectionLocked}
              data-toggle-on={t("layers.on")}
              data-toggle-off={t("layers.off")}
              onChange={(event) => onInverseDepthChange(event.target.checked)}
            />
          </label>
        )}
      </div>
      {selecting && (
        <div className="selection-toolbar" aria-label={t("layers.selectionControls")}>
          <div className="selection-summary">
            <strong>{t("layers.selectionCount", { count: selectedLayerIds.length })}</strong>
            <span>{t("layers.selectionHint")}</span>
          </div>
          <div className="selection-actions">
            <button
              type="button"
              className="mask-edit-button"
              disabled={selectedLayerIds.length === 0 || selectionLocked}
              onClick={onToggleSelected}
            >
              {t("layers.toggleSelected")}
            </button>
            <button
              type="button"
              className="mask-edit-button merge"
              disabled={selectedLayerIds.length < 2 || selectionLocked}
              onClick={onMergeSelected}
            >
              {merging ? t("layers.merging") : t("layers.mergeSelected")}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={selectedLayerIds.length === 0 || selectionLocked}
              onClick={onClearSelection}
            >
              {t("layers.clearSelection")}
            </button>
          </div>
          {mergeHistory && (mergeHistory.canUndo || mergeHistory.canRedo) && (
            <div className="selection-history">
              <button
                type="button"
                className="mask-edit-button history"
                disabled={selectionLocked || mergeHistoryBusy !== null || !mergeHistory.canUndo}
                onClick={onUndoMerge}
                title={t("layers.undoMergeTitle")}
              >
                {mergeHistoryBusy === "undo" ? t("layers.undoing") : t("layers.undoMerge")}
              </button>
              <button
                type="button"
                className="mask-edit-button history"
                disabled={selectionLocked || mergeHistoryBusy !== null || !mergeHistory.canRedo}
                onClick={onRedoMerge}
                title={t("layers.redoMergeTitle")}
              >
                {mergeHistoryBusy === "redo" ? t("layers.redoing") : t("layers.redoMerge")}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="layer-list">
        {!selecting && backgroundUrl && (
          <article
            className={`layer-card enabled background-layer ${inpaintingTargetId === "background" ? "editing" : ""} ${focusedTargetId === "background" ? "focused" : ""}`}
            tabIndex={disabled ? -1 : 0}
            aria-current={focusedTargetId === "background" ? "true" : undefined}
            onPointerDown={() => { if (!disabled) onFocusTarget("background"); }}
            onFocus={() => { if (!disabled) onFocusTarget("background"); }}
          >
            <div className="layer-toggle layer-preview">
              <ServiceImage source={backgroundUrl} />
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
              disabled={disabled || maskOperationActive || !layerInpaintAvailable}
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
          const isSelected = selecting && selected.has(layer.id);
          return (
            <article
              className={`layer-card ${enabled ? "enabled" : ""} ${isSelected ? "selected" : ""} ${editingLayerId === layer.id ? "editing" : ""} ${!selecting && focusedTargetId === layer.id ? "focused" : ""}`}
              key={layer.id}
              tabIndex={selecting ? undefined : disabled ? -1 : 0}
              aria-selected={selecting ? isSelected : undefined}
              aria-current={!selecting && focusedTargetId === layer.id ? "true" : undefined}
              onClick={(event) => {
                if (disabled || !selecting || selectionLocked || (event.target as HTMLElement).closest("button, input, select")) return;
                onSelectLayer(layer.id);
              }}
              onPointerDown={() => { if (!disabled && !selecting) onFocusTarget(layer.id); }}
              onFocus={() => { if (!disabled && !selecting) onFocusTarget(layer.id); }}
            >
              <button
                type="button"
                className="layer-toggle"
                aria-pressed={selecting ? isSelected : enabled}
                aria-label={selecting ? t(isSelected ? "layers.deselect" : "layers.select", { name: layerName(layer.name) }) : t(enabled ? "layers.disable" : "layers.enable", { name: layerName(layer.name) })}
                disabled={disabled || selectionLocked}
                onClick={() => {
                  if (selecting) {
                    onSelectLayer(layer.id);
                    return;
                  }
                  if (!selecting) onFocusTarget(layer.id);
                  update(layer.id, { visible: !enabled });
                }}
              >
                <ServiceImage source={selecting ? layer.maskUrl : layer.cutoutUrl} />
                <span className="toggle-indicator">{enabled ? t("layers.on") : t("layers.off")}</span>
                {isSelected && <span className="toggle-indicator selection-indicator">{t("layers.selected")}</span>}
              </button>
              <div className="layer-meta">
                <strong>{layerName(layer.name)}</strong>
                <span>{layer.kind === "depth-plane"
                  ? t("layers.depthPlane")
                  : layer.kind === "manual"
                    // A hand-brushed layer has no detector confidence to report.
                    ? t("layers.manual")
                    : `${Math.round(layer.confidence * 100)}%`} / {t("layers.depth", { value: Math.round(layer.depth * 100) })}</span>
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
                      disabled={disabled}
                      onChange={(event) => update(layer.id, { depth: Number(event.target.value) })}
                    />
                  </label>
                  <button
                    type="button"
                    className="mask-edit-button inpaint"
                    disabled={disabled || !enabled || maskOperationActive || !layerInpaintAvailable}
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
                  {/* While this layer's mask is open the button closes it
                      again, so a quick look costs one click each way. */}
                  <button
                    type="button"
                    className="mask-edit-button"
                    disabled={disabled || (editingLayerId === layer.id ? maskJobActive : !enabled || maskOperationActive)}
                    title={editingLayerId === layer.id ? t("layers.cancelEditTitle") : undefined}
                    onClick={() => editingLayerId === layer.id ? onCancelEdit() : onEditMask(layer)}
                  >
                    {editingLayerId === layer.id ? t("mask.cancel") : t("layers.edit")}
                  </button>
                  {maskHistory[layer.id] && (maskHistory[layer.id].canUndo || maskHistory[layer.id].canRedo) && (
                    <>
                      <button
                        type="button"
                        className="mask-edit-button history"
                        disabled={disabled || maskOperationActive || maskHistoryBusy !== null || !maskHistory[layer.id].canUndo}
                        title={t("layers.undoRefineTitle")}
                        onClick={() => onUndoRefine(layer.id)}
                      >
                        {maskHistoryBusy?.layerId === layer.id && maskHistoryBusy.action === "undo" ? t("layers.undoing") : t("layers.undoRefine")}
                      </button>
                      <button
                        type="button"
                        className="mask-edit-button history"
                        disabled={disabled || maskOperationActive || maskHistoryBusy !== null || !maskHistory[layer.id].canRedo}
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
                    disabled={disabled || !enabled || maskOperationActive || layer.confirmed}
                    onClick={() => onConfirmMask(layer)}
                  >
                    {confirmingLayerId === layer.id ? t("layers.confirming") : layer.confirmed ? t("layers.confirmed") : t("layers.confirm")}
                  </button>
                  <button
                    type="button"
                    className="mask-edit-button delete"
                    disabled={disabled || maskOperationActive || deletingLayerId !== null}
                    title={t("layers.deleteTitle", { name: layerName(layer.name) })}
                    onClick={() => onDeleteLayer(layer.id)}
                  >
                    {deletingLayerId === layer.id ? t("layers.deleting") : t("layers.delete")}
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
