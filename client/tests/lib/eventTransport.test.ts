import type { ProcessingProgress, SceneProject } from "@/types";

// The channel is mocked so one lifecycle can be replayed over both transports.
const channel = vi.hoisted(() => ({
  connected: false,
  listeners: new Set<(event: unknown) => void>(),
}));

vi.mock("@/lib/events", () => ({
  isChannelConnected: () => channel.connected,
  subscribeToJobEvents: (listener: (event: unknown) => void) => {
    channel.listeners.add(listener);
    return () => channel.listeners.delete(listener);
  },
  subscribeToHealthEvents: () => () => undefined,
  subscribeToChannelState: () => () => undefined,
  // Connected: a transition frame wakes the loop at once. Disconnected: the
  // caller waits out the full polling interval, as it always has.
  waitForJobEvent: (_jobId: string, timeoutMs: number) =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, channel.connected ? 0 : timeoutMs);
    }),
}));

const { waitForJob } = await import("@/lib/api");

const project: SceneProject = {
  id: "p",
  width: 8,
  height: 8,
  sourceUrl: "/source.png",
  backgroundUrl: null,
  unionMaskUrl: null,
  depthMapUrl: null,
  backgroundPrompt: null,
  inpaintProvider: null,
  vramPeaksMb: {},
  engine: "preview",
  layers: [],
};

const LIFECYCLE = [
  { state: "queued", progress: 0, stage: "Queued", message: "Waiting.", queuePosition: 1 },
  { state: "running", progress: 40, stage: "Segmenting", message: "Working.", queuePosition: null },
  { state: "completed", progress: 100, stage: "Complete", message: "Done.", queuePosition: null },
] as const;

function stubLifecycle(): void {
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const step = LIFECYCLE[Math.min(index, LIFECYCLE.length - 1)];
      index += 1;
      return new Response(
        JSON.stringify({
          jobId: "job-1",
          kind: "analyze",
          ...step,
          result: step.state === "completed" ? project : null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

async function runLifecycle(connected: boolean): Promise<ProcessingProgress[]> {
  channel.connected = connected;
  channel.listeners.clear();
  stubLifecycle();
  const seen: ProcessingProgress[] = [];
  const result = await waitForJob("job-1", (progress) => seen.push(progress));
  expect(result.id).toBe("p");
  return seen;
}

describe("job transport parity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    channel.connected = false;
    channel.listeners.clear();
  });

  it("reports the same progress sequence with and without the event channel", async () => {
    const pushed = await runLifecycle(true);
    const polled = await runLifecycle(false);

    expect(pushed).toEqual(polled);
    expect(pushed.map((entry) => entry.state)).toEqual([
      "queued",
      "running",
      "completed",
    ]);
  });

  it("resolves the project from HTTP rather than from a pushed frame", async () => {
    channel.connected = true;
    channel.listeners.clear();
    stubLifecycle();

    const result = await waitForJob("job-1", () => undefined);

    // Three HTTP reads: the socket carries transitions, never the payload.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(LIFECYCLE.length);
    expect(result).toEqual(project);
  });
});
