import { useEffect, useRef, useState } from "react";
import { CameraControls } from "./components/CameraControls";
import { LayerInspector } from "./components/LayerInspector";
import type { MaskBrushMode, MaskEditorTarget } from "./components/MaskEditorOverlay";
import { SceneCanvas, type SceneCanvasHandle } from "./components/SceneCanvas";
import {
  analyzeImage,
  analyzeSample,
  cancelProcessingJob,
  confirmProjectLayer,
  exportProjectPackage,
  getHealth,
  getInpaintHistory,
  getMaskHistory,
  importProjectPackage,
  inpaintProject,
  inpaintProjectTarget,
  redoProjectLayerRefine,
  redoProjectTargetInpaint,
  refineProjectLayer,
  undoProjectTargetInpaint,
  undoProjectLayerRefine,
  updateProjectMask,
  ProcessingCancelledError,
  setJobPollIntervalMs
} from "./lib/api";
import { mergeProjectResult, refreshedAssetUrl } from "./lib/projectAssets";
import { appLog } from "./lib/logger";
import { useAppTranslation, type AppTranslate } from "./i18n";
import { DEFAULT_APP_SETTINGS, loadAppSettings, persistAppSettings, sanitizeAppSettings, type AppSettings } from "./settings";
import { SettingsDialog } from "./components/SettingsDialog";
import { AboutDialog } from "./components/AboutDialog";
import type { CameraState, HealthStatus, InpaintHistoryState, InpaintRefinement, ProcessingProgress, SceneLayer, SceneProject, WorkflowPhase } from "./types";
import "./styles.css";

const DEFAULT_CAMERA: CameraState = { x: 0, y: 0, zoom: 1, strength: 68 };

interface ActiveMaskEditor extends MaskEditorTarget {
  kind: "layer" | "extra" | "inpaint";
  layerId: string | null;
}

function downloadBlob(blob: Blob, name: string): void {
  // Browser downloads need a temporary object URL; release it after the click
  // so repeated exports do not retain the rendered file in memory.
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

function phaseLabel(phase: WorkflowPhase, t: AppTranslate): string {
  return {
    idle: t("phase.waiting"),
    analyzing: t("phase.segmenting"),
    selecting: t("phase.reviewing"),
    inpainting: t("phase.inpainting"),
    editing: t("phase.ready")
  }[phase];
}

export default function App() {
  const { locale, setLocale, t, runtimeText, layerName } = useAppTranslation();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [project, setProject] = useState<SceneProject | null>(null);
  const [phase, setPhase] = useState<WorkflowPhase>("idle");
  const [camera, setCamera] = useState<CameraState>(DEFAULT_CAMERA);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [showOptions, setShowOptions] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [appVersion, setAppVersion] = useState("0.1.0");
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
  const [focusedMaskLayerId, setFocusedMaskLayerId] = useState<string | null>(null);
  const [maskHistory, setMaskHistory] = useState<Record<string, InpaintHistoryState>>({});
  const [maskHistoryBusy, setMaskHistoryBusy] = useState<{ layerId: string; action: "undo" | "redo" } | null>(null);
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgress | null>(null);
  const [processingJobId, setProcessingJobId] = useState<string | null>(null);
  const [cancellingJob, setCancellingJob] = useState(false);
  const [fileOperation, setFileOperation] = useState<"import" | "project" | "video" | "png" | null>(null);
  const canvasRef = useRef<SceneCanvasHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);
  const cameraDefaults: CameraState = {
    ...DEFAULT_CAMERA,
    zoom: settings.camera.defaultZoom,
    strength: settings.camera.defaultStrength
  };

  useEffect(() => {
    // Settings are loaded before controls become interactive. Applying the
    // persisted values here also keeps polling, camera defaults, and locale in sync.
    let cancelled = false;
    void loadAppSettings().then((loaded) => {
      if (cancelled) return;
      setSettings(loaded);
      setJobPollIntervalMs(loaded.processing.pollIntervalMs);
      setRefinement(loaded.processing.defaultRefinement);
      setCamera((current) => ({ ...current, zoom: loaded.camera.defaultZoom, strength: loaded.camera.defaultStrength }));
      if (locale !== loaded.locale) setLocale(loaded.locale);
      appLog.info("settings.loaded", { locale: loaded.locale, pollIntervalMs: loaded.processing.pollIntervalMs });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => window.stereovisor?.onOpenOptions?.(() => setShowOptions(true)), []);

  useEffect(() => window.stereovisor?.onOpenAbout?.(() => {
    setShowAbout(true);
    const getAppVersion = window.stereovisor?.getAppVersion;
    if (getAppVersion) void getAppVersion().then((version) => setAppVersion(version)).catch(() => undefined);
  }), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.repeat || event.key !== ",") return;
      event.preventDefault();
      setShowOptions(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setSettings((current) => current.locale === locale ? current : { ...current, locale });
  }, [locale]);

  useEffect(() => {
    // Health is intentionally checked once on mount; the service reports both
    // the selected engine and provider readiness used by the UI guards.
    let cancelled = false;
    const load = async () => {
      try {
        const status = await getHealth();
        if (!cancelled) {
          setHealth(status);
          appLog.info("ui.health-state.updated", { engine: status.activeEngine, device: status.device });
        }
      } catch (requestError) {
        if (!cancelled) {
          appLog.error("ui.health-state.unavailable", requestError);
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
    if (settings.appearance.reduceMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMoving(false);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const tick = (time: number) => {
      const elapsed = (time - started) / 1000;
      setCamera((current) => ({
        ...current,
        x: Math.sin(elapsed * 0.72 * settings.motion.speed) * settings.motion.horizontalAmount,
        y: Math.sin(elapsed * 0.46 * settings.motion.speed + 0.8) * settings.motion.verticalAmount
      }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [moving, settings.appearance.reduceMotion, settings.motion]);

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
    if (!project || phase !== "selecting") return;
    let cancelled = false;
    void getMaskHistory(project.id)
      .then((history) => {
        if (!cancelled) setMaskHistory(Object.fromEntries(history.map((state) => [state.targetId, state])));
      })
      .catch(() => {
        if (!cancelled) setMaskHistory({});
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

  useEffect(() => {
    if (!project || phase !== "selecting" || maskEditor || refiningLayerId || confirmingLayerId || !focusedMaskLayerId || maskHistoryBusy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return;
      const eventTarget = event.target as HTMLElement | null;
      if (eventTarget?.closest("textarea, select, [contenteditable='true'], input:not([type='range']):not([type='checkbox']):not([type='radio'])")) return;
      const redo = event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey);
      const undo = event.key.toLowerCase() === "z" && !event.shiftKey;
      const state = maskHistory[focusedMaskLayerId];
      if ((!undo || !state?.canUndo) && (!redo || !state?.canRedo)) return;
      event.preventDefault();
      void restoreLayerRefine(focusedMaskLayerId, redo ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [project, phase, maskEditor, refiningLayerId, confirmingLayerId, focusedMaskLayerId, maskHistory, maskHistoryBusy]);

  async function process(
    operation: (
      onProgress: (progress: ProcessingProgress) => void,
      onJobStarted: (jobId: string) => void
    ) => Promise<SceneProject>
  ): Promise<void> {
    // A new analysis invalidates all transient editor/history state. Reset it
    // before changing phase so stale controls cannot target the next project.
    appLog.info("workflow.analysis.started");
    setError(null);
    setMoving(false);
    setLayerInpaintPrompt("");
    setShowInpaintMask(false);
    setBackgroundRetouchPending(false);
    setFocusedInpaintTargetId(null);
    setInpaintHistory({});
    setFocusedMaskLayerId(null);
    setMaskHistory({});
    setMaskHistoryBusy(null);
    setProcessingJobId(null);
    setCancellingJob(false);
    setMaskBlurRadius(0);
    setMaskEditor(null);
    setPhase("analyzing");
    setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: "Preparing the local AI job." });
    try {
      const result = await operation(setProcessingProgress, setProcessingJobId);
      setProject(result);
      setCamera(cameraDefaults);
      setPhase("selecting");
      appLog.info("workflow.analysis.completed", { projectId: result.id, layers: result.layers.length, engine: result.engine });
    } catch (operationError) {
      setPhase(project ? "editing" : "idle");
      if (operationError instanceof ProcessingCancelledError) {
        appLog.info("workflow.analysis.cancelled");
      } else {
        appLog.error("workflow.analysis.failed", operationError);
      }
      setError(operationError instanceof ProcessingCancelledError ? null : operationError instanceof Error ? operationError.message : "Image analysis failed.");
    } finally {
      setProcessingProgress(null);
      setProcessingJobId(null);
      setCancellingJob(false);
    }
  }

  async function onFile(file: File | undefined): Promise<void> {
    if (!file) return;
    // Keep the density choice with the request so the service and the visible
    // settings remain a single source of truth for this analysis.
    await process((onProgress, onJobStarted) => analyzeImage(file, onProgress, onJobStarted, settings.processing.segmentationDensity));
  }

  async function cancelProcessing(): Promise<void> {
    const jobId = processingJobId;
    if (!jobId || cancellingJob) return;
    setCancellingJob(true);
    setError(null);
    appLog.info("workflow.analysis-cancel.requested", { jobId });
    try {
      const cancelled = await cancelProcessingJob(jobId);
      setProcessingProgress({
        state: cancelled.state,
        progress: cancelled.progress,
        stage: cancelled.stage,
        message: cancelled.message
      });
    } catch (operationError) {
      setCancellingJob(false);
      appLog.error("workflow.analysis-cancel.failed", operationError, { jobId });
      setError(operationError instanceof Error ? operationError.message : "The processing job could not be cancelled.");
    }
  }

  async function buildScene(): Promise<void> {
    if (!project) return;
    // These checks mirror the service invariants: selected layers must be
    // confirmed, and PowerPaint needs either a prompt or its local captioner.
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
    setProcessingJobId(null);
    setCancellingJob(false);
    appLog.info("workflow.scene-build.started", { projectId: project.id, layerCount: selected.length, refinement });
    try {
      const result = await inpaintProject(
        project.id,
        selected,
        refinement,
        inpaintPrompt,
        setProcessingProgress,
        setProcessingJobId,
        settings.processing.inpaintingSteps
      );
      const selectedIds = new Set(selected);
      // Keep user layer ordering/visibility while replacing only generated
      // assets and metadata returned by the service.
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
      appLog.info("workflow.scene-build.completed", { projectId: result.id, provider: result.inpaintProvider });
    } catch (operationError) {
      setPhase("selecting");
      if (operationError instanceof ProcessingCancelledError) {
        appLog.info("workflow.scene-build.cancelled", { projectId: project.id });
      } else {
        appLog.error("workflow.scene-build.failed", operationError, { projectId: project.id });
      }
      setError(operationError instanceof ProcessingCancelledError ? null : operationError instanceof Error ? operationError.message : "Background inpainting failed.");
    } finally {
      setProcessingProgress(null);
      setProcessingJobId(null);
      setCancellingJob(false);
    }
  }

  function updateLayers(layers: SceneProject["layers"]): void {
    if (project) setProject({ ...project, layers });
  }

  function editLayerMask(layer: SceneLayer): void {
    setError(null);
    setMoving(false);
    setCamera(cameraDefaults);
    setShowInpaintMask(false);
    setMaskBrushMode("add");
    setMaskBlurRadius(0);
    setMaskDirty(false);
    setMaskReady(false);
    setMaskCanUndo(false);
    setMaskCanRedo(false);
    setFocusedMaskLayerId(layer.id);
    setMaskEditor({ kind: "layer", layerId: layer.id, key: `layer:${layer.id}`, name: layer.name, maskUrl: layer.maskUrl });
  }

  function editExtraMask(): void {
    if (!project) return;
    setError(null);
    setMoving(false);
    setCamera(cameraDefaults);
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
    setCamera(cameraDefaults);
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
    setFocusedMaskLayerId(layer.id);
    setRefiningLayerId(layer.id);
    setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: `Preparing ${layer.name} for local refinement.` });
    setProcessingJobId(null);
    setCancellingJob(false);
    appLog.info("workflow.mask-refine.started", { projectId: project.id, layerId: layer.id });
    try {
      const result = await refineProjectLayer(project.id, layer.id, setProcessingProgress, setProcessingJobId);
      setProject(mergeProjectResult(project, result, { refreshLayerId: layer.id }));
      await refreshMaskHistory(project.id);
      appLog.info("workflow.mask-refine.completed", { projectId: project.id, layerId: layer.id });
    } catch (operationError) {
      appLog.error("workflow.mask-refine.failed", operationError, { projectId: project.id, layerId: layer.id });
      setError(operationError instanceof ProcessingCancelledError ? null : operationError instanceof Error ? operationError.message : "The selected mask could not be refined.");
    } finally {
      setRefiningLayerId(null);
      setProcessingProgress(null);
      setProcessingJobId(null);
      setCancellingJob(false);
    }
  }

  async function confirmLayer(layer: SceneLayer): Promise<void> {
    if (!project) return;
    setError(null);
    setConfirmingLayerId(layer.id);
    appLog.info("workflow.mask-confirm.started", { projectId: project.id, layerId: layer.id });
    try {
      const result = await confirmProjectLayer(project.id, layer.id);
      setProject(mergeProjectResult(project, result));
      appLog.info("workflow.mask-confirm.completed", { projectId: project.id, layerId: layer.id });
    } catch (operationError) {
      appLog.error("workflow.mask-confirm.failed", operationError, { projectId: project.id, layerId: layer.id });
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
    appLog.info("workflow.mask-save.started", { projectId: project.id, target: maskEditor.layerId ?? "extra" });
    try {
      const mask = await canvasRef.current.exportEditedMask();
      const result = await updateProjectMask(project.id, maskEditor.layerId, mask);
      setProject(mergeProjectResult(project, result, {
        refreshLayerId: maskEditor.layerId,
        refreshExtra: maskEditor.kind === "extra"
      }));
      cancelMaskEdit();
      if (maskEditor.layerId) {
        await refreshMaskHistory(project.id);
      }
      if (retouchingBuiltBackground) {
        // Any mask change invalidates the existing plate; force the user back
        // through selection before allowing another build.
        setBackgroundRetouchPending(true);
        setPhase("selecting");
      }
      appLog.info("workflow.mask-save.completed", { projectId: project.id, target: maskEditor.layerId ?? "extra", rebuildRequired: retouchingBuiltBackground });
      return true;
    } catch (operationError) {
      appLog.error("workflow.mask-save.failed", operationError, { projectId: project.id, target: maskEditor.layerId ?? "extra" });
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
    appLog.info("workflow.target-inpaint.started", { projectId: project.id, target: targetLayerId ?? "background" });
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
      setProcessingJobId(null);
      setCancellingJob(false);
      const result = await inpaintProjectTarget(
        project.id,
        targetLayerId,
        composition,
        mask,
        layerInpaintPrompt,
        setProcessingProgress,
        setProcessingJobId,
        settings.processing.inpaintingSteps
      );
      let merged = mergeProjectResult(project, result, { refreshLayerId: targetLayerId });
      if (targetLayerId === null && result.backgroundUrl) {
        merged = { ...merged, backgroundUrl: refreshedAssetUrl(result.backgroundUrl) };
      }
      setProject(merged);
      setFocusedInpaintTargetId(targetLayerId ?? "background");
      setPhase("editing");
      appLog.info("workflow.target-inpaint.completed", { projectId: project.id, target: targetLayerId ?? "background" });
    } catch (operationError) {
      setPhase("editing");
      if (operationError instanceof ProcessingCancelledError) {
        appLog.info("workflow.target-inpaint.cancelled", { projectId: project.id, target: targetLayerId ?? "background" });
      } else {
        appLog.error("workflow.target-inpaint.failed", operationError, { projectId: project.id, target: targetLayerId ?? "background" });
      }
      setError(operationError instanceof ProcessingCancelledError ? null : operationError instanceof Error ? operationError.message : "The selected layer could not be inpainted.");
    } finally {
      setMaskSaving(false);
      setProcessingProgress(null);
      setProcessingJobId(null);
      setCancellingJob(false);
    }
  }

  async function refreshInpaintHistory(projectId: string): Promise<void> {
    const history = await getInpaintHistory(projectId);
    setInpaintHistory(Object.fromEntries(history.map((state) => [state.targetId, state])));
  }

  async function refreshMaskHistory(projectId: string): Promise<void> {
    const history = await getMaskHistory(projectId);
    setMaskHistory(Object.fromEntries(history.map((state) => [state.targetId, state])));
  }

  async function restoreLayerRefine(layerId: string, action: "undo" | "redo"): Promise<void> {
    if (!project || maskHistoryBusy || maskEditor || refiningLayerId || confirmingLayerId) return;
    const state = maskHistory[layerId];
    if ((action === "undo" && !state?.canUndo) || (action === "redo" && !state?.canRedo)) return;
    setFocusedMaskLayerId(layerId);
    setError(null);
    setMaskHistoryBusy({ layerId, action });
    appLog.info("workflow.mask-history.started", { projectId: project.id, layerId, action });
    try {
      const result = action === "undo"
        ? await undoProjectLayerRefine(project.id, layerId)
        : await redoProjectLayerRefine(project.id, layerId);
      setProject(mergeProjectResult(project, result, { refreshLayerId: layerId }));
      await refreshMaskHistory(project.id);
      appLog.info("workflow.mask-history.completed", { projectId: project.id, layerId, action });
    } catch (operationError) {
      appLog.error("workflow.mask-history.failed", operationError, { projectId: project.id, layerId, action });
      setError(operationError instanceof Error ? operationError.message : `The mask refinement could not be ${action === "undo" ? "undone" : "redone"}.`);
    } finally {
      setMaskHistoryBusy(null);
    }
  }

  async function restoreFocusedInpaint(action: "undo" | "redo"): Promise<void> {
    if (!project || !focusedInpaintTargetId || inpaintHistoryBusy || maskEditor) return;
    const targetLayerId = focusedInpaintTargetId === "background" ? null : focusedInpaintTargetId;
    const state = inpaintHistory[focusedInpaintTargetId];
    if ((action === "undo" && !state?.canUndo) || (action === "redo" && !state?.canRedo)) return;
    setError(null);
    setMoving(false);
    setInpaintHistoryBusy(action);
    appLog.info("workflow.inpaint-history.started", { projectId: project.id, target: focusedInpaintTargetId, action });
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
      appLog.info("workflow.inpaint-history.completed", { projectId: project.id, target: focusedInpaintTargetId, action });
    } catch (operationError) {
      appLog.error("workflow.inpaint-history.failed", operationError, { projectId: project.id, target: focusedInpaintTargetId, action });
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
    appLog.info("workflow.file-operation.started", { operation });
    try {
      await action();
      appLog.info("workflow.file-operation.completed", { operation });
    } catch (operationError) {
      appLog.error("workflow.file-operation.failed", operationError, { operation });
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
    // Imported projects replace the complete editor snapshot, including the
    // camera and provider metadata; clear all transient interaction state first.
    setMoving(false);
    setShowInpaintMask(false);
    setBackgroundRetouchPending(false);
    setFocusedInpaintTargetId(importedProject.backgroundUrl ? "background" : null);
    setInpaintHistory({});
    setFocusedMaskLayerId(null);
    setMaskHistory({});
    setMaskHistoryBusy(null);
    setProcessingJobId(null);
    setCancellingJob(false);
    setMaskBlurRadius(0);
    setMaskEditor(null);
    setProject(importedProject);
    setCamera(importedCamera);
    setInpaintPrompt(importedProject.backgroundPrompt ?? "");
    setLayerInpaintPrompt("");
    setRefinement(importedProject.inpaintProvider === "powerpaint" ? "powerpaint" : "lama");
    setPhase(importedProject.backgroundUrl ? "editing" : "selecting");
    appLog.info("workflow.project-import.applied", { projectId: importedProject.id, layers: importedProject.layers.length, hasBackground: Boolean(importedProject.backgroundUrl) });
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
    if (!window.confirm(t("error.confirmReset"))) return;
    appLog.info("workflow.project-reset");
    setMoving(false);
    setProject(null);
    setPhase("idle");
    setCamera(cameraDefaults);
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
    setFocusedMaskLayerId(null);
    setMaskHistory({});
    setMaskHistoryBusy(null);
    setProcessingJobId(null);
    setCancellingJob(false);
    setRefinement(settings.processing.defaultRefinement);
    if (fileRef.current) fileRef.current.value = "";
    if (projectFileRef.current) projectFileRef.current.value = "";
  }

  async function saveSettings(next: AppSettings): Promise<void> {
    const normalized = sanitizeAppSettings(next);
    appLog.info("settings.save.started", { locale: normalized.locale, pollIntervalMs: normalized.processing.pollIntervalMs });
    await persistAppSettings(normalized);
    setSettings(normalized);
    setJobPollIntervalMs(normalized.processing.pollIntervalMs);
    setRefinement(normalized.processing.defaultRefinement);
    if (!project) setCamera((current) => ({ ...current, zoom: normalized.camera.defaultZoom, strength: normalized.camera.defaultStrength }));
    if (locale !== normalized.locale) setLocale(normalized.locale);
    setShowOptions(false);
    appLog.info("settings.save.completed", { locale: normalized.locale });
  }

  function changeRefinement(next: InpaintRefinement): void {
    appLog.info("settings.refinement.changed", { refinement: next });
    setRefinement(next);
    const nextSettings = sanitizeAppSettings({ ...settings, processing: { ...settings.processing, defaultRefinement: next } });
    setSettings(nextSettings);
    void persistAppSettings(nextSettings).catch((saveError) => {
      setError(saveError instanceof Error ? saveError.message : t("settings.saveFailed"));
    });
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
    ? t("build.confirmMasks", { count: unconfirmedMaskCount })
    : backgroundRetouchPending
      ? t("build.rebuildBackground")
      : t("build.inpaintHoles");
  const busy = phase === "analyzing" || phase === "inpainting" || processingJobId !== null || fileOperation !== null || maskSaving || refiningLayerId !== null || confirmingLayerId !== null || inpaintHistoryBusy !== null || maskHistoryBusy !== null;
  const engine = project?.engine ?? health?.activeEngine;

  return (
    <main className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault();
      void onFile(event.dataTransfer.files[0]);
    }}>
      <aside className="workflow-rail">
        <div className="rail-heading">
          <div className="brand-block">
            <img className="brand-mark" src="./app-icon.png" alt="" />
            <div>
              <span className="eyebrow">{t("brand.tagline")}</span>
              <h1>Stereovisor</h1>
            </div>
          </div>
          <div className="rail-index">01</div>
        </div>
        <section className="source-section">
          <span className="eyebrow">{t("source.title")}</span>
          <h2>{t("source.headlineFirst")}<br />{t("source.headlineSecond")}</h2>
          <p>{t("source.description")}</p>
          <input
            ref={fileRef}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label={t("source.imageFileInput")}
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          <input
            ref={projectFileRef}
            className="sr-only"
            type="file"
            accept=".stereovisor,application/zip"
            aria-label={t("file.projectFileInput")}
            onChange={(event) => {
              void openProjectFile(event.target.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button type="button" className="primary-button" disabled={busy} onClick={() => fileRef.current?.click()}>
            {t("source.openImage")}
          </button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void chooseProjectFile()}>
            {fileOperation === "import" ? t("file.importing") : t("file.importProject")}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void process((onProgress, onJobStarted) => analyzeSample(
              onProgress,
              onJobStarted,
              settings.processing.segmentationDensity,
            ))}
          >
            {t("source.sample")}
          </button>
        </section>
        <section className="pipeline-readout" aria-live="polite">
          <span className="eyebrow">{t("pipeline.title")}</span>
          <ol>
            <li className={phase !== "idle" ? "active" : ""}><span>1</span> {t("pipeline.import")}</li>
            <li className={phase !== "idle" ? "active" : ""}><span>2</span> {t("pipeline.segment")}</li>
            <li className={["selecting", "inpainting", "editing"].includes(phase) ? "active" : ""}><span>3</span> {t("pipeline.refine")}</li>
            <li className={["inpainting", "editing"].includes(phase) ? "active" : ""}><span>4</span> {t("pipeline.build")}</li>
          </ol>
        </section>
        <div className="local-note">
          <span className="local-pulse" />
          <div>
            <strong>{t("privacy.title")} / {engine === "ai" ? t("engine.localAI") : t("engine.preview")}</strong>
            <small>{t("privacy.detail")}</small>
          </div>
        </div>
      </aside>

      <section className="workspace">
        {processingProgress && (
          <div className="processing-status" aria-live="polite">
            <div className="processing-copy">
              <span className="eyebrow">{t("processing.local")}</span>
              <strong>{runtimeText(processingProgress.stage)}</strong>
              <span>{runtimeText(processingProgress.message)}</span>
            </div>
            <div className="processing-actions">
              <output>{processingProgress.progress}%</output>
              <button
                type="button"
                className="processing-cancel"
                disabled={!processingJobId || cancellingJob || processingProgress.state === "cancelled"}
                onClick={() => void cancelProcessing()}
              >
                {cancellingJob ? t("processing.cancelling") : t("processing.cancel")}
              </button>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-label={runtimeText(processingProgress.stage)}
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
                <span className="eyebrow">{t("composition.title")}</span>
                <strong>{project.width} x {project.height}</strong>
              </div>
              <div className="stage-status">
                <div className="stage-actions">
                  <button type="button" className="secondary-button compact" disabled={busy} onClick={resetProject}>
                    {t("file.resetProject")}
                  </button>
                  <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void saveProjectPackage()}>
                    {fileOperation === "project" ? t("file.packing") : t("file.projectFile")}
                  </button>
                  {phase === "editing" && (
                    <>
                      <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void saveCanvas("video")}>
                        {fileOperation === "video" ? t("file.rendering") : t("file.demoVideo")}
                      </button>
                      <button type="button" className="primary-button compact" disabled={busy} onClick={() => void saveCanvas("png")}>
                        {fileOperation === "png" ? t("file.saving") : t("file.png")}
                      </button>
                    </>
                  )}
                </div>
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
                <span className="phase-label"><i className={busy ? "working" : ""} /> {backgroundRetouchPending && phase === "selecting" ? t("phase.retouchReady") : phaseLabel(phase, t)}</span>
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
              <div className="mask-toolbar" role="region" aria-label={t("mask.controls")}>
                <div className="mask-toolbar-title">
                  <span className="eyebrow">{t("mask.brush")}</span>
                  <strong>{layerName(maskEditor.name)}</strong>
                  <span>{maskEditor.kind === "inpaint"
                    ? t("mask.inpaintHelp")
                    : maskEditor.kind === "extra"
                    ? phase === "editing"
                      ? t("mask.extraRetouchHelp")
                      : t("mask.extraHelp")
                    : t("mask.layerHelp")}</span>
                </div>
                <div className="brush-modes" aria-label={t("mask.brushMode")}>
                  <button type="button" className={maskBrushMode === "add" ? "active" : ""} onClick={() => setMaskBrushMode("add")}>{t("mask.add")}</button>
                  <button type="button" className={maskBrushMode === "erase" ? "active" : ""} onClick={() => setMaskBrushMode("erase")}>{t("mask.erase")}</button>
                </div>
                <label className="brush-size-control">
                  <span>{t("mask.size")}</span>
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
                  <span>{t("mask.edgeBlur")}</span>
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
                <div className="brush-history" aria-label={t("mask.history")}>
                  <button type="button" disabled={!maskCanUndo || maskSaving} onClick={() => canvasRef.current?.undoEditedMask()} title={t("mask.undoTitle")}>{t("mask.undo")}</button>
                  <button type="button" disabled={!maskCanRedo || maskSaving} onClick={() => canvasRef.current?.redoEditedMask()} title={t("mask.redoTitle")}>{t("mask.redo")}</button>
                </div>
                <button type="button" className="text-button" disabled={!maskHasChanges || maskSaving} onClick={resetActiveMask}>{t("mask.reset")}</button>
                <button type="button" className="secondary-button compact" disabled={maskSaving} onClick={cancelMaskEdit}>{t("mask.cancel")}</button>
                {maskEditor.kind === "layer" && activeEditedLayer && project.engine === "ai" && (
                  <button type="button" className="secondary-button compact refine-action" disabled={!maskReady || maskSaving} onClick={() => void refineActiveMask()}>
                    {maskDirty ? t("mask.applyRefine") : t("mask.refine")}
                  </button>
                )}
                {maskEditor.kind === "inpaint" ? (
                  <button type="button" className="primary-button compact" disabled={!maskReady || !maskDirty || maskSaving} onClick={() => void inpaintActiveTarget()}>
                    {maskSaving ? t("mask.starting") : t("mask.inpaintLayer")}
                  </button>
                ) : (
                  <button type="button" className="primary-button compact" disabled={!maskReady || !maskHasChanges || maskSaving} onClick={() => void applyMaskEdit()}>
                    {maskSaving ? t("mask.applying") : t("mask.apply")}
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
                onReset={() => { setMoving(false); setCamera(cameraDefaults); }}
              />
            )}
          </>
        ) : (
          <button type="button" className="empty-stage" onClick={() => fileRef.current?.click()} disabled={busy}>
            <span className="empty-orbit"><i /><i /><i /></span>
            <strong>{busy ? t("empty.analyzing") : t("empty.drop")}</strong>
            <small>{busy ? t("empty.analyzingDetail") : t("empty.formats")}</small>
          </button>
        )}
        {error && <div className="error-banner" role="alert">{runtimeText(error)}</div>}
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
              maskHistory={maskHistory}
              maskHistoryBusy={maskHistoryBusy}
              backgroundUrl={project.backgroundUrl}
              inpaintingTargetId={activeInpaintTargetId}
              focusedTargetId={focusedInpaintTargetId}
              layerInpaintAvailable={phase === "editing" && project.engine === "ai" && Boolean(health?.providers.refinement?.available)}
              onEditMask={editLayerMask}
              onRefineMask={(layer) => void refineLayerMask(layer)}
              onUndoRefine={(layerId) => void restoreLayerRefine(layerId, "undo")}
              onRedoRefine={(layerId) => void restoreLayerRefine(layerId, "redo")}
              onConfirmMask={(layer) => void confirmLayer(layer)}
              onInpaintTarget={editInpaintTarget}
              onFocusTarget={setFocusedInpaintTargetId}
              onChange={updateLayers}
            />
            {phase === "selecting" && (
              <div className="build-panel build-scene-panel">
                <div className="build-options">
                  <strong>{t("build.title")}</strong>
                  <div className="extra-mask-option">
                    <div>
                      <span>{t("build.extraArea")}</span>
                      <small>{t("build.extraAreaHelp")}</small>
                    </div>
                    <button type="button" disabled={maskEditor !== null} onClick={editExtraMask}>
                      {project.extraMaskUrl ? t("build.editArea") : t("build.addArea")}
                    </button>
                  </div>
                  <label>
                    <span>{t("build.inpainter")}</span>
                    <select value={refinement} onChange={(event) => changeRefinement(event.target.value as InpaintRefinement)}>
                      <option value="lama">{t("build.lama")}</option>
                      <option value="powerpaint" disabled={!health?.providers.refinement?.available}>{t("build.powerpaint")}</option>
                    </select>
                  </label>
                  {refinement === "powerpaint" && (
                    <>
                      <span className="redraw-note">{t("build.fullRedrawNote")}</span>
                      <label>
                        <span>{t("build.backgroundPrompt")}</span>
                        <input
                          type="text"
                          maxLength={500}
                          value={inpaintPrompt}
                          placeholder={t("build.backgroundPromptPlaceholder")}
                          onChange={(event) => setInpaintPrompt(event.target.value)}
                        />
                      </label>
                    </>
                  )}
                  {health && !health.providers.refinement?.available && (
                    <span className="redraw-note warning">
                      {t("build.fullRedrawUnavailable", { detail: runtimeText(health.providers.refinement?.detail ?? "") })}
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
                  <strong>{processingProgress ? runtimeText(processingProgress.stage) : t("build.inpaintingLocally")}</strong>
                  <span>{processingProgress ? runtimeText(processingProgress.message) : t("build.localDetail")}</span>
                </div>
                <output>{processingProgress?.progress ?? 0}%</output>
              </div>
            )}
            {phase === "editing" && (
              <div className="build-panel">
                <div className="build-options">
                  <strong>{t("build.layerInpaint")}</strong>
                  <span>{t("build.layerInpaintHelp")}</span>
                  <span className="redraw-note">{t("build.layerFullRedrawNote")}</span>
                  <div className="inpaint-history-controls">
                    <span>{t("build.focusedLayer", { name: focusedInpaintTargetName ? layerName(focusedInpaintTargetName) : t("build.selectLayer") })}</span>
                    <button
                      type="button"
                      disabled={!focusedInpaintHistory?.canUndo || inpaintHistoryBusy !== null}
                      title={t("build.undoTitle")}
                      onClick={() => void restoreFocusedInpaint("undo")}
                    >
                      {inpaintHistoryBusy === "undo" ? t("build.undoing") : t("build.undoInpaint")}
                    </button>
                    <button
                      type="button"
                      disabled={!focusedInpaintHistory?.canRedo || inpaintHistoryBusy !== null}
                      title={t("build.redoTitle")}
                      onClick={() => void restoreFocusedInpaint("redo")}
                    >
                      {inpaintHistoryBusy === "redo" ? t("build.redoing") : t("build.redoInpaint")}
                    </button>
                  </div>
                  <label>
                    <span>{t("build.inpaintPrompt")}</span>
                    <input
                      type="text"
                      maxLength={500}
                      value={layerInpaintPrompt}
                      placeholder={t("build.inpaintPromptPlaceholder")}
                      onChange={(event) => setLayerInpaintPrompt(event.target.value)}
                    />
                  </label>
                  <div className="extra-mask-option">
                    <div>
                      <span>{t("build.rebuildHidden")}</span>
                      <small>{t("build.rebuildHiddenHelp")}</small>
                    </div>
                    <button type="button" disabled={maskEditor !== null} onClick={editExtraMask}>
                      {project.extraMaskUrl ? t("build.editHole") : t("build.addHole")}
                    </button>
                  </div>
                  {health && !health.providers.refinement?.available && (
                    <span className="redraw-note warning">{t("build.layerUnavailable", { detail: runtimeText(health.providers.refinement?.detail ?? "") })}</span>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="inspector-empty">
            <span className="eyebrow">{t("inspector.title")}</span>
            <h2>{t("inspector.emptyTitle")}</h2>
            <p>{t("inspector.emptyDetail")}</p>
            <div className="ghost-layer" /><div className="ghost-layer short" /><div className="ghost-layer" />
          </div>
        )}
      </aside>
      {showOptions && <SettingsDialog settings={settings} onSave={saveSettings} onCancel={() => setShowOptions(false)} />}
      {showAbout && <AboutDialog version={appVersion} onClose={() => setShowAbout(false)} />}
    </main>
  );
}
