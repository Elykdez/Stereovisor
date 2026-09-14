import { act, render } from "@testing-library/react";
import { ServerStatus } from "@/components/ServerStatus";
import { i18n } from "@/i18n";
import { setServiceConnection } from "@/lib/serviceOrigin";
import type { ComputeStatus, HealthStatus } from "@/types";

const health: HealthStatus = {
  status: "ok", version: "0.1.0", configuredMode: "ai", activeEngine: "ai", device: "cuda",
  localOnly: true, providers: {}, message: "Local AI ready.", startupState: "ready",
  startupDetail: null, startupProvider: null, startupProgress: null,
  activity: { state: "idle", queuedJobs: 0, stage: null, compute: null },
};
const compute: ComputeStatus = {
  model: "Qwen3-VL", device: "cpu", phase: "loading", reason: "cuda_unavailable",
  elapsedSeconds: 123, idleSeconds: 32,
};

describe("sidebar server status", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    setServiceConnection("http://127.0.0.1:5772", "");
  });
  afterEach(() => { act(() => setServiceConnection("", "")); });

  it.each(["cpu", "cuda", "hybrid"] as const)("shows actual %s work from the server in two lines", (device) => {
    const view = render(<ServerStatus startupPhase="ready" health={{ ...health,
      activity: { state: "running", queuedJobs: 2, stage: "Describing background", compute: { ...compute, device } },
    }} />);
    const detail = device === "cpu" ? "CPU compute" : device === "cuda" ? "GPU compute" : "GPU + CPU offload";
    expect(view.getByText("Local server / Busy")).toBeInTheDocument();
    expect(view.getByText(detail)).toBeInTheDocument();
    expect(view.container.querySelector(".server-status-copy")?.children).toHaveLength(2);
    expect(view.container.querySelector(".fps-counter")).toBeInTheDocument();
    expect(view.container.querySelector(".local-note")).toHaveAttribute("title", `Local server / Busy\n${detail}`);
    expect(view.container.innerHTML).not.toMatch(/Qwen3-VL|Loading weights|Describing background|elapsed|tokens/);
  });

  it.each([
    ["cpu", "ai", "CPU available"],
    ["cuda:0", "ai", "GPU available"],
    ["cuda-unavailable", "ai", "Compute unavailable"],
    ["cpu", "preview", "Preview mode"],
  ] as const)("shows availability for an idle %s %s server", (device, activeEngine, detail) => {
    const view = render(<ServerStatus startupPhase="ready" health={{ ...health, device, activeEngine }} />);
    expect(view.getByText("Local server / Ready")).toBeInTheDocument();
    expect(view.getByText(detail)).toBeInTheDocument();
    expect(view.queryByText(/CPU compute|GPU compute/)).not.toBeInTheDocument();
  });

  it("shows the server's reported GPU and memory in the sidebar and clears them after work", () => {
    setServiceConnection("https://vision.example", "");
    const gpuHealth: HealthStatus = { ...health, activity: { state: "running", queuedJobs: 0,
      stage: "Describing background", compute: { ...compute, device: "hybrid", reason: "offloading",
        gpuName: "NVIDIA GeForce RTX 3070", vramUsedMb: 7680, vramTotalMb: 8192 } } };
    const view = render(<ServerStatus startupPhase="ready" health={gpuHealth} />);
    expect(view.getByText("Remote server / Busy")).toBeInTheDocument();
    expect(view.getByText("NVIDIA GeForce RTX 3070")).toBeInTheDocument();
    expect(view.getByText("VRAM (last reported): 7.5 / 8.0 GiB")).toBeInTheDocument();
    expect(view.getByText("Limited VRAM headroom")).toBeInTheDocument();
    expect(view.container.innerHTML).not.toMatch(/Qwen3-VL|Loading weights|Describing background|elapsed|tokens/);
    view.rerender(<ServerStatus startupPhase="ready" health={{ ...gpuHealth, activity: {
      ...gpuHealth.activity!, compute: { ...gpuHealth.activity!.compute!, vramUsedMb: 1024 },
    } }} />);
    expect(view.getByText("VRAM (last reported): 1.0 / 8.0 GiB")).toBeInTheDocument();
    expect(view.queryByText("Limited VRAM headroom")).not.toBeInTheDocument();
    view.rerender(<ServerStatus startupPhase="connecting" health={gpuHealth} />);
    expect(view.queryByText(/NVIDIA|VRAM/)).not.toBeInTheDocument();
    view.rerender(<ServerStatus startupPhase="ready" health={health} />);
    expect(view.queryByText(/NVIDIA|VRAM/)).not.toBeInTheDocument();
  });

  it.each([undefined, 0])("does not invent GPU memory when the total is %s", (vramTotalMb) => {
    const view = render(<ServerStatus startupPhase="ready" health={{ ...health,
      activity: { state: "running", queuedJobs: 0, stage: null, compute: { ...compute,
        device: "cuda", gpuName: "NVIDIA Test GPU", vramUsedMb: 512, vramTotalMb } },
    }} />);
    expect(view.getByText("NVIDIA Test GPU")).toBeInTheDocument();
    expect(view.queryByText(/VRAM/)).not.toBeInTheDocument();
  });

  it.each([
    ["http://localhost:5772", "Local"],
    ["http://127.0.0.2:5772", "Local"],
    ["http://[::1]:5772", "Local"],
    ["http://192.168.1.20:5772", "Remote"],
    ["https://127.example.com", "Remote"],
    ["https://vision.example", "Remote"],
  ])("uses resolved origin %s to identify a %s server", (origin, location) => {
    setServiceConnection(origin, "");
    const view = render(<ServerStatus startupPhase="ready" health={health} />);
    expect(view.getByText(`${location} server / Ready`)).toBeInTheDocument();
    // localOnly describes the server's bind/privacy policy, not client proximity.
    view.rerender(<ServerStatus startupPhase="ready" health={{ ...health, localOnly: false }} />);
    expect(view.getByText(`${location} server / Ready`)).toBeInTheDocument();
  });

  it("updates location when connection settings change and resolves relative browser requests", () => {
    const view = render(<ServerStatus startupPhase="ready" health={health} />);
    expect(view.getByText("Local server / Ready")).toBeInTheDocument();
    act(() => setServiceConnection("https://vision.example", ""));
    expect(view.getByText("Remote server / Ready")).toBeInTheDocument();
    act(() => setServiceConnection("", ""));
    expect(window.location.hostname).toBe("localhost");
    expect(view.getByText("Local server / Ready")).toBeInTheDocument();
  });

  it("overrides cached server activity while reconnecting", () => {
    const cached: HealthStatus = { ...health, activity: { state: "running", queuedJobs: 0,
      stage: "Describing background", compute } };
    const view = render(<ServerStatus startupPhase="connecting" health={cached} />);
    expect(view.getByText("Local server / Reconnecting")).toBeInTheDocument();
    expect(view.getByText("Waiting for connection")).toBeInTheDocument();
    expect(view.queryByText("CPU compute")).not.toBeInTheDocument();
    expect(view.queryByText(/Qwen3-VL/)).not.toBeInTheDocument();
    view.rerender(<ServerStatus startupPhase="connecting" health={health} />);
    expect(view.queryByText(/GPU available|CPU available|Ready/)).not.toBeInTheDocument();
    view.rerender(<ServerStatus startupPhase="connecting" health={null} />);
    expect(view.getByText("Local server / Connecting")).toBeInTheDocument();
  });

  it("reports queued work and stopping without reusing the old compute label", () => {
    const view = render(<ServerStatus startupPhase="ready" health={{ ...health,
      activity: { state: "queued", queuedJobs: 1, stage: null, compute },
    }} />);
    expect(view.getByText("Local server / Queued")).toBeInTheDocument();
    expect(view.getByText("GPU available")).toBeInTheDocument();
    expect(view.queryByText("CPU compute")).not.toBeInTheDocument();
    view.rerender(<ServerStatus startupPhase="ready" health={{ ...health,
      activity: { state: "stopping", queuedJobs: 0, stage: "Cancelled", compute },
    }} />);
    expect(view.getByText("Local server / Stopping")).toBeInTheDocument();
    expect(view.getByText("GPU available")).toBeInTheDocument();
    expect(view.queryByText("CPU compute")).not.toBeInTheDocument();
  });

  it("keeps task-specific text out of the sidebar when compute details have not arrived", async () => {
    await i18n.changeLanguage("zh-CN");
    const view = render(<ServerStatus startupPhase="ready" health={{ ...health,
      activity: { state: "running", queuedJobs: 0, stage: "Describing background", compute: null },
    }} />);
    expect(view.getByText(i18n.t("server.headline", { location: i18n.t("server.local"), status: i18n.t("server.working") }))).toBeInTheDocument();
    expect(view.getByText(i18n.t("server.checkingCompute"))).toBeInTheDocument();
    expect(view.container.innerHTML).not.toContain(i18n.t("runtime.describingBackground"));
    expect(view.queryByText(/CPU|GPU/)).not.toBeInTheDocument();
  });

  it("does not claim an older server is idle or ready while it is still preparing", () => {
    const view = render(<ServerStatus startupPhase="ready" health={{ ...health, activity: undefined }} />);
    expect(view.getByText("Local server / Connected")).toBeInTheDocument();
    expect(view.getByText("GPU available")).toBeInTheDocument();
    expect(view.queryByText("Local server / Ready")).not.toBeInTheDocument();
    view.rerender(<ServerStatus startupPhase="checking" health={{ ...health, activity: undefined,
      startupState: "initializing", startupDetail: "Initializing models" }} />);
    expect(view.getByText("Local server / Not ready")).toBeInTheDocument();
    expect(view.container.innerHTML).not.toContain("Initializing models");
    expect(view.queryByText("Local server / Ready")).not.toBeInTheDocument();
  });
});
