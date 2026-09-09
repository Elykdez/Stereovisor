import type { HealthStatus, ProviderStatus } from "../types";

// Ordered startup items. The runtime is the local CUDA Python environment: on
// a first launch it is installed before any model weight can be fetched, so it
// needs its own row instead of leaving the gate empty for several minutes.
export const REQUIRED_AI_PROVIDERS = [
  "runtime",
  "segmentation",
  "matting",
  "depth",
  "inpainting",
] as const;

export type RequiredAiProvider = (typeof REQUIRED_AI_PROVIDERS)[number];

const PREPARING_STATES = new Set(["starting", "downloading", "initializing"]);

export function isProviderPrepared(
  provider: ProviderStatus | undefined,
): boolean {
  // The live probe is the authority. While the first-launch bootstrap runs,
  // the core-only service answering health cannot import the AI packages, so
  // it reports the stages that preparation has already finished instead.
  return Boolean(provider?.available || provider?.state === "ready");
}

export function readyProviderCount(health: HealthStatus | null): number {
  if (!health) return 0;
  return REQUIRED_AI_PROVIDERS.reduce(
    (count, key) => count + (isProviderPrepared(health.providers[key]) ? 1 : 0),
    0,
  );
}

export function startupProgressPercent(health: HealthStatus | null): number {
  if (!health) return 0;
  const completed = REQUIRED_AI_PROVIDERS.reduce((progress, key) => {
    const provider = health.providers[key];
    if (isProviderPrepared(provider)) return progress + 1;
    // Only the stage being prepared right now may move the bar. A blocked or
    // waiting item must never make the gate look like it is advancing.
    if (!provider || !PREPARING_STATES.has(provider.state ?? ""))
      return progress;
    return progress + Math.min(100, Math.max(0, provider.progress ?? 0)) / 100;
  }, 0);
  return Math.round((completed / REQUIRED_AI_PROVIDERS.length) * 100);
}

export function isLocalAiReady(health: HealthStatus | null): boolean {
  // Unlocking the editor requires the live probe on every required provider. A
  // bootstrap's own report is enough to show progress, never enough to unlock.
  return Boolean(
    health &&
    health.activeEngine === "ai" &&
    REQUIRED_AI_PROVIDERS.every((key) => health.providers[key]?.available),
  );
}

/**
 * How long a service outage may last before the gate surfaces an error.
 *
 * This is a duration, not a poll count: the readiness cadence varies with the
 * event channel, so a count would silently mean different things on different
 * transports. The launcher swaps the core health service for the prepared CUDA
 * runtime on every launch, and that handover must stay quiet.
 */
export const RECONNECT_GRACE_MS = 8000;

export function isOutageReportable(
  firstFailureAt: number,
  now: number,
): boolean {
  if (firstFailureAt === 0) return false;
  return now - firstFailureAt >= RECONNECT_GRACE_MS;
}

/**
 * Readiness polling cadence. Pushed frames make the poll a liveness backstop,
 * but an in-progress outage always polls fast so recovery is noticed promptly.
 */
export function healthPollDelayMs(options: {
  connected: boolean;
  failing: boolean;
  fastMs: number;
  backstopMs: number;
}): number {
  if (options.failing || !options.connected) return options.fastMs;
  return options.backstopMs;
}
