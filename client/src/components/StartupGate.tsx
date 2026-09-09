import type { AppTranslate } from "../i18n";
import type { HealthStatus } from "../types";
import {
  readyProviderCount,
  startupProgressPercent,
  REQUIRED_AI_PROVIDERS,
  type RequiredAiProvider,
} from "../lib/startup";

export type StartupPhase = "connecting" | "checking" | "blocked";

type GateState = StartupPhase | "starting" | "downloading" | "initializing";

interface StartupGateProps {
  phase: StartupPhase;
  health: HealthStatus | null;
  error: string | null;
  t: AppTranslate;
}

function providerLabel(key: RequiredAiProvider, t: AppTranslate): string {
  switch (key) {
    case "runtime":
      return t("startup.provider.runtime");
    case "segmentation":
      return t("startup.provider.segmentation");
    case "matting":
      return t("startup.provider.matting");
    case "depth":
      return t("startup.provider.depth");
    case "inpainting":
      return t("startup.provider.inpainting");
  }
}

function gateState(phase: StartupPhase, health: HealthStatus | null): GateState {
  // A lost connection outranks the last health snapshot. The rows below stay
  // on screen because they remain the most recent truth, but the headline must
  // not claim progress that nothing is reporting any more.
  if (phase === "connecting") return "connecting";
  const startupState = health?.startupState;
  if (startupState === "starting" || startupState === "downloading" || startupState === "initializing") {
    return startupState;
  }
  return phase;
}

function gateTitle(state: GateState, t: AppTranslate): string {
  switch (state) {
    case "connecting":
      return t("startup.connecting");
    case "starting":
      return t("startup.starting");
    case "downloading":
      return t("startup.downloading");
    case "initializing":
      return t("startup.initializing");
    case "checking":
      return t("startup.checking");
    case "blocked":
      return t("startup.blocked");
  }
}

function gateDetail(
  state: GateState,
  health: HealthStatus | null,
  error: string | null,
  ready: number,
  total: number,
  t: AppTranslate,
): string {
  if (error) {
    const httpFailure = error.match(/^Local service failed with HTTP (\d+)\.$/);
    return httpFailure ? t("error.http", { status: httpFailure[1] }) : error;
  }
  switch (state) {
    case "connecting":
      return t("startup.connectingDetail");
    case "starting":
      return health?.startupDetail ?? t("startup.startingDetail");
    case "downloading":
      return health?.startupDetail ?? t("startup.downloadingDetail");
    case "initializing":
      return health?.startupDetail ?? t("startup.initializingDetail");
    case "checking":
      return t("startup.checkingDetail", { ready, total });
    case "blocked":
      return health?.message ?? t("startup.blockedDetail");
  }
}

export function StartupGate({ phase, health, error, t }: StartupGateProps) {
  const readyCount = readyProviderCount(health);
  const total = REQUIRED_AI_PROVIDERS.length;
  const state = gateState(phase, health);
  const progress = startupProgressPercent(health);

  return (
    <section className="startup-gate" aria-live="polite">
      <div className="startup-card">
        <header className="startup-header">
          <span className="startup-spinner" aria-hidden="true" />
          <div>
            <span className="eyebrow">{t("startup.title")}</span>
            <h2>{gateTitle(state, t)}</h2>
          </div>
        </header>
        <p className="startup-detail">{gateDetail(state, health, error, readyCount, total, t)}</p>
        <div className="startup-progress-label">
          <span>{t("startup.required")}</span>
          <strong>{readyCount} / {total}</strong>
        </div>
        <div
          className="startup-progress-track"
          role="progressbar"
          aria-label={t("startup.required")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <i style={{ width: `${progress}%` }} />
        </div>
        <ul className="startup-provider-list">
          {REQUIRED_AI_PROVIDERS.map((key) => {
            const provider = health?.providers[key];
            const providerState = provider?.state ?? (!provider ? "waiting" : provider.available ? "ready" : "blocked");
            const stateLabel = providerState === "ready"
              ? t("startup.ready")
              : providerState === "downloading"
                ? t("startup.downloadingState")
                : providerState === "initializing"
                  ? t("startup.initializingState")
                  : providerState === "starting"
                    ? t("startup.startingState")
                    : providerState === "blocked"
                      ? t("startup.needsSetup")
                      : t("startup.pending");
            const providerProgress = provider?.progress == null || providerState === "ready" ? "" : ` ${provider.progress}%`;
            return (
              <li key={key} className={providerState}>
                <span className="startup-provider-dot" aria-hidden="true" />
                <div>
                  <strong>{providerLabel(key, t)}</strong>
                  <small>{provider?.detail ?? t("startup.waiting")}</small>
                </div>
                <em>{stateLabel}{providerProgress}</em>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
