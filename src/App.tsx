import { useEffect, useRef, useState } from "react";
import { CameraControls } from "./components/CameraControls";
import { LayerInspector } from "./components/LayerInspector";
import { SceneCanvas, type SceneCanvasHandle } from "./components/SceneCanvas";
import { analyzeImage, analyzeSample, exportProjectPackage, getHealth, importProjectPackage, inpaintProject } from "./lib/api";
import type { CameraState, HealthStatus, InpaintRefinement, SceneProject, WorkflowPhase } from "./types";
import "./styles.css";

const DEFAULT_CAMERA: CameraState = { x: 0, y: 0, zoom: 1.04, strength: 68 };

function downloadBlob(blob: Blob, name: string): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

function phaseLabel(phase: WorkflowPhase): string {
  return {
    idle: "Waiting for image",
    analyzing: "Finding and matting objects",
    selecting: "Choose foreground objects",
    inpainting: "Rebuilding hidden background",
    editing: "Scene ready"
  }[phase];
}

export default function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [project, setProject] = useState<SceneProject | null>(null);
  const [phase, setPhase] = useState<WorkflowPhase>("idle");
  const [camera, setCamera] = useState<CameraState>(DEFAULT_CAMERA);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refinement, setRefinement] = useState<InpaintRefinement>("lama");
  const [inpaintPrompt, setInpaintPrompt] = useState("");
  const [fileOperation, setFileOperation] = useState<"import" | "project" | "video" | "png" | null>(null);
  const canvasRef = useRef<SceneCanvasHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const status = await getHealth();
        if (!cancelled) {
          setHealth(status);
          if (status.providers.refinement?.available) setRefinement("powerpaint");
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "The local vision service is unavailable.");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!moving) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMoving(false);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = (time: number) => {
      const elapsed = (time - started) / 1000;
      setCamera((current) => ({
        ...current,
        x: Math.sin(elapsed * 0.72) * 0.74,
        y: Math.sin(elapsed * 0.46 + 0.8) * 0.28
      }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [moving]);

  async function process(operation: () => Promise<SceneProject>): Promise<void> {
    setError(null);
    setMoving(false);
    setPhase("analyzing");
    try {
      const result = await operation();
      setProject(result);
      setCamera(DEFAULT_CAMERA);
      setPhase("selecting");
    } catch (operationError) {
      setPhase(project ? "editing" : "idle");
      setError(operationError instanceof Error ? operationError.message : "Image analysis failed.");
    }
  }

  async function onFile(file: File | undefined): Promise<void> {
    if (!file) return;
    await process(() => analyzeImage(file));
  }

  async function buildScene(): Promise<void> {
    if (!project) return;
    const selected = project.layers.filter((layer) => layer.selected).map((layer) => layer.id);
    if (!selected.length) {
      setError("Select at least one foreground object before building the scene.");
      return;
    }
    if (refinement === "powerpaint" && !inpaintPrompt.trim() && !health?.providers.prompting?.available) {
      setError("Enter a background prompt or finish installing Qwen3-VL before using PowerPaint full redraw.");
      return;
    }
    setError(null);
    setPhase("inpainting");
    try {
      const result = await inpaintProject(project.id, selected, refinement, inpaintPrompt);
      const selectedIds = new Set(selected);
      setProject({
        ...result,
        layers: result.layers.map((layer) => ({ ...layer, visible: selectedIds.has(layer.id), selected: selectedIds.has(layer.id) }))
      });
      setPhase("editing");
    } catch (operationError) {
      setPhase("selecting");
      setError(operationError instanceof Error ? operationError.message : "Background inpainting failed.");
    }
  }

  function updateLayers(layers: SceneProject["layers"]): void {
    if (project) setProject({ ...project, layers });
  }

  async function runFileOperation(
    operation: NonNullable<typeof fileOperation>,
    action: () => Promise<void>
  ): Promise<void> {
    setError(null);
    setFileOperation(operation);
    try {
      await action();
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "The file operation failed.");
    } finally {
      setFileOperation(null);
    }
  }

  async function openProjectFile(file: File | undefined): Promise<void> {
    if (!file) return;
    await runFileOperation("import", async () => {
      const imported = await importProjectPackage(file);
      applyImportedProject(imported.project, imported.camera);
    });
  }

  function applyImportedProject(importedProject: SceneProject, importedCamera: CameraState): void {
    setMoving(false);
    setProject(importedProject);
    setCamera(importedCamera);
    setInpaintPrompt(importedProject.backgroundPrompt ?? "");
    setRefinement(importedProject.inpaintProvider === "powerpaint" ? "powerpaint" : "lama");
    setPhase(importedProject.backgroundUrl ? "editing" : "selecting");
  }

  async function chooseProjectFile(): Promise<void> {
    if (window.stereovisor?.openProject) {
      await runFileOperation("import", async () => {
        const data = await window.stereovisor!.openProject();
        if (!data) return;
        const imported = await importProjectPackage(
          new File([data], "imported.stereovisor", { type: "application/vnd.stereovisor.project+zip" })
        );
        applyImportedProject(imported.project, imported.camera);
      });
      return;
    }
    projectFileRef.current?.click();
  }

  async function saveProjectPackage(): Promise<void> {
    if (!project) return;
    await runFileOperation("project", async () => {
      const blob = await exportProjectPackage(project, camera);
      const name = `stereovisor-${project.id.slice(0, 8)}.stereovisor`;
      if (window.stereovisor?.saveProject) {
        await window.stereovisor.saveProject(await blob.arrayBuffer(), name);
      } else {
        downloadBlob(blob, name);
      }
    });
  }

  async function saveCanvas(kind: "png" | "video"): Promise<void> {
    await runFileOperation(kind, async () => {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("The scene canvas is not ready.");
      await (kind === "png" ? canvas.exportPng() : canvas.exportVideo());
    });
  }

  const busy = phase === "analyzing" || phase === "inpainting" || fileOperation !== null;
  const engine = project?.engine ?? health?.activeEngine;

  return (
    <main className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      void onFile(event.dataTransfer.files[0]);
    }}>
      <header className="topbar">
        <div className="brand-block">
          <img className="brand-mark" src="./app-icon.png" alt="" />
          <div>
            <span className="eyebrow">Local depth studio</span>
            <h1>Stereovisor</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" className="topbar-file-button" disabled={busy} onClick={() => void chooseProjectFile()}>
            {fileOperation === "import" ? "Importing..." : "Import project"}
          </button>
          <span className={`engine-badge ${engine === "ai" ? "ai" : "preview"}`}>
            <span /> {engine === "ai" ? "Local AI" : "Preview engine"}
          </span>
          {project && (
            <button type="button" className="export-button subtle" disabled={busy} onClick={() => void saveProjectPackage()}>
              {fileOperation === "project" ? "Packing..." : "Project file"}
            </button>
          )}
          {phase === "editing" && (
            <>
              <button type="button" className="export-button subtle" disabled={busy} onClick={() => void saveCanvas("video")}>
                {fileOperation === "video" ? "Rendering..." : "Demo WebM"}
              </button>
              <button type="button" className="export-button" disabled={busy} onClick={() => void saveCanvas("png")}>
                {fileOperation === "png" ? "Saving..." : "PNG"}
              </button>
            </>
          )}
        </div>
      </header>

      <aside className="workflow-rail">
        <div className="rail-index">01</div>
        <section className="source-section">
          <span className="eyebrow">Source</span>
          <h2>One image.<br />A scene with depth.</h2>
          <p>Separate objects, rebuild what sits behind them, then direct a virtual camera.</p>
          <input
            ref={fileRef}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          <input
            ref={projectFileRef}
            className="sr-only"
            type="file"
            accept=".stereovisor,application/zip"
            onChange={(event) => {
              void openProjectFile(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button type="button" className="primary-button" disabled={busy} onClick={() => fileRef.current?.click()}>
            Open image
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void process(analyzeSample)}>
            Use sample scene
          </button>
        </section>
        <section className="pipeline-readout" aria-live="polite">
          <span className="eyebrow">Pipeline</span>
          <ol>
            <li className={phase !== "idle" ? "active" : ""}><span>1</span> Segment items</li>
            <li className={["selecting", "inpainting", "editing"].includes(phase) ? "active" : ""}><span>2</span> Refine alpha</li>
            <li className={["inpainting", "editing"].includes(phase) ? "active" : ""}><span>3</span> Inpaint plate</li>
            <li className={phase === "editing" ? "active" : ""}><span>4</span> Direct camera</li>
          </ol>
        </section>
        <div className="local-note">
          <span className="local-pulse" />
          <div><strong>Local only</strong><small>No image upload or cloud inference</small></div>
        </div>
      </aside>

      <section className="workspace">
        {project ? (
          <>
            <div className="stage-header">
              <div>
                <span className="eyebrow">Composition</span>
                <strong>{project.width} x {project.height}</strong>
              </div>
              <span className="phase-label"><i className={busy ? "working" : ""} /> {phaseLabel(phase)}</span>
            </div>
            <SceneCanvas ref={canvasRef} project={project} camera={camera} onCameraChange={setCamera} />
            {phase === "editing" && (
              <CameraControls
                camera={camera}
                moving={moving}
                onChange={(value) => { setMoving(false); setCamera(value); }}
                onToggleMotion={() => setMoving((value) => !value)}
                onReset={() => { setMoving(false); setCamera(DEFAULT_CAMERA); }}
              />
            )}
          </>
        ) : (
          <button type="button" className="empty-stage" onClick={() => fileRef.current?.click()} disabled={busy}>
            <span className="empty-orbit"><i /><i /><i /></span>
            <strong>{busy ? "Analyzing image" : "Drop an image to begin"}</strong>
            <small>{busy ? "The local engine is building layer proposals." : "PNG, JPEG or WebP - up to 40 MB"}</small>
          </button>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>

      <aside className="inspector">
        {project ? (
          <>
            <LayerInspector layers={project.layers} phase={phase} onChange={updateLayers} />
            {phase === "selecting" && (
              <div className="build-panel">
                <div className="build-options">
                  <strong>Build background plate</strong>
                  <label>
                    <span>Local inpainter</span>
                    <select value={refinement} onChange={(event) => setRefinement(event.target.value as InpaintRefinement)}>
                      <option value="powerpaint" disabled={!health?.providers.refinement?.available}>PowerPaint - full redraw</option>
                      <option value="lama">Big LaMa - structural fill</option>
                    </select>
                  </label>
                  {refinement === "powerpaint" && (
                    <>
                      <span className="redraw-note">Full redraw / denoise 1.00. Original masked pixels are discarded.</span>
                      <label>
                        <span>Background prompt (optional)</span>
                        <input
                          type="text"
                          maxLength={500}
                          value={inpaintPrompt}
                          placeholder="Blank uses local Qwen3-VL"
                          onChange={(event) => setInpaintPrompt(event.target.value)}
                        />
                      </label>
                    </>
                  )}
                  {health && !health.providers.refinement?.available && (
                    <span className="redraw-note warning">
                      Full redraw unavailable: {health.providers.refinement?.detail}. Relaunch the one-click setup to resume the checkpoint download.
                    </span>
                  )}
                </div>
                <button type="button" className="primary-button" onClick={() => void buildScene()}>Build scene</button>
              </div>
            )}
            {phase === "inpainting" && <div className="build-panel processing"><span className="spinner" /><div><strong>Inpainting locally</strong><span>The source and masks stay on this machine.</span></div></div>}
          </>
        ) : (
          <div className="inspector-empty">
            <span className="eyebrow">Layer inspector</span>
            <h2>Objects appear here</h2>
            <p>After analysis, choose foreground cutouts and tune their depth.</p>
            <div className="ghost-layer" /><div className="ghost-layer short" /><div className="ghost-layer" />
          </div>
        )}
      </aside>
    </main>
  );
}
