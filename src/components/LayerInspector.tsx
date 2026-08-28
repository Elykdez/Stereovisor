import { resolveAssetUrl } from "../lib/api";
import type { SceneLayer, WorkflowPhase } from "../types";

interface Props {
  layers: SceneLayer[];
  phase: WorkflowPhase;
  onChange: (layers: SceneLayer[]) => void;
}

export function LayerInspector({ layers, phase, onChange }: Props) {
  const selecting = phase === "selecting";

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
          ? "Choose objects to remove from the background and keep as movable foreground."
          : "Near layers move farther. Hide or tune each cutout without rerunning AI."}
      </p>
      <div className="layer-list">
        {layers.map((layer) => {
          const enabled = selecting ? layer.selected : layer.visible;
          return (
            <article className={`layer-card ${enabled ? "enabled" : ""}`} key={layer.id}>
              <button
                type="button"
                className="layer-toggle"
                aria-pressed={enabled}
                aria-label={`${enabled ? "Disable" : "Enable"} ${layer.name}`}
                onClick={() => update(layer.id, selecting ? { selected: !enabled } : { visible: !enabled })}
              >
                <img src={resolveAssetUrl(selecting ? layer.maskUrl : layer.cutoutUrl)} alt="" />
                <span className="toggle-indicator">{enabled ? "ON" : "OFF"}</span>
              </button>
              <div className="layer-meta">
                <strong>{layer.name}</strong>
                <span>{layer.kind === "depth-plane" ? "Depth plane" : `${Math.round(layer.confidence * 100)}%`} / {Math.round(layer.depth * 100)} depth</span>
              </div>
              {!selecting && (
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
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
