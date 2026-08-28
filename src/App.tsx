import { useEffect, useRef, useState } from "react";
import { CameraControls } from "./components/CameraControls";
import { LayerInspector } from "./components/LayerInspector";
import type { MaskBrushMode, MaskEditorTarget } from "./components/MaskEditorOverlay";
import { SceneCanvas, type SceneCanvasHandle } from "./components/SceneCanvas";
import {
  analyzeImage,
  analyzeSample,
  confirmProjectLayer,
  exportProjectPackage,
  getHealth,
  getInpaintHistory,
  importProjectPackage,
  inpaintProject,
  inpaintProjectTarget,
  redoProjectTargetInpaint,
  refineProjectLayer,
  undoProjectTargetInpaint,
  updateProjectMask
} from "./lib/api";
import { mergeProjectResult, refreshedAssetUrl } from "./lib/projectAssets";
import type { CameraState, HealthStatus, InpaintHistoryState, InpaintRefinement, ProcessingProgress, SceneLayer, SceneProject, WorkflowPhase } from "./types";
import "./styles.css";

const DEFAULT_CAMERA: CameraState = { x: 0, y: 0, zoom: 1, strength: 68 };

interface ActiveMaskEditor extends MaskEditorTarget {
  kind: "layer" | "extra" | "inpaint";
  layerId: string | null;
}

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
    analyzing: "Segmenting rough object masks",
    selecting: "Review and confirm masks",
    inpainting: "Running local inpaint",
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
  const [layerInpaintPrompt, setLayerInpaintPrompt] = useState("");
  const [showInpaintMask, setShowInpaintMask] = useState(false);
  const [backgroundRetouchPending, setBackgroundRetouchPending] = useState(false);
  const [maskEditor, setMaskEditor] = useState<ActiveMaskEditor | null>(null);
  const [maskBrushMode, setMaskBrushMode] = useState<MaskBrushMode>("add");
  const [maskBrushSize, setMaskBrushSize] = useState(48);
  const [maskBlurRadius, setMaskBlurRadius] = useState(0);
  const [maskDirty, setMaskDirty] = useState(false);
  const [maskReady, setMaskReady] = useState(false);
  const [maskSaving, setMaskSaving] = useState(false);
  const [maskCanUndo, setMaskCanUndo] = useState(false);
  const [maskCanRedo, setMaskCanRedo] = useState(false);
  const [refiningLayerId, setRefiningLayerId] = useState<string | null>(null);
  const [confirmingLayerId, setConfirmingLayerId] = useState<string | null>(null);
  const [focusedInpaintTargetId, setFocusedInpaintTargetId] = useState<string | null>(null);
  const [inpaintHistory, setInpaintHistory] = useState<Record<string, InpaintHistoryState>>({});
  const [inpaintHistoryBusy, setInpaintHistoryBusy] = useState<"undo" | "redo" | null>(null);
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgress | null>(null);
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

  useEffect(() => {
    if (!project || phase !== "editing") return;
    let cancelled = false;
    void getInpaintHistory(project.id)
      .then((history) => {
        if (!cancelled) setInpaintHistory(Object.fromEntries(history.map((state) => [state.targetId, state])));
      })
      .catch(() => {
        if (!cancelled) setInpaintHistory({});
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id, phase]);

  useEffect(() => {
    if (!project || phase !== "editing" || maskEditor || !focusedInpaintTargetId || inpaintHistoryBusy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return;
      const eventTarget = event.target as HTMLElement | null;
      if (eventTarget?.closest("textarea, select, [contenteditable='true'], input:not([type='range']):not([type='checkbox']):not([type='radio'])")) return;
      const redo = event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey);
      const undo = event.key.toLowerCase() === "z" && !event.shiftKey;
      const state = inpaintHistory[focusedInpaintTargetId];
      if ((!undo || !state?.canUndo) && (!redo || !state?.canRedo)) return;
      event.preventDefault();
      void restoreFocusedInpaint(redo ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [project, phase, maskEditor, focusedInpaintTargetId, inpaintHistory, inpaintHistoryBusy]);

  async function process(
    operation: (onProgress: (progress: ProcessingProgress) => void) => Promise<SceneProject>
  ): Promise<void> {
    setError(null);
    setMoving(false);
    setLayerInpaintPrompt("");
    setShowInpaintMask(false);
    setBackgroundRetouchPending(false);
    setFocusedInpaintTargetId(null);
    setInpaintHistory({});
    setMaskBlurRadius(0);
    setMaskEditor(null);
    setPhase("analyzing");
    setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: "Preparing the local AI job." });
    try {
      const result = await operation(setProcessingProgress);
      setProject(result);
      setCamera(DEFAULT_CAMERA);
      setPhase("selecting");
    } catch (operationError) {
      setPhase(project ? "editing" : "idle");
      setError(operationError instanceof Error ? operationError.message : "Image analysis failed.");
    } finally {
      setProcessingProgress(null);
    }
  }

  async function onFile(file: File | undefined): Promise<void> {
    if (!file) return;
    await process((onProgress) => analyzeImage(file, onProgress));
  }

  async function buildScene(): Promise<void> {
    if (!project) return;
    if (maskEditor || refiningLayerId) {
      setError("Finish the active mask edit or refinement before inpainting.");
      return;
    }
    const selectedLayers = project.layers.filter((layer) => layer.selected);
    const selected = selectedLayers.map((layer) => layer.id);
    if (!selected.length) {
      setError("Select at least one foreground object before building the scene.");
      return;
    }
    const unconfirmed = selectedLayers.filter((layer) => !layer.confirmed);
    if (unconfirmed.length) {
      setError(`Confirm every selected mask before inpainting: ${unconfirmed.map((layer) => layer.name).join(", ")}.`);
      return;
    }
    if (refinement === "powerpaint" && !inpaintPrompt.trim() && !health?.providers.prompting?.available) {
      setError("Enter a background prompt or finish installing Qwen3-VL before using PowerPaint full redraw.");
      return;
    }
    setError(null);
    setShowInpaintMask(false);
    setPhase("inpainting");
    setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: "Preparing the local inpainting job." });
    try {
      const result = await inpaintProject(project.id, selected, refinement, inpaintPrompt, setProcessingProgress);
      const selectedIds = new Set(selected);
      const mergedResult = mergeProjectResult(project, result);
      const merged = result.backgroundUrl
        ? { ...mergedResult, backgroundUrl: refreshedAssetUrl(result.backgroundUrl) }
        : mergedResult;
      setProject({
        ...merged,
        layers: merged.layers.map((layer) => ({ ...layer, visible: selectedIds.has(layer.id), selected: selectedIds.has(layer.id) }))
      });
      setBackgroundRetouchPending(false);
      setFocusedInpaintTargetId("background");
      setPhase("editing");
    } catch (operationError) {
      setPhase("selecting");
      setError(operationError instanceof Error ? operationError.message : "Background inpainting failed.");
    } finally {
      setProcessingProgress(null);
    }
  }

  function updateLayers(layers: SceneProject["layers"]): void {
    if (project) setProject({ ...project, layers });
  }

  function editLayerMask(layer: SceneLayer): void {
    setError(null);
    setMoving(false);
    setCamera(DEFAULT_CAMERA);
    setShowInpaintMask(false);
    setMaskBrushMode("add");
    setMaskBlurRadius(0);
    setMaskDirty(false);
    setMaskReady(false);
    setMaskCanUndo(false);
    setMaskCanRedo(false);
    setMaskEditor({ kind: "layer", layerId: layer.id, key: `layer:${layer.id}`, name: layer.name, maskUrl: layer.maskUrl });
  }

  function editExtraMask(): void {
    if (!project) return;
    setError(null);
    setMoving(false);
    setCamera(DEFAULT_CAMERA);
    setShowInpaintMask(false);
    setMaskBrushMode("add");
    setMaskBlurRadius(0);
    setMaskDirty(false);
    setMaskReady(false);
    setMaskCanUndo(false);
    setMaskCanRedo(false);
    setMaskEditor({
      kind: "extra",
      layerId: null,
      key: "extra-inpaint-area",
      name: "extra inpaint area",
      maskUrl: project.extraMaskUrl ?? null
    });
  }

  function editInpaintTarget(layerId: string | null): void {
    if (!project?.backgroundUrl) return;
    const layer = layerId ? project.layers.find((candidate) => candidate.id === layerId) : null;
    if (layerId && !layer) {
      setError("The selected scene layer no longer exists.");
      return;
    }
    if (!health?.providers.refinement?.available) {
      setError("Layer inpainting requires the local PowerPaint full-redraw model.");
      return;
    }
    const name = layer?.name ?? "Background";
    setFocusedInpaintTargetId(layerId ?? "background");
    setError(null);
    setMoving(false);
    setCamera(DEFAULT_CAMERA);
    setShowInpaintMask(false);
    setMaskBrushMode("add");
    setMaskBlurRadius(0);
    setMaskDirty(false);
    setMaskReady(false);
    setMaskCanUndo(false);
    setMaskCanRedo(false);
    setMaskEditor({
      kind: "inpaint",
      layerId,
      key: `inpaint:${layerId ?? "background"}:${Date.now()}`,
      name: `${name} inpaint area`,
      maskUrl: null
    });
  }

  function cancelMaskEdit(): void {
    setMaskEditor(null);
    setMaskBlurRadius(0);
    setMaskDirty(false);
    setMaskReady(false);
    setMaskCanUndo(false);
    setMaskCanRedo(false);
  }

  async function refineLayerMask(layer: SceneLayer): Promise<void> {
    if (!project) return;
    if (project.engine !== "ai") {
      setError("Refine requires the Local AI engine and InSPyReNet.");
      return;
    }
    setError(null);
    setMoving(false);
    setShowInpaintMask(false);
    setRefiningLayerId(layer.id);
    setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: `Preparing ${layer.name} for local refinement.` });
    try {
      const result = await refineProjectLayer(project.id, layer.id, setProcessingProgress);
      setProject(mergeProjectResult(project, result, { refreshLayerId: layer.id }));
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "The selected mask could not be refined.");
    } finally {
      setRefiningLayerId(null);
      setProcessingProgress(null);
    }
  }

  async function confirmLayer(layer: SceneLayer): Promise<void> {
    if (!project) return;
    setError(null);
    setConfirmingLayerId(layer.id);
    try {
      const result = await confirmProjectLayer(project.id, layer.id);
      setProject(mergeProjectResult(project, result));
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "The selected mask could not be confirmed.");
    } finally {
      setConfirmingLayerId(null);
    }
  }

  async function applyMaskEdit(): Promise<boolean> {
    if (!project || !maskEditor || !canvasRef.current) return false;
    if (maskEditor.kind === "inpaint") return false;
    const retouchingBuiltBackground = phase === "editing" && maskEditor.kind === "extra" && Boolean(project.backgroundUrl);
    setError(null);
    setMaskSaving(true);
    try {
      const mask = await canvasRef.current.exportEditedMask();
      const result = await updateProjectMask(project.id, maskEditor.layerId, mask);
      setProject(mergeProjectResult(project, result, {
        refreshLayerId: maskEditor.layerId,
        refreshExtra: maskEditor.kind === "extra"
      }));
      cancelMaskEdit();
      if (retouchingBuiltBackground) {
        setBackgroundRetouchPending(true);
        setPhase("selecting");
      }
      return true;
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "The edited mask could not be saved.");
      return false;
    } finally {
      setMaskSaving(false);
    }
  }

  async function inpaintActiveTarget(): Promise<void> {
    if (!project || maskEditor?.kind !== "inpaint" || !canvasRef.current) return;
    if (!maskDirty) {
      setError("Paint an area before inpainting this layer.");
      return;
    }
    const targetLayerId = maskEditor.layerId;
    const targetName = targetLayerId
      ? project.layers.find((layer) => layer.id === targetLayerId)?.name ?? "foreground layer"
      : "background";
    setError(null);
    setMaskSaving(true);
    try {
      const [mask, composition] = await Promise.all([
        canvasRef.current.exportEditedMask(),
        canvasRef.current.exportComposition()
      ]);
      cancelMaskEdit();
      setPhase("inpainting");
      setProcessingProgress({
        state: "queued",
        progress: 0,
        stage: "Queued",
        message: `Preparing ${targetName} for full-redraw inpainting.`
      });
      const result = await inpaintProjectTarget(
        project.id,
        targetLayerId,
        composition,
        mask,
        layerInpaintPrompt,
        setProcessingProgress
      );
      let merged = mergeProjectResult(project, result, { refreshLayerId: targetLayerId });
      if (targetLayerId === null && result.backgroundUrl) {
        merged = { ...merged, backgroundUrl: refreshedAssetUrl(result.backgroundUrl) };
      }
      setProject(merged);
      setFocusedInpaintTargetId(targetLayerId ?? "background");
      setPhase("editing");
    } catch (operationError) {
      setPhase("editing");
      setError(operationError instanceof Error ? operationError.message : "The selected layer could not be inpainted.");
    } finally {
      setMaskSaving(false);
      setProcessingProgress(null);
    }
  }

  async function refreshInpaintHistory(projectId: string): Promise<void> {
    const history = await getInpaintHistory(projectId);
    setInpaintHistory(Object.fromEntries(history.map((state) => [state.targetId, state])));
  }

  async function restoreFocusedInpaint(action: "undo" | "redo"): Promise<void> {
    if (!project || !focusedInpaintTargetId || inpaintHistoryBusy || maskEditor) return;
    const targetLayerId = focusedInpaintTargetId === "background" ? null : focusedInpaintTargetId;
    const state = inpaintHistory[focusedInpaintTargetId];
    if ((action === "undo" && !state?.canUndo) || (action === "redo" && !state?.canRedo)) return;
    setError(null);
    setMoving(false);
    setInpaintHistoryBusy(action);
    try {
      const result = action === "undo"
        ? await undoProjectTargetInpaint(project.id, targetLayerId)
        : await redoProjectTargetInpaint(project.id, targetLayerId);
      let merged = mergeProjectResult(project, result, { refreshLayerId: targetLayerId });
      if (targetLayerId === null && result.backgroundUrl) {
        merged = { ...merged, backgroundUrl: refreshedAssetUrl(result.backgroundUrl) };
      }
      setProject(merged);
      await refreshInpaintHistory(project.id);
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : `The layer inpaint could not be ${action === "undo" ? "undone" : "redone"}.`);
    } finally {
      setInpaintHistoryBusy(null);
    }
  }

  function resetActiveMask(): void {
    canvasRef.current?.resetEditedMask();
    setMaskBlurRadius(0);
  }

  async function refineActiveMask(): Promise<void> {
    if (!project || !maskEditor?.layerId) return;
    const layer = project.layers.find((candidate) => candidate.id === maskEditor.layerId);
    if (!layer) return;
    if (maskDirty) {
      const saved = await applyMaskEdit();
      if (!saved) return;
    } else {
      cancelMaskEdit();
    }
    await refineLayerMask(layer);
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
    setShowInpaintMask(false);
    setBackgroundRetouchPending(false);
    setFocusedInpaintTargetId(importedProject.backgroundUrl ? "background" : null);
    setInpaintHistory({});
    setMaskBlurRadius(0);
    setMaskEditor(null);
    setProject(importedProject);
    setCamera(importedCamera);
    setInpaintPrompt(importedProject.backgroundPrompt ?? "");
    setLayerInpaintPrompt("");
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

  function resetProject(): void {
    if (!window.confirm("Discard the current editor state and return to the image upload screen?")) return;
    setMoving(false);
    setProject(null);
    setPhase("idle");
    setCamera(DEFAULT_CAMERA);
    setError(null);
    setInpaintPrompt("");
    setLayerInpaintPrompt("");
    setShowInpaintMask(false);
    setBackgroundRetouchPending(false);
    setMaskBlurRadius(0);
    setMaskEditor(null);
    setMaskDirty(false);
    setMaskReady(false);
    setMaskCanUndo(false);
    setMaskCanRedo(false);
    setProcessingProgress(null);
    setRefiningLayerId(null);
    setConfirmingLayerId(null);
    setFocusedInpaintTargetId(null);
    setInpaintHistory({});
    setInpaintHistoryBusy(null);
    setRefinement("lama");
    if (fileRef.current) fileRef.current.value = "";
    if (projectFileRef.current) projectFileRef.current.value = "";
  }

  const selectedLayers = project?.layers.filter((layer) => layer.selected) ?? [];
  const activeEditedLayer = maskEditor?.layerId
    ? project?.layers.find((layer) => layer.id === maskEditor.layerId) ?? null
    : null;
  const activeInpaintTargetId = maskEditor?.kind === "inpaint" ? maskEditor.layerId ?? "background" : null;
  const focusedInpaintTargetName = focusedInpaintTargetId === "background"
    ? "Background"
    : project?.layers.find((layer) => layer.id === focusedInpaintTargetId)?.name ?? null;
  const focusedInpaintHistory = focusedInpaintTargetId ? inpaintHistory[focusedInpaintTargetId] : null;
  const maskHasChanges = maskDirty || maskBlurRadius > 0;
  const unconfirmedMaskCount = selectedLayers.filter((layer) => !layer.confirmed).length;
  const maskOperationActive = maskEditor !== null || refiningLayerId !== null || confirmingLayerId !== null;
  const inpaintDisabled = maskOperationActive || unconfirmedMaskCount > 0 || selectedLayers.length === 0;
  const inpaintLabel = unconfirmedMaskCount > 0
    ? `Confirm ${unconfirmedMaskCount} mask${unconfirmedMaskCount === 1 ? "" : "s"}`
    : backgroundRetouchPending
      ? "Rebuild background"
      : "Inpaint holes";
  const busy = phase === "analyzing" || phase === "inpainting" || fileOperation !== null || maskSaving || refiningLayerId !== null || confirmingLayerId !== null || inpaintHistoryBusy !== null;
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
            <>
              <button type="button" className="export-button subtle" disabled={busy} onClick={resetProject}>
                Reset project
              </button>
              <button type="button" className="export-button subtle" disabled={busy} onClick={() => void saveProjectPackage()}>
                {fileOperation === "project" ? "Packing..." : "Project file"}
              </button>
            </>
          )}
          {phase === "editing" && (
            <>
              <button type="button" className="export-button subtle" disabled={busy} onClick={() => void saveCanvas("video")}>
                {fileOperation === "video" ? "Rendering..." : "Demo MP4"}
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
            <li className={phase !== "idle" ? "active" : ""}><span>1</span> Import image</li>
            <li className={phase !== "idle" ? "active" : ""}><span>2</span> Segment objects</li>
            <li className={["selecting", "inpainting", "editing"].includes(phase) ? "active" : ""}><span>3</span> Refine + confirm</li>
            <li className={["inpainting", "editing"].includes(phase) ? "active" : ""}><span>4</span> Build scene</li>
          </ol>
        </section>
        <div className="local-note">
          <span className="local-pulse" />
          <div><strong>Local only</strong><small>No image upload or cloud inference</small></div>
        </div>
      </aside>

      <section className="workspace">
        {processingProgress && (
          <div className="processing-status" aria-live="polite">
            <div className="processing-copy">
              <span className="eyebrow">Local processing</span>
              <strong>{processingProgress.stage}</strong>
              <span>{processingProgress.message}</span>
            </div>
            <output>{processingProgress.progress}%</output>
            <div
              className="progress-track"
              role="progressbar"
              aria-label={processingProgress.stage}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={processingProgress.progress}
            >
              <i style={{ width: `${processingProgress.progress}%` }} />
            </div>
          </div>
        )}
        {project ? (
          <>
            <div className="stage-header">
              <div>
                <span className="eyebrow">Composition</span>
                <strong>{project.width} x {project.height}</strong>
              </div>
              <div className="stage-status">
                {phase === "selecting" && (
                  <button
                    type="button"
                    className="stage-build-button"
                    onPointerEnter={() => setShowInpaintMask(true)}
                    onPointerLeave={() => setShowInpaintMask(false)}
                    onFocus={() => setShowInpaintMask(true)}
                    onBlur={() => setShowInpaintMask(false)}
                    disabled={inpaintDisabled}
                    onClick={() => void buildScene()}
                  >
                    {inpaintLabel}
                  </button>
                )}
                <span className="phase-label"><i className={busy ? "working" : ""} /> {backgroundRetouchPending && phase === "selecting" ? "Retouch mask ready to rebuild" : phaseLabel(phase)}</span>
              </div>
            </div>
            <SceneCanvas
              ref={canvasRef}
              project={project}
              camera={camera}
              interactive={(phase === "selecting" || phase === "editing") && maskEditor === null}
              reviewingSource={phase === "selecting"}
              showInpaintMask={phase === "selecting" && showInpaintMask && maskEditor === null}
              maskEditor={maskEditor}
              showCompositionWhileMaskEditing={maskEditor?.kind === "inpaint"}
              brushMode={maskBrushMode}
              brushSize={maskBrushSize}
              maskBlurRadius={maskBlurRadius}
              onMaskDirtyChange={setMaskDirty}
              onMaskHistoryChange={({ canUndo, canRedo }) => {
                setMaskCanUndo(canUndo);
                setMaskCanRedo(canRedo);
              }}
              onMaskReadyChange={setMaskReady}
              onMaskError={setError}
              onCameraChange={setCamera}
            />
            {(phase === "selecting" || phase === "editing") && maskEditor && (
              <div className="mask-toolbar" role="region" aria-label="Mask brush controls">
                <div className="mask-toolbar-title">
                  <span className="eyebrow">Mask brush</span>
                  <strong>{maskEditor.name}</strong>
                  <span>{maskEditor.kind === "inpaint"
                    ? "Paint pixels to fully regenerate using the entire composition as context."
                    : maskEditor.kind === "extra"
                    ? phase === "editing"
                      ? "Paint anything else that should be regenerated on the background plate."
                      : "Expands the background inpaint area."
                    : "Updates this foreground cutout."}</span>
                </div>
                <div className="brush-modes" aria-label="Brush mode">
                  <button type="button" className={maskBrushMode === "add" ? "active" : ""} onClick={() => setMaskBrushMode("add")}>Add</button>
                  <button type="button" className={maskBrushMode === "erase" ? "active" : ""} onClick={() => setMaskBrushMode("erase")}>Erase</button>
                </div>
                <label className="brush-size-control">
                  <span>Size</span>
                  <input
                    type="range"
                    min="6"
                    max="180"
                    step="2"
                    value={maskBrushSize}
                    onChange={(event) => setMaskBrushSize(Number(event.target.value))}
                  />
                  <output>{maskBrushSize}px</output>
                </label>
                <label className="brush-size-control blur-control">
                  <span>Edge blur</span>
                  <input
                    type="range"
                    min="0"
                    max="24"
                    step="1"
                    value={maskBlurRadius}
                    onChange={(event) => setMaskBlurRadius(Number(event.target.value))}
                  />
                  <output>{maskBlurRadius}px</output>
                </label>
                <div className="brush-history" aria-label="Brush history">
                  <button type="button" disabled={!maskCanUndo || maskSaving} onClick={() => canvasRef.current?.undoEditedMask()} title="Undo brush stroke (Ctrl+Z)">Undo</button>
                  <button type="button" disabled={!maskCanRedo || maskSaving} onClick={() => canvasRef.current?.redoEditedMask()} title="Redo brush stroke (Ctrl+Shift+Z or Ctrl+Y)">Redo</button>
                </div>
                <button type="button" className="text-button" disabled={!maskHasChanges || maskSaving} onClick={resetActiveMask}>Reset</button>
                <button type="button" className="secondary-button compact" disabled={maskSaving} onClick={cancelMaskEdit}>Cancel</button>
                {maskEditor.kind === "layer" && activeEditedLayer && project.engine === "ai" && (
                  <button type="button" className="secondary-button compact refine-action" disabled={!maskReady || maskSaving} onClick={() => void refineActiveMask()}>
                    {maskDirty ? "Apply + refine" : "Refine"}
                  </button>
                )}
                {maskEditor.kind === "inpaint" ? (
                  <button type="button" className="primary-button compact" disabled={!maskReady || !maskDirty || maskSaving} onClick={() => void inpaintActiveTarget()}>
                    {maskSaving ? "Starting..." : "Inpaint layer"}
                  </button>
                ) : (
                  <button type="button" className="primary-button compact" disabled={!maskReady || !maskHasChanges || maskSaving} onClick={() => void applyMaskEdit()}>
                    {maskSaving ? "Saving..." : "Apply mask"}
                  </button>
                )}
              </div>
            )}
            {phase === "editing" && !maskEditor && (
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
            <LayerInspector
              layers={project.layers}
              phase={phase}
              editingLayerId={maskEditor?.kind === "layer" ? maskEditor.layerId : null}
              refiningLayerId={refiningLayerId}
              confirmingLayerId={confirmingLayerId}
              aiRefineAvailable={project.engine === "ai"}
              backgroundUrl={project.backgroundUrl}
              inpaintingTargetId={activeInpaintTargetId}
              focusedTargetId={focusedInpaintTargetId}
              layerInpaintAvailable={phase === "editing" && project.engine === "ai" && Boolean(health?.providers.refinement?.available)}
              onEditMask={editLayerMask}
              onRefineMask={(layer) => void refineLayerMask(layer)}
              onConfirmMask={(layer) => void confirmLayer(layer)}
              onInpaintTarget={editInpaintTarget}
              onFocusTarget={setFocusedInpaintTargetId}
              onChange={updateLayers}
            />
            {phase === "selecting" && (
              <div className="build-panel build-scene-panel">
                <div className="build-options">
                  <strong>Build background plate</strong>
                  <div className="extra-mask-option">
                    <div>
                      <span>Extra inpaint area</span>
                      <small>Brush additional background pixels to regenerate.</small>
                    </div>
                    <button type="button" disabled={maskEditor !== null} onClick={editExtraMask}>
                      {project.extraMaskUrl ? "Edit area" : "Add area"}
                    </button>
                  </div>
                  <label>
                    <span>Local inpainter</span>
                    <select value={refinement} onChange={(event) => setRefinement(event.target.value as InpaintRefinement)}>
                      <option value="lama">Big LaMa - structural fill</option>
                      <option value="powerpaint" disabled={!health?.providers.refinement?.available}>PowerPaint - advanced full redraw</option>
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
                <button
                  type="button"
                  className="primary-button"
                  onPointerEnter={() => setShowInpaintMask(true)}
                  onPointerLeave={() => setShowInpaintMask(false)}
                  onFocus={() => setShowInpaintMask(true)}
                  onBlur={() => setShowInpaintMask(false)}
                  disabled={inpaintDisabled}
                  onClick={() => void buildScene()}
                >
                  {inpaintLabel}
                </button>
              </div>
            )}
            {phase === "inpainting" && (
              <div className="build-panel processing">
                <span className="spinner" />
                <div>
                  <strong>{processingProgress?.stage ?? "Inpainting locally"}</strong>
                  <span>{processingProgress?.message ?? "The source and masks stay on this machine."}</span>
                </div>
                <output>{processingProgress?.progress ?? 0}%</output>
              </div>
            )}
            {phase === "editing" && (
              <div className="build-panel">
                <div className="build-options">
                  <strong>Layer inpaint</strong>
                  <span>Select Inpaint on Background or any foreground layer, then paint over the full composition.</span>
                  <span className="redraw-note">PowerPaint full redraw / denoise 1.00. Every painted source pixel is discarded.</span>
                  <div className="inpaint-history-controls">
                    <span>Focused layer: <strong>{focusedInpaintTargetName ?? "Select a scene layer"}</strong></span>
                    <button
                      type="button"
                      disabled={!focusedInpaintHistory?.canUndo || inpaintHistoryBusy !== null}
                      title="Undo this layer's last completed inpaint (Ctrl+Z)"
                      onClick={() => void restoreFocusedInpaint("undo")}
                    >
                      {inpaintHistoryBusy === "undo" ? "Undoing..." : "Undo inpaint"}
                    </button>
                    <button
                      type="button"
                      disabled={!focusedInpaintHistory?.canRedo || inpaintHistoryBusy !== null}
                      title="Redo this layer's completed inpaint (Ctrl+Y or Ctrl+Shift+Z)"
                      onClick={() => void restoreFocusedInpaint("redo")}
                    >
                      {inpaintHistoryBusy === "redo" ? "Redoing..." : "Redo inpaint"}
                    </button>
                  </div>
                  <label>
                    <span>Inpaint prompt</span>
                    <input
                      type="text"
                      maxLength={500}
                      value={layerInpaintPrompt}
                      placeholder="Blank continues the surrounding composition"
                      onChange={(event) => setLayerInpaintPrompt(event.target.value)}
                    />
                  </label>
                  <div className="extra-mask-option">
                    <div>
                      <span>Rebuild hidden background</span>
                      <small>Use confirmed object masks plus an optional extra hole mask.</small>
                    </div>
                    <button type="button" disabled={maskEditor !== null} onClick={editExtraMask}>
                      {project.extraMaskUrl ? "Edit hole mask" : "Add hole mask"}
                    </button>
                  </div>
                  {health && !health.providers.refinement?.available && (
                    <span className="redraw-note warning">Layer inpainting unavailable: {health.providers.refinement?.detail}.</span>
                  )}
                </div>
              </div>
            )}
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
