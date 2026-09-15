import { useEffect, useRef, useState, type DragEvent } from "react";
import { CameraControls } from "./components/CameraControls";
import { ServerStatus } from "./components/ServerStatus";
import { LayerInspector } from "./components/LayerInspector";
import type { MaskBrushMode, MaskEditorTarget } from "./components/MaskEditorOverlay";
import { SceneCanvas, type SceneCanvasHandle } from "./components/SceneCanvas";
import {
  analyzeImage,
  analyzeSample,
  cancelProcessingJob,
  confirmProjectLayer,
  createProjectLayer,
  deleteProjectLayer,
  exportProjectPackage,
  probeHealth,
  getInpaintHistory,
  getLayerMergeHistory,
  getMaskHistory,
  importProjectPackage,
  inpaintProject,
  inpaintProjectTarget,
  mergeProjectLayers,
  redoProjectLayerRefine,
  redoProjectLayerMerge,
  redoProjectTargetInpaint,
  refineProjectLayer,
  renameProjectLayer,
  undoProjectTargetInpaint,
  undoProjectLayerRefine,
  undoProjectLayerMerge,
  updateProjectMask,
  ProcessingCancelledError,
  setJobPollIntervalMs,
  setServiceConnection,
  waitForJob
} from "./lib/api";
import { clearProcessingSession, readProcessingSession, saveProcessingSession, type ProcessingSession } from "./lib/processingSession";
import { mergeProjectResult, refreshedAssetUrl } from "./lib/projectAssets";
import { appLog } from "./lib/logger";
import { useAppTranslation, type AppTranslate } from "./i18n";
import { DEFAULT_APP_SETTINGS, loadAppSettings, persistAppSettings, sanitizeAppSettings, type AppSettings } from "./settings";
import { SettingsDialog } from "./components/SettingsDialog";
import { LayerAdjustments } from "./components/LayerAdjustments";
import { AboutDialog } from "./components/AboutDialog";
import { StartupGate, type StartupPhase } from "./components/StartupGate";
import type { CameraState, HealthStatus, InpaintHistoryState, InpaintRefinement, ProcessingProgress, SceneLayer, SceneProject, WorkflowPhase } from "./types";
import {
  healthPollDelayMs,
  isPreparationWindow,
  isLocalAiReady,
  isOutageReportable,
  shouldHideEditorDuringPreparation,
} from "./lib/startup";
import {
  isChannelConnected,
  subscribeToChannelState,
  subscribeToHealthEvents,
} from "./lib/events";
import "./styles.css";

const DEFAULT_CAMERA: CameraState = {
  x: 0.5,
  y: 0.2,
  zoom: DEFAULT_APP_SETTINGS.camera.defaultZoom,
  strength: DEFAULT_APP_SETTINGS.camera.defaultStrength,
  inverseDepth: false,
  centerPull: 0.5,
  sceneScale: 1,
  depthOfField: 0,
  focusDepth: 1
};
// Health is polled once per second; this covers the first-run service restart
// when the prepared AI runtime takes over from the core one.

/** Readiness cadence with no event channel: the original one-second poll. */
const HEALTH_POLL_INTERVAL_MS = 1000;
/** Backstop cadence while pushed readiness frames are arriving. */
const HEALTH_SAFETY_POLL_MS = 15000;
// Upper bound on the build button's handover guard. Moving the pointer off the
// button clears it sooner; this only covers a pointer that never moves.
const BUILD_HANDOVER_COOLDOWN_MS = 600;

interface ActiveMaskEditor extends MaskEditorTarget {
  // "new-layer" brushes a foreground layer that does not exist yet; it becomes
  // a real layer, with a name, only once the brush is applied.
  kind: "layer" | "extra" | "inpaint" | "new-layer";
  layerId: string | null;
}

type CollapsedPanel = "left" | "right";

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
  const [startupPhase, setStartupPhase] = useState<StartupPhase | "ready">("connecting");
  const [startupError, setStartupError] = useState<string | null>(null);
  const [project, setProject] = useState<SceneProject | null>(null);
  const [phase, setPhase] = useState<WorkflowPhase>("idle");
  const [camera, setCamera] = useState<CameraState>(DEFAULT_CAMERA);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [showOptions, setShowOptions] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [appVersion, setAppVersion] = useState(__CLIENT_VERSION__);
  const [openPanel, setOpenPanel] = useState<CollapsedPanel | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refinement, setRefinement] = useState<InpaintRefinement>("lama");
  const [inpaintPrompt, setInpaintPrompt] = useState("");
  const [layerInpaintPrompt, setLayerInpaintPrompt] = useState("");
  const [showInpaintMask, setShowInpaintMask] = useState(false);
  const [backgroundRetouchPending, setBackgroundRetouchPending] = useState(false);
  const [maskEditor, setMaskEditor] = useState<ActiveMaskEditor | null>(null);
  const [maskEditorName, setMaskEditorName] = useState("");
  const [renamingLayer, setRenamingLayer] = useState(false);
  const [deletingLayerId, setDeletingLayerId] = useState<string | null>(null);
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
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [buildCooldown, setBuildCooldown] = useState(false);
  // Refs, not state: a re-entry guard has to be readable and settable inside the
  // same click that sets it, before React has re-rendered anything.
  const buildActionLock = useRef(false);
  const [focusedInpaintTargetId, setFocusedInpaintTargetId] = useState<string | null>(null);
  // Blob URL of the mask a running full-redraw job is working on. The editor is
  // closed by then, so this is the only thing that still knows which area the
  // stage should mark as pending.
  const [pendingInpaintMaskUrl, setPendingInpaintMaskUrl] = useState<string | null>(null);
  const [anchorLayerId, setAnchorLayerId] = useState<string | null>(null);
  const [inpaintHistory, setInpaintHistory] = useState<Record<string, InpaintHistoryState>>({});
  const [inpaintHistoryBusy, setInpaintHistoryBusy] = useState<"undo" | "redo" | null>(null);
  const [focusedMaskLayerId, setFocusedMaskLayerId] = useState<string | null>(null);
  const [maskHistory, setMaskHistory] = useState<Record<string, InpaintHistoryState>>({});
  const [maskHistoryBusy, setMaskHistoryBusy] = useState<{ layerId: string; action: "undo" | "redo" } | null>(null);
  const [layerSelection, setLayerSelection] = useState<string[]>([]);
  const [mergeHistory, setMergeHistory] = useState<InpaintHistoryState | null>(null);
  const [mergeHistoryBusy, setMergeHistoryBusy] = useState<"undo" | "redo" | null>(null);
  const [mergingLayers, setMergingLayers] = useState(false);
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgress | null>(null);
  const [processingJobId, setProcessingJobIdState] = useState<string | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [processingSessionReady, setProcessingSessionReady] = useState(false);
  const [cancellingJob, setCancellingJob] = useState(false);
  const [fileOperation, setFileOperation] = useState<"import" | "project" | "video" | "png" | null>(null);
  const preparationOnly = isPreparationWindow(window.location.search);
  const preparationCompletionSent = useRef(false);
  const canvasRef = useRef<SceneCanvasHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);
  const pendingFileRef = useRef<File | null>(null);
  const activeProcessingSession = useRef<ProcessingSession | null>(null);
  const processingRecoveryChecked = useRef(false);
  const mounted = useRef(true);
  const processingMessage = processingProgress
    ? processingProgress.queuePosition === null
      ? runtimeText(processingProgress.message)
      : t("runtime.waitingWorker")
    : null;
  const cameraDefaults: CameraState = {
    ...DEFAULT_CAMERA,
    zoom: settings.camera.defaultZoom,
    strength: settings.camera.defaultStrength,
    centerPull: 0.5,
    sceneScale: 1
  };
  const editingCameraDefaults = { ...cameraDefaults, inverseDepth: camera.inverseDepth ?? false };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    // Settings are loaded before controls become interactive.
    // Applying the persisted values here also keeps polling, camera defaults, and locale in sync.
    let cancelled = false;
    void loadAppSettings().then((loaded) => {
      if (cancelled) return;
      setSettings(loaded);
      setServiceConnection(loaded.service.origin, loaded.service.accessToken);
      setJobPollIntervalMs(loaded.processing.pollIntervalMs);
      setRefinement(loaded.processing.defaultRefinement);
      setCamera((current) => ({ ...current, zoom: loaded.camera.defaultZoom, strength: loaded.camera.defaultStrength }));
      if (locale !== loaded.locale) setLocale(loaded.locale);
      setSettingsReady(true);
      appLog.info("settings.loaded", { locale: loaded.locale, pollIntervalMs: loaded.processing.pollIntervalMs });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsReady || startupPhase !== "ready" || processingRecoveryChecked.current) return;
    processingRecoveryChecked.current = true;
    const session = preparationOnly ? null : readProcessingSession();
    if (session) {
      activeProcessingSession.current = session;
      setProcessingJobIdState(session.jobId);
      setProject(session.project);
      setPhase(session.kind === "analyze" ? "analyzing" : session.kind === "refine" ? session.phase : "inpainting");
      setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: "Waiting for the local AI worker.", queuePosition: null });
      appLog.info("processing.session.resuming", { jobId: session.jobId });
      void waitForJob(session.jobId, (progress) => {
        if (mounted.current) setProcessingProgress(progress);
      }).then((result) => {
        if (!mounted.current) return;
        const restored = mergeProjectResult(session.kind === "analyze" ? null : session.project, result);
        setProject({
          ...restored,
          backgroundUrl: restored.backgroundUrl ? refreshedAssetUrl(restored.backgroundUrl) : null,
          layers: restored.layers.map((layer) => ({
            ...layer,
            visible: session.kind === "inpaint" ? layer.selected : layer.visible,
            maskUrl: refreshedAssetUrl(layer.maskUrl),
            cutoutUrl: refreshedAssetUrl(layer.cutoutUrl)
          }))
        });
        setPhase(session.kind === "analyze" ? "selecting" : session.kind === "refine" ? session.phase : "editing");
      }).catch((operationError) => {
        if (!mounted.current) return;
        setPhase(session.project ? session.phase : "idle");
        setError(operationError instanceof ProcessingCancelledError ? null : operationError instanceof Error ? operationError.message :
          t(session.kind === "analyze" ? "error.analysisFailed" : session.kind === "refine" ? "error.refineFailed" : "error.backgroundInpaintFailed"));
      }).finally(() => {
        if (!mounted.current) return;
        setProcessingProgress(null);
        setProcessingJobId(null);
        setCancellingJob(false);
      });
    }
    setProcessingSessionReady(true);
  }, [settingsReady, startupPhase, preparationOnly]);

  useEffect(() => {
    document.title = preparationOnly && startupPhase !== "ready"
      ? "Stereovisor - Preparing local AI"
      : "Stereovisor";
    if (
      preparationOnly &&
      startupPhase === "ready" &&
      !preparationCompletionSent.current
    ) {
      preparationCompletionSent.current = true;
      window.stereovisor?.completePreparation?.();
    }
  }, [preparationOnly, startupPhase]);

  useEffect(() => window.stereovisor?.onOpenOptions?.(() => setShowOptions(true)), []);

  useEffect(() => window.stereovisor?.onOpenAbout?.(() => {
    setShowAbout(true);
    const getAppVersion = window.stereovisor?.getAppVersion;
    if (getAppVersion) void getAppVersion().then((version) => setAppVersion(version)).catch(() => undefined);
  }), []);

  useEffect(() => {
    if (openPanel === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpenPanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openPanel]);

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
    // Keep the app visible while the local service starts, then hold the editor
    // behind the gate until every required AI provider is ready. Keep polling
    // after the first ready response too: the local service can be restarted
    // or replaced while the editor is open, and the editor must fail closed.
    let cancelled = false;
    let retryTimer: number | null = null;
    let wasReady = false;
    let failures = 0;
    let firstFailureAt = 0;
    // One readiness reducer for both sources: a pushed frame and a polled
    // response carry the same HealthPayload, so they must land identically.
    const applyHealth = (status: HealthStatus) => {
      if (cancelled) return;
      failures = 0;
      firstFailureAt = 0;
      setHealth(status);
      setStartupError(null);
      if (isLocalAiReady(status)) {
        setStartupPhase("ready");
        if (!wasReady) {
          appLog.info("ui.startup.ready", { engine: status.activeEngine, device: status.device });
        }
        wasReady = true;
      } else {
        wasReady = false;
        setMoving(false);
        setStartupPhase(
          status.startupState === "starting" || status.startupState === "downloading" || status.startupState === "initializing" || status.activeEngine === "ai"
            ? "checking"
            : "blocked",
        );
        appLog.info("ui.startup.readiness.updated", {
          engine: status.activeEngine,
          providers: Object.fromEntries(Object.entries(status.providers).map(([name, provider]) => [name, provider.available]))
        });
      }
    };
    const poll = async () => {
      try {
        applyHealth(await probeHealth());
      } catch (requestError) {
        if (cancelled) return;
        failures += 1;
        if (firstFailureAt === 0) firstFailureAt = Date.now();
        wasReady = false;
        setMoving(false);
        setStartupPhase("connecting");
        // During installation the launcher replaces the core health service
        // with the prepared CUDA runtime. Keep the last
        // readout and stay quiet until the gap outlasts that handover. This is
        // measured in elapsed time, not polls, because the cadence below varies
        // with the event channel.
        setStartupError(
          isOutageReportable(firstFailureAt, Date.now())
            ? requestError instanceof Error ? requestError.message : "The local vision service is unavailable."
            : null,
        );
        appLog.warn("ui.startup.service-unavailable", {
          attempt: failures,
          outageMs: Date.now() - firstFailureAt,
          error: requestError instanceof Error ? requestError.message : requestError,
        });
      }
      if (cancelled) return;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(
        () => void poll(),
        healthPollDelayMs({
          connected: isChannelConnected(),
          failing: failures > 0,
          fastMs: HEALTH_POLL_INTERVAL_MS,
          backstopMs: HEALTH_SAFETY_POLL_MS,
        }),
      );
    };
    const stopHealthEvents = subscribeToHealthEvents(applyHealth);
    const stopChannelWatch = subscribeToChannelState((isConnected) => {
      // A dropped channel has to fail closed promptly, so resume the fast poll
      // immediately instead of waiting out the backstop interval.
      if (!isConnected && !cancelled) void poll();
    });
    void poll();
    return () => {
      cancelled = true;
      stopHealthEvents();
      stopChannelWatch();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if (startupPhase !== "ready" || !processingSessionReady || processingJobId !== null) return;
    const pendingFile = pendingFileRef.current;
    if (!pendingFile) return;
    pendingFileRef.current = null;
    appLog.info("workflow.analysis.startup-queue-drained", { name: pendingFile.name, bytes: pendingFile.size });
    void onFile(pendingFile);
    // Defer an opening file until startup and any recovered job have finished;
    // onFile remains the single entry point for validation and processing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startupPhase, processingSessionReady, processingJobId]);

  useEffect(() => {
    // Options and About render outside the shell, so the flag lives on the
    // document where every surface can see it.
    document.body.classList.toggle("reduced-effects", settings.appearance.reduceEffects);
  }, [settings.appearance.reduceEffects]);

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
    if (startupPhase !== "ready" || !project || phase !== "editing") return;
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
  }, [startupPhase, project?.id, phase]);

  useEffect(() => {
    if (startupPhase !== "ready" || !project || phase !== "selecting") return;
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
  }, [startupPhase, project?.id, phase]);

  useEffect(() => {
    if (startupPhase !== "ready" || !project || phase !== "selecting") return;
    let cancelled = false;
    void getLayerMergeHistory(project.id)
      .then((history) => {
        if (!cancelled) setMergeHistory(history[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setMergeHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [startupPhase, project?.id, phase]);

  useEffect(() => {
    if (startupPhase !== "ready" || !project || phase !== "editing" || maskEditor || !focusedInpaintTargetId || inpaintHistoryBusy) return;
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
  }, [startupPhase, project, phase, maskEditor, focusedInpaintTargetId, inpaintHistory, inpaintHistoryBusy]);

  useEffect(() => {
    if (startupPhase !== "ready" || !project || phase !== "selecting" || maskEditor || refiningLayerId || confirmingLayerId || !focusedMaskLayerId || maskHistoryBusy) return;
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
  }, [startupPhase, project, phase, maskEditor, refiningLayerId, confirmingLayerId, focusedMaskLayerId, maskHistory, maskHistoryBusy]);

  useEffect(() => {
    if (startupPhase !== "ready" || !project || phase !== "selecting" || maskEditor || refiningLayerId || confirmingLayerId || mergingLayers || mergeHistoryBusy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return;
      const eventTarget = event.target as HTMLElement | null;
      if (eventTarget?.closest("textarea, select, [contenteditable='true'], input:not([type='range']):not([type='checkbox']):not([type='radio'])")) return;
      const redo = event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey);
      const undo = event.key.toLowerCase() === "z" && !event.shiftKey;
      const focusedMaskHistory = focusedMaskLayerId ? maskHistory[focusedMaskLayerId] : null;
      if (focusedMaskHistory && ((undo && focusedMaskHistory.canUndo) || (redo && focusedMaskHistory.canRedo))) return;
      if ((!undo || !mergeHistory?.canUndo) && (!redo || !mergeHistory?.canRedo)) return;
      event.preventDefault();
      void restoreLayerMerge(redo ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [startupPhase, project, phase, maskEditor, refiningLayerId, confirmingLayerId, mergingLayers, mergeHistoryBusy, mergeHistory, focusedMaskLayerId, maskHistory]);

  function rememberProcessingJob(jobId: string, kind: ProcessingSession["kind"]): void {
    if (!mounted.current) return;
    const session = { jobId, kind, project, phase };
    activeProcessingSession.current = session;
    saveProcessingSession(session);
    setProcessingJobIdState(jobId);
  }

  function setProcessingJobId(jobId: string | null): void {
    if (!mounted.current) return;
    if (jobId === null && activeProcessingSession.current) {
      clearProcessingSession(activeProcessingSession.current.jobId);
      activeProcessingSession.current = null;
    }
    setProcessingJobIdState(jobId);
  }

  async function process(
    operation: (
      onProgress: (progress: ProcessingProgress) => void,
      onJobStarted: (jobId: string) => void
    ) => Promise<SceneProject>
  ): Promise<void> {
    if (startupPhase !== "ready" || !processingSessionReady || activeProcessingSession.current || phase === "analyzing" || phase === "inpainting") return;
    // A new analysis invalidates all transient editor/history state. Reset it
    // before changing phase so stale controls cannot target the next project.
    appLog.info("workflow.analysis.started");
    setError(null);
    setMoving(false);
    setLayerInpaintPrompt("");
    setShowInpaintMask(false);
    setBackgroundRetouchPending(false);
    setFocusedInpaintTargetId(null);
    setAnchorLayerId(null);
    setInpaintHistory({});
    setFocusedMaskLayerId(null);
    setMaskHistory({});
    setMaskHistoryBusy(null);
    setLayerSelection([]);
    setMergeHistory(null);
    setMergeHistoryBusy(null);
    setMergingLayers(false);
    setProcessingJobId(null);
    setCancellingJob(false);
    setMaskBlurRadius(0);
    setMaskEditor(null);
    setPhase("analyzing");
    setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: "Preparing the local AI job.", queuePosition: null });
    try {
      const result = await operation(setProcessingProgress, (jobId) => rememberProcessingJob(jobId, "analyze"));
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
    if (startupPhase !== "ready" || !processingSessionReady) {
      pendingFileRef.current = file;
      appLog.info("workflow.analysis.queued-until-startup", { name: file.name, bytes: file.size });
      return;
    }
    // Keep the detector choices with the request so the service and visible
    // settings remain a single source of truth for this analysis.
    await process((onProgress, onJobStarted) => analyzeImage(
      file,
      onProgress,
      onJobStarted,
      settings.processing.segmentationDensity,
      settings.processing.segmentationLabels,
      settings.processing.useVlmVocabularyProposer,
    ));
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
        message: cancelled.message,
        queuePosition: cancelled.queuePosition
      });
    } catch (operationError) {
      setCancellingJob(false);
      appLog.error("workflow.analysis-cancel.failed", operationError, { jobId });
      setError(operationError instanceof Error ? operationError.message : "The processing job could not be cancelled.");
    }
  }

  async function buildScene(): Promise<void> {
    if (startupPhase !== "ready" || !project) return;
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
    setMoving(false);
    setCamera(editingCameraDefaults);
    setPhase("inpainting");
    setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: "Preparing the local inpainting job.", queuePosition: null });
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
        (jobId) => rememberProcessingJob(jobId, "inpaint"),
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
    if (startupPhase !== "ready" || !project) return;
    setProject({ ...project, layers });
  }

  useEffect(() => {
    // Focusing a different card (or the background) leaves the drag pointing at
    // a layer the user is no longer looking at, so drop out of anchor mode.
    setAnchorLayerId((current) => current && current === focusedInpaintTargetId ? current : null);
  }, [focusedInpaintTargetId]);

  useEffect(() => {
    if (!buildCooldown) return;
    const timer = window.setTimeout(() => setBuildCooldown(false), BUILD_HANDOVER_COOLDOWN_MS);
    return () => window.clearTimeout(timer);
  }, [buildCooldown]);

  function runBuildAction(): void {
    // One button, two actions. The lock stops a burst of clicks from stacking
    // requests, and the cooldown that follows a bulk confirm keeps the last
    // click of that burst from landing on the generative build that replaces it.
    if (buildActionLock.current) return;
    buildActionLock.current = true;
    if (unconfirmedMaskCount > 0) {
      void confirmAllLayers().finally(() => {
        buildActionLock.current = false;
        setBuildCooldown(true);
      });
      return;
    }
    void buildScene().finally(() => {
      buildActionLock.current = false;
    });
  }

  function moveLayerAnchor(layerId: string, offsetX: number, offsetY: number): void {
    if (startupPhase !== "ready") return;
    // Anchors live in project state like depth and order do, so the canvas, the
    // PNG/video exports, and the saved package all read the same numbers.
    setProject((current) => current && ({
      ...current,
      layers: current.layers.map((layer) => layer.id === layerId ? { ...layer, offsetX, offsetY } : layer)
    }));
  }

  function selectLayer(layerId: string): void {
    if (startupPhase !== "ready") return;
    setLayerSelection((current) => current.includes(layerId)
      ? current.filter((id) => id !== layerId)
      : [...current, layerId]);
  }

  function clearLayerSelection(): void {
    if (startupPhase !== "ready") return;
    setLayerSelection([]);
  }

  function toggleSelectedLayers(): void {
    if (startupPhase !== "ready" || !project || layerSelection.length === 0) return;
    const selected = new Set(layerSelection);
    setProject({
      ...project,
      layers: project.layers.map((layer) => selected.has(layer.id)
        ? { ...layer, selected: !layer.selected }
        : layer)
    });
  }

  async function mergeSelectedLayers(): Promise<void> {
    if (startupPhase !== "ready" || !project || phase !== "selecting" || layerSelection.length < 2 || mergingLayers) return;
    const selected = new Set(layerSelection);
    const layerIds = project.layers.filter((layer) => selected.has(layer.id)).map((layer) => layer.id);
    if (layerIds.length < 2) {
      setLayerSelection([]);
      setError(t("layers.mergeRequiresMultiple"));
      return;
    }
    const survivorId = layerIds[0];
    setError(null);
    setMergingLayers(true);
    setMergeHistoryBusy(null);
    appLog.info("workflow.layer-merge.started", { projectId: project.id, layerCount: layerIds.length });
    try {
      const result = await mergeProjectLayers(project.id, layerIds);
      const merged = mergeProjectResult(project, result, { refreshLayerId: survivorId });
      setProject(merged);
      setLayerSelection(merged.layers.some((layer) => layer.id === survivorId) ? [survivorId] : []);
      setFocusedMaskLayerId(null);
      await Promise.all([refreshMaskHistory(project.id), refreshMergeHistory(project.id)]);
      appLog.info("workflow.layer-merge.completed", { projectId: project.id, layerCount: layerIds.length, survivorId });
    } catch (operationError) {
      appLog.error("workflow.layer-merge.failed", operationError, { projectId: project.id, layerCount: layerIds.length });
      setError(operationError instanceof Error ? operationError.message : t("error.mergeFailed"));
    } finally {
      setMergingLayers(false);
    }
  }

  function editLayerMask(layer: SceneLayer): void {
    if (startupPhase !== "ready") return;
    setError(null);
    setMoving(false);
    setCamera(editingCameraDefaults);
    setShowInpaintMask(false);
    setMaskBrushMode("add");
    setMaskBlurRadius(0);
    setMaskDirty(false);
    setMaskReady(false);
    setMaskCanUndo(false);
    setMaskCanRedo(false);
    setFocusedMaskLayerId(layer.id);
    setMaskEditorName(layer.name);
    setMaskEditor({ kind: "layer", layerId: layer.id, key: `layer:${layer.id}`, name: layer.name, maskUrl: layer.maskUrl });
  }

  function addLayerMask(): void {
    if (startupPhase !== "ready" || !project) return;
    setError(null);
    setMoving(false);
    setCamera(editingCameraDefaults);
    setShowInpaintMask(false);
    setMaskBrushMode("add");
    setMaskBlurRadius(0);
    setMaskDirty(false);
    setMaskReady(false);
    setMaskCanUndo(false);
    setMaskCanRedo(false);
    // An empty name lets the service assign the next "Area NN"; the heading
    // input above the canvas names it before it is created.
    setMaskEditorName("");
    setMaskEditor({
      kind: "new-layer",
      layerId: null,
      key: `new-layer:${Date.now()}`,
      name: "new foreground layer",
      maskUrl: null
    });
  }

  function editExtraMask(): void {
    if (startupPhase !== "ready" || !project) return;
    setError(null);
    setMoving(false);
    setCamera(editingCameraDefaults);
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
    if (startupPhase !== "ready" || !project?.backgroundUrl) return;
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
    setCamera(editingCameraDefaults);
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
    if (startupPhase !== "ready" || !project) return;
    if (project.engine !== "ai") {
      setError("Refine requires the Local AI engine and InSPyReNet.");
      return;
    }
    setError(null);
    setMoving(false);
    setShowInpaintMask(false);
    setFocusedMaskLayerId(layer.id);
    setRefiningLayerId(layer.id);
    setProcessingProgress({ state: "queued", progress: 0, stage: "Queued", message: `Preparing ${layer.name} for local refinement.`, queuePosition: null });
    setProcessingJobId(null);
    setCancellingJob(false);
    appLog.info("workflow.mask-refine.started", { projectId: project.id, layerId: layer.id });
    try {
      const result = await refineProjectLayer(project.id, layer.id, setProcessingProgress, (jobId) => rememberProcessingJob(jobId, "refine"));
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

  async function createLayerFromActiveMask(): Promise<SceneLayer | null> {
    if (startupPhase !== "ready" || !project || maskEditor?.kind !== "new-layer" || !canvasRef.current) return null;
    if (!maskDirty) {
      setError("Paint an area before adding it as a layer.");
      return null;
    }
    setError(null);
    setMaskSaving(true);
    appLog.info("workflow.layer-create.started", { projectId: project.id });
    try {
      const mask = await canvasRef.current.exportEditedMask();
      const result = await createProjectLayer(project.id, mask, maskEditorName.trim() || undefined);
      // The created layer is the one the project did not have before.
      const known = new Set(project.layers.map((layer) => layer.id));
      const created = result.layers.find((layer) => !known.has(layer.id)) ?? null;
      setProject(mergeProjectResult(project, result));
      setFocusedMaskLayerId(created?.id ?? null);
      cancelMaskEdit();
      appLog.info("workflow.layer-create.completed", { projectId: project.id, layerId: created?.id });
      return created;
    } catch (operationError) {
      appLog.error("workflow.layer-create.failed", operationError, { projectId: project.id });
      setError(operationError instanceof Error ? operationError.message : "The painted area could not be added as a layer.");
      return null;
    } finally {
      setMaskSaving(false);
    }
  }

  async function renameActiveLayer(): Promise<void> {
    if (startupPhase !== "ready" || !project || maskEditor?.kind !== "layer" || !maskEditor.layerId) return;
    const name = maskEditorName.trim();
    const current = project.layers.find((layer) => layer.id === maskEditor.layerId);
    if (!current || !name || name === current.name) {
      // Restore the stored name so an abandoned edit cannot leave the heading
      // showing something the project never accepted.
      setMaskEditorName(current?.name ?? "");
      return;
    }
    setRenamingLayer(true);
    appLog.info("workflow.layer-rename.started", { projectId: project.id, layerId: current.id });
    try {
      const result = await renameProjectLayer(project.id, current.id, name);
      setProject(mergeProjectResult(project, result));
      setMaskEditor((editor) => editor && editor.layerId === current.id ? { ...editor, name } : editor);
      appLog.info("workflow.layer-rename.completed", { projectId: project.id, layerId: current.id });
    } catch (operationError) {
      appLog.error("workflow.layer-rename.failed", operationError, { projectId: project.id, layerId: current.id });
      setError(operationError instanceof Error ? operationError.message : "The layer could not be renamed.");
      setMaskEditorName(current.name);
    } finally {
      setRenamingLayer(false);
    }
  }

  async function deleteLayer(layerId: string): Promise<void> {
    if (startupPhase !== "ready" || !project || deletingLayerId) return;
    const layer = project.layers.find((candidate) => candidate.id === layerId);
    if (!layer) return;
    setError(null);
    setDeletingLayerId(layerId);
    appLog.info("workflow.layer-delete.started", { projectId: project.id, layerId });
    try {
      const result = await deleteProjectLayer(project.id, layerId);
      setProject(mergeProjectResult(project, result));
      setLayerSelection((selection) => selection.filter((id) => id !== layerId));
      if (focusedMaskLayerId === layerId) setFocusedMaskLayerId(null);
      if (maskEditor?.layerId === layerId) cancelMaskEdit();
      // Deletion is stored in the reversible layer history, so refresh it.
      await refreshMergeHistory(project.id);
      appLog.info("workflow.layer-delete.completed", { projectId: project.id, layerId });
    } catch (operationError) {
      appLog.error("workflow.layer-delete.failed", operationError, { projectId: project.id, layerId });
      setError(operationError instanceof Error ? operationError.message : "The layer could not be deleted.");
    } finally {
      setDeletingLayerId(null);
    }
  }

  async function confirmLayer(layer: SceneLayer): Promise<void> {
    if (startupPhase !== "ready" || !project) return;
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

  async function confirmAllLayers(): Promise<void> {
    if (startupPhase !== "ready" || !project) return;
    const pending = project.layers.filter((layer) => layer.selected && !layer.confirmed);
    if (!pending.length) return;
    setError(null);
    setConfirmingAll(true);
    appLog.info("workflow.mask-confirm-all.started", { projectId: project.id, count: pending.length });
    // Each confirm returns its own project snapshot, so fold them one after the
    // other instead of racing several writes against the same scene metadata.
    let current = project;
    try {
      for (const layer of pending) {
        setConfirmingLayerId(layer.id);
        const result = await confirmProjectLayer(project.id, layer.id);
        current = mergeProjectResult(current, result);
        setProject(current);
      }
      appLog.info("workflow.mask-confirm-all.completed", { projectId: project.id, count: pending.length });
    } catch (operationError) {
      appLog.error("workflow.mask-confirm-all.failed", operationError, { projectId: project.id });
      setError(operationError instanceof Error ? operationError.message : "The selected mask could not be confirmed.");
    } finally {
      setConfirmingLayerId(null);
      setConfirmingAll(false);
    }
  }

  async function applyMaskEdit(): Promise<boolean> {
    if (startupPhase !== "ready" || !project || !maskEditor || !canvasRef.current) return false;
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
    if (startupPhase !== "ready" || !project || maskEditor?.kind !== "inpaint" || !canvasRef.current) return;
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
    let maskPreviewUrl: string | null = null;
    try {
      const [mask, composition] = await Promise.all([
        canvasRef.current.exportEditedMask(),
        canvasRef.current.exportInpaintComposition()
      ]);
      // Hand the painted area to the stage before the editor closes on the next
      // line, so the progress mosaic marks exactly what this job redraws.
      maskPreviewUrl = URL.createObjectURL(mask);
      setPendingInpaintMaskUrl(maskPreviewUrl);
      cancelMaskEdit();
      setMoving(false);
      setCamera(editingCameraDefaults);
      setPhase("inpainting");
      setProcessingProgress({
        state: "queued",
        progress: 0,
        stage: "Queued",
        message: `Preparing ${targetName} for full-redraw inpainting.`,
        queuePosition: null
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
        (jobId) => rememberProcessingJob(jobId, "target-inpaint"),
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
      setPendingInpaintMaskUrl(null);
      if (maskPreviewUrl) URL.revokeObjectURL(maskPreviewUrl);
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

  async function refreshMergeHistory(projectId: string): Promise<void> {
    const history = await getLayerMergeHistory(projectId);
    setMergeHistory(history[0] ?? null);
  }

  async function restoreLayerMerge(action: "undo" | "redo"): Promise<void> {
    if (startupPhase !== "ready" || !project || mergeHistoryBusy || mergingLayers || maskEditor || refiningLayerId || confirmingLayerId) return;
    if ((action === "undo" && !mergeHistory?.canUndo) || (action === "redo" && !mergeHistory?.canRedo)) return;
    setError(null);
    setMergeHistoryBusy(action);
    setLayerSelection([]);
    appLog.info("workflow.layer-merge-history.started", { projectId: project.id, action });
    try {
      const result = action === "undo"
        ? await undoProjectLayerMerge(project.id)
        : await redoProjectLayerMerge(project.id);
      const refreshed = {
        ...result,
        layers: result.layers.map((layer) => ({
          ...layer,
          maskUrl: refreshedAssetUrl(layer.maskUrl),
          cutoutUrl: refreshedAssetUrl(layer.cutoutUrl),
          proposalMaskUrl: layer.proposalMaskUrl ? refreshedAssetUrl(layer.proposalMaskUrl) : null
        }))
      };
      setProject(refreshed);
      await Promise.all([refreshMaskHistory(project.id), refreshMergeHistory(project.id)]);
      appLog.info("workflow.layer-merge-history.completed", { projectId: project.id, action });
    } catch (operationError) {
      appLog.error("workflow.layer-merge-history.failed", operationError, { projectId: project.id, action });
      setError(operationError instanceof Error ? operationError.message : t("error.mergeHistoryFailed"));
    } finally {
      setMergeHistoryBusy(null);
    }
  }

  async function restoreLayerRefine(layerId: string, action: "undo" | "redo"): Promise<void> {
    if (startupPhase !== "ready" || !project || maskHistoryBusy || maskEditor || refiningLayerId || confirmingLayerId) return;
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
    if (startupPhase !== "ready" || !project || !focusedInpaintTargetId || inpaintHistoryBusy || maskEditor) return;
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
    if (startupPhase !== "ready") return;
    canvasRef.current?.resetEditedMask();
    setMaskBlurRadius(0);
  }

  async function refineActiveMask(): Promise<void> {
    if (startupPhase !== "ready" || !project || !maskEditor) return;
    if (maskEditor.kind === "new-layer") {
      // A brushed area has to exist as a layer before it can be optimized.
      const created = await createLayerFromActiveMask();
      if (created) await refineLayerMask(created);
      return;
    }
    if (!maskEditor.layerId) return;
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
    if (startupPhase !== "ready") return;
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
    setLayerSelection([]);
    setMergeHistory(null);
    setMergeHistoryBusy(null);
    setMergingLayers(false);
    setProcessingJobId(null);
    setCancellingJob(false);
    setMaskBlurRadius(0);
    setMaskEditor(null);
    setProject(importedProject);
    setCamera({
      ...importedCamera,
      inverseDepth: importedCamera.inverseDepth ?? false,
      centerPull: importedCamera.centerPull ?? 0.5,
      sceneScale: importedCamera.sceneScale ?? 1,
      depthOfField: importedCamera.depthOfField ?? 0,
      focusDepth: importedCamera.focusDepth ?? 1
    });
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
    setAnchorLayerId(null);
    setInpaintHistory({});
    setInpaintHistoryBusy(null);
    setFocusedMaskLayerId(null);
    setMaskHistory({});
    setMaskHistoryBusy(null);
    setLayerSelection([]);
    setMergeHistory(null);
    setMergeHistoryBusy(null);
    setMergingLayers(false);
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
    setServiceConnection(
      normalized.service.origin,
      normalized.service.accessToken,
    );
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
  // The background plate has no anchor of its own; it is the reference everything
  // else is positioned against.
  const anchorTargetLayer = focusedInpaintTargetId && focusedInpaintTargetId !== "background"
    ? project?.layers.find((layer) => layer.id === focusedInpaintTargetId) ?? null
    : null;
  const maskHasChanges = maskDirty || maskBlurRadius > 0;
  const unconfirmedMaskCount = selectedLayers.filter((layer) => !layer.confirmed).length;
  const maskOperationActive = maskEditor !== null || refiningLayerId !== null || confirmingLayerId !== null;
  // The button drives two actions, so it stays shut through the handover from
  // confirming to building as well as while either one runs.
  const inpaintDisabled = maskOperationActive || selectedLayers.length === 0 || buildCooldown;
  const inpaintLabel = confirmingAll
    ? t("layers.confirming")
    : unconfirmedMaskCount > 0
      ? t("build.confirmMasks", { count: unconfirmedMaskCount })
      : backgroundRetouchPending
        ? t("build.rebuildBackground")
        : t("build.inpaintHoles");
  const startupReady = startupPhase === "ready";
  const startupGatePhase = startupPhase === "ready" ? "checking" : startupPhase;
  const busy = !startupReady || !processingSessionReady || phase === "analyzing" || phase === "inpainting" || processingJobId !== null || fileOperation !== null || maskSaving || refiningLayerId !== null || confirmingLayerId !== null || inpaintHistoryBusy !== null || maskHistoryBusy !== null;

  const acceptDroppedFile = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    void onFile(event.dataTransfer.files[0]);
  };

  return (
    <>
    {/* Normal service restarts retain the editor behind the startup gate. A
        first-time installation hides it completely until preparation passes.
        `inert` keeps a masked shell out of every interaction path. */}
    <main className="app-shell" hidden={shouldHideEditorDuringPreparation(preparationOnly, startupReady)} aria-busy={!startupReady} inert={!startupReady} onDragOver={(event) => event.preventDefault()} onDrop={acceptDroppedFile}>
      <button
        type="button"
        className={`panel-toggle panel-toggle-left ${openPanel === "left" ? "panel-open" : ""}`}
        aria-label={openPanel === "left" ? t("responsive.closePanel") : t("source.title")}
        aria-expanded={openPanel === "left"}
        aria-controls="workflow-rail"
        title={openPanel === "left" ? t("responsive.closePanel") : t("source.title")}
        onClick={() => setOpenPanel((current) => current === "left" ? null : "left")}
      >
        <span aria-hidden="true">{openPanel === "left" ? "‹" : "›"}</span>
      </button>
      <button
        type="button"
        className={`panel-toggle panel-toggle-right ${openPanel === "right" ? "panel-open" : ""}`}
        aria-label={openPanel === "right" ? t("responsive.closePanel") : t("inspector.title")}
        aria-expanded={openPanel === "right"}
        aria-controls="inspector-panel"
        title={openPanel === "right" ? t("responsive.closePanel") : t("inspector.title")}
        onClick={() => setOpenPanel((current) => current === "right" ? null : "right")}
      >
        <span aria-hidden="true">{openPanel === "right" ? "›" : "‹"}</span>
      </button>
      {openPanel !== null && (
        <button
          type="button"
          className="panel-scrim"
          aria-label={t("responsive.closePanel")}
          onClick={() => setOpenPanel(null)}
        />
      )}
      <aside id="workflow-rail" className={`workflow-rail ${openPanel === "left" ? "panel-open" : ""}`}>
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
        <div className="workflow-rail-scroll">
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
              settings.processing.segmentationLabels,
              settings.processing.useVlmVocabularyProposer,
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
        <ServerStatus health={health} startupPhase={startupPhase} />
        </div>
        <div className="workflow-rail-footer">
        {project && phase === "selecting" && (
          <section className="rail-ai-panel" aria-label={t("build.title")}>
            <span className="eyebrow">{t("build.title")}</span>
            <label>
              <span>{t("build.inpainter")}</span>
              <select value={refinement} onChange={(event) => changeRefinement(event.target.value as InpaintRefinement)}>
                <option value="lama">{t("build.lama")}</option>
                <option value="powerpaint" disabled={!health?.providers.refinement?.available}>{t("build.powerpaint")}</option>
              </select>
            </label>
            {refinement === "powerpaint" && (
              <label>
                <span>{t("build.backgroundPrompt")}</span>
                <input type="text" maxLength={500} value={inpaintPrompt} placeholder={t("build.backgroundPromptPlaceholder")} onChange={(event) => setInpaintPrompt(event.target.value)} />
              </label>
            )}
            {health && !health.providers.refinement?.available && (
              <span className="redraw-note warning">{t("build.fullRedrawUnavailable", { detail: runtimeText(health.providers.refinement?.detail ?? "") })}</span>
            )}
            {health?.providers.refinement?.warning && (
              <span className="redraw-note warning">{runtimeText(health.providers.refinement.warning)}</span>
            )}
          </section>
        )}
        {project && phase === "editing" && (
          <section className="rail-ai-panel" aria-label={t("build.layerInpaint")}>
            <span className="eyebrow">{t("build.layerInpaint")}</span>
            <span>{t("build.layerInpaintHelp")}</span>
            <label>
              <span>{t("build.inpaintPrompt")}</span>
              <textarea
                className="inpaint-prompt-textarea"
                rows={3}
                maxLength={500}
                value={layerInpaintPrompt}
                placeholder={t("build.inpaintPromptPlaceholder")}
                onChange={(event) => setLayerInpaintPrompt(event.target.value)}
              />
            </label>
          </section>
        )}
        </div>
      </aside>

      <section className="workspace">
        <div className="workspace-content">
            {processingProgress && (
              <div className="processing-status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <div className="processing-copy">
              <span className="eyebrow">{t("processing.local")}</span>
              <strong>{runtimeText(processingProgress.stage)}</strong>
              <span>{processingMessage}</span>
            </div>
            <div className="processing-actions">
              {processingProgress.queuePosition !== null && (
                <span className="processing-queue">{t("processing.queueAhead", { count: processingProgress.queuePosition })}</span>
              )}
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
            {/* Inpainting locks every control in this row and the processing
                banner above already reports the state, so drop it entirely and
                give the stage the height back. */}
            {phase !== "inpainting" && (
            <div className="stage-header">
              {/* The phase readout sits with the composition size so the action
                  row on the right keeps a single line on a narrow window. */}
              <div className="stage-summary">
                <span className="phase-label"><i className={busy ? "working" : ""} /> {backgroundRetouchPending && phase === "selecting" ? t("phase.retouchReady") : phaseLabel(phase, t)}</span>
                <div className="stage-summary-size">
                  <span className="eyebrow">{t("composition.title")}</span>
                  <strong>{project.width} x {project.height}</strong>
                </div>
              </div>
              {maskEditor && (
                <div className="mask-editor-heading" aria-live="polite">
                  {maskEditor.kind === "layer" || maskEditor.kind === "new-layer" ? (
                    // The heading is where a layer is named: on creation, and
                    // whenever its mask is reopened for editing.
                    <input
                      type="text"
                      className="mask-editor-name"
                      value={maskEditorName}
                      maxLength={80}
                      disabled={renamingLayer || maskSaving}
                      aria-label={t("layers.renameLabel")}
                      title={t("layers.renameTitle")}
                      placeholder={t("layers.namePlaceholder")}
                      onChange={(event) => setMaskEditorName(event.target.value)}
                      onBlur={() => void renameActiveLayer()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          setMaskEditorName(maskEditor.name);
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <strong>{layerName(maskEditor.name)}</strong>
                  )}
                </div>
              )}
              <div className="stage-status">
                <div className="stage-actions">
                  {/* The labels are trimmed to one word so the row still fits a
                      narrow window; the titles carry what each one exports. */}
                  <button type="button" className="secondary-button compact" disabled={busy} title={t("file.resetProjectTitle")} onClick={resetProject}>
                    {t("file.resetProject")}
                  </button>
                  <button type="button" className="secondary-button compact" disabled={busy} title={t("file.projectFileTitle")} onClick={() => void saveProjectPackage()}>
                    {fileOperation === "project" ? t("file.packing") : t("file.projectFile")}
                  </button>
                  {phase === "editing" && (
                    <>
                      <button type="button" className="secondary-button compact" disabled={busy} title={t("file.demoVideoTitle")} onClick={() => void saveCanvas("video")}>
                        {fileOperation === "video" ? t("file.rendering") : t("file.demoVideo")}
                      </button>
                      <button type="button" className="primary-button compact" disabled={busy} title={t("file.pngTitle")} onClick={() => void saveCanvas("png")}>
                        {fileOperation === "png" ? t("file.saving") : t("file.png")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            )}
            <SceneCanvas
              ref={canvasRef}
              project={project}
              camera={camera}
              interactive={startupReady && (phase === "selecting" || phase === "editing") && maskEditor === null}
              reviewingSource={phase === "selecting"}
              processing={phase === "inpainting"}
              pendingInpaintMaskUrl={pendingInpaintMaskUrl}
              inpaintProgress={processingProgress?.progress ?? 0}
              showInpaintMask={phase === "selecting" && showInpaintMask && maskEditor === null}
              maskEditor={maskEditor}
              showCompositionWhileMaskEditing={maskEditor?.kind === "inpaint"}
              brushMode={maskBrushMode}
              brushSize={maskBrushSize}
              maskBlurRadius={maskBlurRadius}
              motion={settings.motion}
              reduceMotion={settings.appearance.reduceMotion || Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)}
              reduceEffects={settings.appearance.reduceEffects}
              anchorLayerId={phase === "editing" && !maskEditor ? anchorLayerId : null}
              onLayerAnchorChange={moveLayerAnchor}
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
                <div className="brush-tool-controls">
                  <div className="brush-modes" aria-label={t("mask.brushMode")}>
                    <button type="button" className={maskBrushMode === "add" ? "active" : ""} onClick={() => setMaskBrushMode("add")}>{t("mask.add")}</button>
                    <button type="button" className={maskBrushMode === "erase" ? "active" : ""} onClick={() => setMaskBrushMode("erase")}>{t("mask.erase")}</button>
                  </div>
                  <div className="brush-history" aria-label={t("mask.history")}>
                    <button type="button" disabled={!maskCanUndo || maskSaving} onClick={() => canvasRef.current?.undoEditedMask()} title={t("mask.undoTitle")}>{t("mask.undo")}</button>
                    <button type="button" disabled={!maskCanRedo || maskSaving} onClick={() => canvasRef.current?.redoEditedMask()} title={t("mask.redoTitle")}>{t("mask.redo")}</button>
                  </div>
                </div>
                <div className="brush-controls">
                  <div className="brush-controls-heading">
                    <span className="eyebrow">{t("mask.brush")}</span>
                    <span className="brush-controls-description">{maskEditor.kind === "inpaint"
                      ? t("mask.inpaintHelp")
                      : maskEditor.kind === "new-layer"
                        ? t("mask.newLayerHelp")
                        : maskEditor.kind === "extra"
                          ? phase === "editing"
                            ? t("mask.extraRetouchHelp")
                            : t("mask.extraHelp")
                          : t("mask.layerHelp")}</span>
                  </div>
                  <div className="brush-slider-stack">
                    <label className="brush-size-control">
                      <span>{t("mask.sizeShort")}</span>
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
                  </div>
                </div>
                <div className="mask-toolbar-actions">
                  <div className="mask-toolbar-action-pair mask-toolbar-action-pair-primary">
                    {((maskEditor.kind === "layer" && activeEditedLayer) || maskEditor.kind === "new-layer") && project.engine === "ai" && (
                      <button
                        type="button"
                        className="secondary-button compact refine-action"
                        disabled={!maskReady || maskSaving || (maskEditor.kind === "new-layer" && !maskDirty)}
                        onClick={() => void refineActiveMask()}
                      >
                        {maskDirty ? t("mask.applyRefine") : t("mask.refine")}
                      </button>
                    )}
                    {maskEditor.kind === "inpaint" ? (
                      <button type="button" className="primary-button compact" disabled={!maskReady || !maskDirty || maskSaving} onClick={() => void inpaintActiveTarget()}>
                        {maskSaving ? t("mask.starting") : t("mask.inpaintLayer")}
                      </button>
                    ) : maskEditor.kind === "new-layer" ? (
                      <button type="button" className="primary-button compact" disabled={!maskReady || !maskDirty || maskSaving} onClick={() => void createLayerFromActiveMask()}>
                        {maskSaving ? t("mask.adding") : t("mask.addLayer")}
                      </button>
                    ) : (
                      <button type="button" className="primary-button compact" disabled={!maskReady || !maskHasChanges || maskSaving} onClick={() => void applyMaskEdit()}>
                        {maskSaving ? t("mask.applying") : t("mask.apply")}
                      </button>
                    )}
                  </div>
                  <div className="mask-toolbar-action-pair">
                    <button type="button" className="secondary-button compact" disabled={!maskHasChanges || maskSaving} onClick={resetActiveMask}>{t("mask.reset")}</button>
                    <button type="button" className="secondary-button compact" disabled={maskSaving} onClick={cancelMaskEdit}>{t("mask.cancel")}</button>
                  </div>
                </div>
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
        </div>
      </section>

      <aside id="inspector-panel" className={`inspector ${openPanel === "right" ? "panel-open" : ""}`}>
        {project ? (
          <>
            <div className="panel-heading inspector-heading">
              <div>
                <span className="eyebrow">{phase === "selecting" ? t("layers.proposals") : t("layers.sceneStack")}</span>
                <h2>{t("layers.foregroundCount", { count: project.layers.length })}</h2>
              </div>
              <span className="count-badge">{t("layers.onCount", { count: project.layers.filter((layer) => phase === "selecting" ? layer.selected : layer.visible).length })}</span>
            </div>
            <div className="inspector-scroll">
            <LayerInspector
              layers={project.layers}
              phase={phase}
              inverseDepth={camera.inverseDepth}
              onInverseDepthChange={(inverseDepth) => { setMoving(false); setCamera((current) => ({ ...current, inverseDepth })); }}
              editingLayerId={maskEditor?.kind === "layer" ? maskEditor.layerId : null}
              refiningLayerId={refiningLayerId}
              confirmingLayerId={confirmingLayerId}
              maskHistory={maskHistory}
              maskHistoryBusy={maskHistoryBusy}
              backgroundUrl={project.backgroundUrl}
              inpaintingTargetId={activeInpaintTargetId}
              focusedTargetId={focusedInpaintTargetId}
              layerInpaintAvailable={phase === "editing" && project.engine === "ai" && Boolean(health?.providers.refinement?.available)}
              onEditMask={editLayerMask}
              onUndoRefine={(layerId) => void restoreLayerRefine(layerId, "undo")}
              onRedoRefine={(layerId) => void restoreLayerRefine(layerId, "redo")}
              onConfirmMask={(layer) => void confirmLayer(layer)}
              selectedLayerIds={layerSelection}
              mergeHistory={mergeHistory}
              mergeHistoryBusy={mergeHistoryBusy}
              merging={mergingLayers}
              deletingLayerId={deletingLayerId}
              disabled={!startupReady}
              onCancelEdit={cancelMaskEdit}
              onDeleteLayer={(layerId) => void deleteLayer(layerId)}
              onSelectLayer={selectLayer}
              onClearSelection={clearLayerSelection}
              onToggleSelected={toggleSelectedLayers}
              onMergeSelected={() => void mergeSelectedLayers()}
              onUndoMerge={() => void restoreLayerMerge("undo")}
              onRedoMerge={() => void restoreLayerMerge("redo")}
              onInpaintTarget={editInpaintTarget}
              onFocusTarget={setFocusedInpaintTargetId}
              onChange={updateLayers}
            />
            </div>
            {phase === "selecting" && (
              <div className="build-panel build-scene-panel">
                <div className="build-options">
                  <strong>{t("build.title")}</strong>
                  <div className="extra-mask-option">
                    <div>
                      <span>{t("build.newLayer")}</span>
                      <small>{t("build.newLayerHelp")}</small>
                    </div>
                    <button type="button" disabled={maskEditor !== null} onClick={addLayerMask}>
                      {t("build.addLayer")}
                    </button>
                  </div>
                  {/* An area brushed before this became a layer stays editable. */}
                  {project.extraMaskUrl && (
                  <div className="extra-mask-option">
                    <div>
                      <span>{t("build.extraArea")}</span>
                      <small>{t("build.extraAreaHelp")}</small>
                    </div>
                    <button type="button" disabled={maskEditor !== null} onClick={editExtraMask}>
                      {t("build.editArea")}
                    </button>
                  </div>
                  )}
                </div>
                <button
                  type="button"
                  className="primary-button"
                  onPointerEnter={() => setShowInpaintMask(true)}
                  onPointerLeave={() => { setShowInpaintMask(false); setBuildCooldown(false); }}
                  onFocus={() => setShowInpaintMask(true)}
                  onBlur={() => setShowInpaintMask(false)}
                  disabled={inpaintDisabled}
                  title={unconfirmedMaskCount > 0 ? t("build.confirmMasksTitle") : undefined}
                  onClick={runBuildAction}
                >
                  {inpaintLabel}
                </button>
              </div>
            )}
            {phase === "editing" && (
              <div className="build-panel">
                <div className="build-options">
                  <strong>{t("build.layerInpaint")}</strong>
                  <span>{t("build.layerInpaintHelp")}</span>
                  <span className="redraw-note">{t("build.layerFullRedrawNote")}</span>
                  {anchorTargetLayer && (
                    <LayerAdjustments
                      layer={anchorTargetLayer}
                      camera={camera}
                      disabled={maskEditor !== null}
                      onChange={(change) => setProject((current) => current ? ({ ...current, layers: current.layers.map((layer) => layer.id === anchorTargetLayer.id ? { ...layer, ...change } : layer) }) : current)}
                    />
                  )}
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
                  {/* Anchoring targets the focused layer, matching how the undo
                      controls above already work. */}
                  <div className="inpaint-history-controls">
                    <span>{t("build.layerAnchor", {
                      x: (anchorTargetLayer?.offsetX ?? 0).toFixed(2),
                      y: (anchorTargetLayer?.offsetY ?? 0).toFixed(2)
                    })}</span>
                    <button
                      type="button"
                      className={anchorLayerId ? "active" : ""}
                      disabled={!anchorTargetLayer || maskEditor !== null}
                      aria-pressed={anchorLayerId !== null}
                      title={t("build.moveAnchorTitle")}
                      onClick={() => setAnchorLayerId((current) => current ? null : anchorTargetLayer?.id ?? null)}
                    >
                      {anchorLayerId ? t("build.stopAnchor") : t("build.moveAnchor")}
                    </button>
                    <button
                      type="button"
                      disabled={!anchorTargetLayer || (anchorTargetLayer.offsetX === 0 && anchorTargetLayer.offsetY === 0)}
                      title={t("build.resetAnchorTitle")}
                      onClick={() => anchorTargetLayer && moveLayerAnchor(anchorTargetLayer.id, 0, 0)}
                    >
                      {t("build.resetAnchor")}
                    </button>
                  </div>
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
                  {health?.providers.refinement?.warning && (
                    <span className="redraw-note warning">{runtimeText(health.providers.refinement.warning)}</span>
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
    </main>
    {!startupReady && (
      // Dropping a source image while the gate is up still queues it: the
      // overlay owns the pointer, so it carries the same drop target.
      <div
        className={`startup-overlay ${preparationOnly ? "preparation-only" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("startup.title")}
        onDragOver={(event) => event.preventDefault()}
        onDrop={acceptDroppedFile}
      >
        <StartupGate phase={startupGatePhase} health={health} error={startupError} t={t} />
      </div>
    )}
    {/* Dialogs sit outside the shell so Options and About stay usable while
        the startup gate holds the editor. */}
    {showOptions && <SettingsDialog settings={settings} onSave={saveSettings} onCancel={() => setShowOptions(false)} />}
    {showAbout && <AboutDialog version={appVersion} onClose={() => setShowAbout(false)} />}
    </>
  );
}
