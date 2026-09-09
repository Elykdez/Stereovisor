import {
  healthPollDelayMs,
  isLocalAiReady,
  isOutageReportable,
  readyProviderCount,
  RECONNECT_GRACE_MS,
  startupProgressPercent,
} from "@/lib/startup";
import type { HealthStatus } from "@/types";

function health(overrides: Partial<HealthStatus> = {}): HealthStatus {
  return {
    status: "ok",
    version: "0.1.0",
    configuredMode: "auto",
    activeEngine: "ai",
    device: "cpu",
    localOnly: true,
    providers: {
      runtime: { available: true, detail: "ready" },
      segmentation: { available: true, detail: "ready" },
      matting: { available: true, detail: "ready" },
      depth: { available: true, detail: "ready" },
      inpainting: { available: true, detail: "ready" },
    },
    message: "Local AI ready.",
    startupState: "ready",
    startupDetail: null,
    startupProvider: null,
    startupProgress: null,
    ...overrides,
  };
}

describe("startup readiness", () => {
  it("requires the AI engine and every core provider", () => {
    expect(isLocalAiReady(health())).toBe(true);
    expect(isLocalAiReady(health({ activeEngine: "preview" }))).toBe(false);
    expect(isLocalAiReady(health({ providers: { ...health().providers, depth: { available: false, detail: "missing" } } }))).toBe(false);
    expect(isLocalAiReady(health({ providers: { ...health().providers, runtime: { available: false, detail: "missing" } } }))).toBe(false);
  });

  it("never unlocks on a bootstrap-reported stage alone", () => {
    // The preparing bootstrap may report a finished stage the core-only health
    // service cannot verify. That is progress, not permission to edit.
    const reported = health({
      providers: { ...health().providers, depth: { available: false, detail: "prepared", state: "ready" } },
    });

    expect(isLocalAiReady(reported)).toBe(false);
    expect(readyProviderCount(reported)).toBe(5);
  });

  it("counts only the required providers", () => {
    expect(readyProviderCount(null)).toBe(0);
    expect(readyProviderCount(health())).toBe(5);
    expect(readyProviderCount(health({ providers: { ...health().providers, matting: { available: false, detail: "missing" } } }))).toBe(4);
  });

  it("advances progress only for the stage being prepared", () => {
    const providers = health().providers;
    const preparing = health({
      providers: {
        ...providers,
        depth: { available: false, detail: "downloading", state: "downloading", progress: 50 },
        inpainting: { available: false, detail: "waiting", state: "waiting", progress: 90 },
      },
    });

    expect(startupProgressPercent(null)).toBe(0);
    expect(startupProgressPercent(health())).toBe(100);
    // Three ready stages plus half of the downloading one; the waiting stage
    // contributes nothing even though it carries a stale percentage.
    expect(startupProgressPercent(preparing)).toBe(70);
  });
});

describe("outage reporting", () => {
  it("stays quiet until the outage outlasts the launcher handover", () => {
    const start = 1_000_000;

    expect(isOutageReportable(start, start)).toBe(false);
    expect(isOutageReportable(start, start + RECONNECT_GRACE_MS - 1)).toBe(false);
    expect(isOutageReportable(start, start + RECONNECT_GRACE_MS)).toBe(true);
  });

  it("reports nothing while no failure has been recorded", () => {
    expect(isOutageReportable(0, 9_999_999)).toBe(false);
  });

  it("is measured in time, so the transport cannot change the window", () => {
    // The regression this guards: expressing the grace in polls meant the
    // window silently became 8x longer once pushed frames slowed the cadence.
    const start = 500;
    const elapsed = start + RECONNECT_GRACE_MS;

    expect(isOutageReportable(start, elapsed)).toBe(true);
  });
});

describe("readiness polling cadence", () => {
  const cadence = { fastMs: 1000, backstopMs: 15000 };

  it("uses the backstop only while connected and healthy", () => {
    expect(healthPollDelayMs({ ...cadence, connected: true, failing: false })).toBe(15000);
  });

  it("polls fast whenever the channel is down", () => {
    expect(healthPollDelayMs({ ...cadence, connected: false, failing: false })).toBe(1000);
  });

  it("polls fast during an outage even with the channel up", () => {
    // Otherwise the first failure would not be re-checked for 15 seconds.
    expect(healthPollDelayMs({ ...cadence, connected: true, failing: true })).toBe(1000);
  });
});
