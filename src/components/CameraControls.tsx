import type { CameraState } from "../types";

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
      <span>{label}</span>
      <input
        type="range"
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
  return (
    <section className="camera-panel" aria-label="Camera controls">
      <div className="panel-heading compact-heading">
        <div>
          <span className="eyebrow">Camera</span>
          <h2>Parallax rig</h2>
        </div>
        <button type="button" className="text-button" onClick={onReset}>Reset</button>
      </div>
      <Range label="Horizontal" value={camera.x} minimum={-1} maximum={1} step={0.01} display={camera.x.toFixed(2)} onChange={(x) => onChange({ ...camera, x })} />
      <Range label="Vertical" value={camera.y} minimum={-1} maximum={1} step={0.01} display={camera.y.toFixed(2)} onChange={(y) => onChange({ ...camera, y })} />
      <Range label="Zoom" value={camera.zoom} minimum={1} maximum={1.35} step={0.01} display={`${camera.zoom.toFixed(2)}x`} onChange={(zoom) => onChange({ ...camera, zoom })} />
      <Range label="Strength" value={camera.strength} minimum={0} maximum={100} step={1} display={`${Math.round(camera.strength)}%`} onChange={(strength) => onChange({ ...camera, strength })} />
      <button type="button" className={`motion-button ${moving ? "active" : ""}`} onClick={onToggleMotion}>
        <span className="motion-dot" /> {moving ? "Stop motion" : "Preview motion"}
      </button>
    </section>
  );
}
