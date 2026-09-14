import { useSyncExternalStore } from "react";
import { useAppTranslation } from "../i18n";
import { onServiceOriginChange, resolveServiceOrigin } from "../lib/serviceOrigin";
import type { HealthStatus } from "../types";
import { FpsCounter } from "./FpsCounter";
import type { StartupPhase } from "./StartupGate";

export function ServerStatus({ health, startupPhase }: {
  health: HealthStatus | null;
  startupPhase: StartupPhase | "ready";
}) {
  const { t } = useAppTranslation();
  const origin = useSyncExternalStore(onServiceOriginChange, resolveServiceOrigin);
  const hostname = origin ? new URL(origin).hostname : window.location.hostname;
  const local = hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  const location = t(local ? "server.local" : "server.remote");
  const activity = health?.activity;
  const available = !health ? t("server.checkingCompute")
    : health.activeEngine === "preview" ? t("server.preview")
    : /^(?:cuda(?::\d+)?|mps)$/i.test(health.device) ? t("server.gpuAvailable")
    : health.device.toLowerCase() === "cpu" ? t("server.cpuAvailable") : t("server.computeUnavailable");
  let status: string;
  let detail = available;
  let state: string;
  // A failed health request leaves the previous snapshot in App for diagnostics.
  // Never present that cached activity as current while reconnecting.
  if (startupPhase === "connecting" || !health) {
    state = "offline";
    status = t(health ? "server.reconnecting" : "server.connecting");
    detail = t("server.waitingConnection");
  } else if (activity?.state === "stopping") {
    state = "stopping";
    status = t("server.stopping");
  } else if (activity?.state === "queued") {
    state = "queued";
    status = t("server.queued");
  } else if (activity?.state === "running") {
    state = "running";
    status = t("server.working");
    detail = activity.compute ? t(activity.compute.device === "hybrid" ? "compute.hybrid"
      : activity.compute.device === "cuda" || activity.compute.device === "mps" ? "compute.gpu" : "compute.cpu") : t("server.checkingCompute");
  } else if (health.startupState === "ready") {
    state = "ready";
    status = t(activity ? "server.ready" : "server.connected");
  } else {
    state = "preparing";
    status = t("server.notReady");
  }
  const headline = t("server.headline", { location, status });
  const compute = state === "running" ? activity?.compute : null;
  const memoryAvailable = compute?.vramUsedMb != null && compute.vramTotalMb != null && compute.vramTotalMb > 0;
  const limitedMemory = memoryAvailable && compute.vramUsedMb! / compute.vramTotalMb! >= 0.9;
  return (
    <div className={`local-note server-status server-status-${state}`} title={`${headline}\n${detail}`}>
      <span className="local-pulse" aria-hidden="true" />
      <div className="server-status-copy" aria-live="polite">
        <strong>{headline}</strong>
        <small>{detail}</small>
      </div>
      <FpsCounter />
      {(memoryAvailable || compute?.gpuName) && (
        <div className="server-gpu">
          {compute?.gpuName && <span>{compute.gpuName}</span>}
          {memoryAvailable && <span>{t("compute.vram", {
            used: (compute.vramUsedMb! / 1024).toFixed(1),
            total: (compute.vramTotalMb! / 1024).toFixed(1),
          })}</span>}
          {limitedMemory && <span className="compute-warning">{t("compute.limitedMemory")}</span>}
        </div>
      )}
    </div>
  );
}
