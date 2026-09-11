import type { CameraState } from "../types";
import { useAppTranslation } from "../i18n";

interface Props {
  camera: CameraState;
  moving: boolean;
  onChange: (camera: CameraState) => void;
  onToggleMotion: () => void;
  onReset: () => void;
}

interface RangeProps {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}

function Range({ label, value, minimum, maximum, step, display, onChange }: RangeProps) {
  return (
    <label className="control-row">
      <span title={label}>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={minimum}
        max={maximum}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{display}</output>
    </label>
  );
}

export function CameraControls({ camera, moving, onChange, onToggleMotion, onReset }: Props) {
  // All camera controls emit a complete bounded state object so the canvas can
  // render immediately without maintaining a second source of truth.
  const { t } = useAppTranslation();
  return (
    <section className="camera-panel" aria-label={t("camera.controls")}>
      <div className="panel-heading compact-heading">
        <div>
          <span className="eyebrow">{t("camera.title")}</span>
          <h2>{t("camera.rig")}</h2>
        </div>
        <p className="camera-export-note">{t("camera.exportMotionHint")}</p>
        <div className="camera-heading-actions">
          <button type="button" className={`motion-button compact-motion ${moving ? "active" : ""}`} onClick={onToggleMotion}>
            <span className="motion-dot" /> {moving ? t("camera.stop") : t("camera.preview")}
          </button>
          <button type="button" className="text-button" onClick={onReset}>{t("camera.reset")}</button>
        </div>
      </div>
      <div className="camera-control-groups">
        <section className="camera-control-group" aria-label={t("camera.viewGroup")}>
          <strong className="camera-control-group-title">{t("camera.viewGroup")}</strong>
          <Range label={t("camera.horizontal")} value={camera.x} minimum={-1} maximum={1} step={0.01} display={camera.x.toFixed(2)} onChange={(x) => onChange({ ...camera, x })} />
          <Range label={t("camera.vertical")} value={camera.y} minimum={-1} maximum={1} step={0.01} display={camera.y.toFixed(2)} onChange={(y) => onChange({ ...camera, y })} />
          <Range label={t("camera.zoom")} value={camera.zoom} minimum={1} maximum={1.35} step={0.01} display={`${camera.zoom.toFixed(2)}x`} onChange={(zoom) => onChange({ ...camera, zoom })} />
        </section>
        <section className="camera-control-group" aria-label={t("camera.depthGroup")}>
          <strong className="camera-control-group-title">{t("camera.depthGroup")}</strong>
          <Range label={t("camera.strength")} value={camera.strength} minimum={0} maximum={100} step={1} display={`${Math.round(camera.strength)}%`} onChange={(strength) => onChange({ ...camera, strength })} />
          <Range label={t("camera.centerPull")} value={camera.centerPull ?? 0.5} minimum={0} maximum={1} step={0.01} display={`${Math.round((camera.centerPull ?? 0.5) * 100)}%`} onChange={(centerPull) => onChange({ ...camera, centerPull })} />
          <Range label={t("camera.sceneScale")} value={camera.sceneScale ?? 1} minimum={0.5} maximum={2} step={0.01} display={`${(camera.sceneScale ?? 1).toFixed(2)}x`} onChange={(sceneScale) => onChange({ ...camera, sceneScale })} />
        </section>
        <section className="camera-control-group camera-focus-group" aria-label={t("camera.lensGroup")}>
          <strong className="camera-control-group-title">{t("camera.lensGroup")}</strong>
          <Range label={t("camera.depthOfField")} value={camera.depthOfField ?? 0} minimum={0} maximum={24} step={0.5} display={`${(camera.depthOfField ?? 0).toFixed(1)}px`} onChange={(depthOfField) => onChange({ ...camera, depthOfField })} />
          <Range label={t("camera.focusDepth")} value={camera.focusDepth ?? 1} minimum={0} maximum={1} step={0.01} display={`${Math.round((camera.focusDepth ?? 1) * 100)}%`} onChange={(focusDepth) => onChange({ ...camera, focusDepth })} />
          <small className="camera-control-note">{t("camera.dofHelp")}</small>
        </section>
      </div>
    </section>
  );
}
