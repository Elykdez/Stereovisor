import { useAppTranslation } from "../i18n";
import { depthOfFieldBlur, renderedLayerBlur } from "../lib/parallax";
import { DEFAULT_LAYER_FEATHER, type CameraState, type SceneLayer } from "../types";

interface Props {
  layer: SceneLayer;
  camera: CameraState;
  disabled: boolean;
  onChange: (change: Partial<SceneLayer>) => void;
}

export function LayerAdjustments({ layer, camera, disabled, onChange }: Props) {
  const { t, layerName } = useAppTranslation();
  const automaticBlur = depthOfFieldBlur(camera, layer.depth);
  const finalBlur = renderedLayerBlur(camera, layer.depth, layer.blur ?? 0);
  const controls = [
    { key: "centerPull", label: t("camera.centerPull"), value: layer.centerPull ?? 0.5, min: 0, max: 1, step: 0.01, display: `${Math.round((layer.centerPull ?? 0.5) * 100)}%` },
    { key: "scale", label: t("layers.scale"), value: layer.scale ?? 1, min: 0.5, max: 2, step: 0.01, display: `${(layer.scale ?? 1).toFixed(2)}x` },
    { key: "feather", label: t("layers.feather"), value: layer.feather ?? DEFAULT_LAYER_FEATHER, min: 0, max: 24, step: 1, display: `${layer.feather ?? DEFAULT_LAYER_FEATHER}px` },
    { key: "blur", label: t("layers.blurAdjustment"), value: layer.blur ?? 0, min: -24, max: 24, step: 1, display: `${(layer.blur ?? 0) > 0 ? "+" : ""}${layer.blur ?? 0}px` },
  ] as const;
  return (
    <section className="layer-adjustments" aria-label={t("layers.adjustmentsLabel", { name: layerName(layer.name) })}>
      <div className="layer-adjustments-header">
        <strong>{layerName(layer.name)}</strong>
        <button type="button" className="text-button" disabled={disabled} onClick={() => onChange({ centerPull: 0.5, scale: 1, feather: DEFAULT_LAYER_FEATHER, blur: 0 })}>{t("camera.reset")}</button>
      </div>
      {controls.map((control) => (
        <label className="control-row" key={control.key}>
          <span>{control.label}</span>
          <input type="range" aria-label={`${layerName(layer.name)} ${control.label}`} min={control.min} max={control.max} step={control.step} value={control.value} disabled={disabled} onChange={(event) => onChange({ [control.key]: Number(event.target.value) })} />
          <output>{control.display}</output>
        </label>
      ))}
      <span className="layer-blur-formula">{t("layers.blurFormula", {
        base: automaticBlur.toFixed(1),
        offset: `${(layer.blur ?? 0) > 0 ? "+" : ""}${layer.blur ?? 0}`,
        final: finalBlur.toFixed(1)
      })}</span>
      <span className="redraw-note">{t("layers.featherDetail")}</span>
    </section>
  );
}
