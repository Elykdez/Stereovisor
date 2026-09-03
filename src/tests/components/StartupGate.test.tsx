import { render } from "@testing-library/react";
import { StartupGate } from "@/web/components/StartupGate";
import { i18n, type AppTranslate } from "@/web/i18n";
import type { HealthStatus } from "@/web/types";

const testHealth: HealthStatus = {
  status: "ok",
  version: "0.1.0",
  configuredMode: "auto",
  activeEngine: "ai",
  device: "cpu",
  localOnly: true,
  providers: {
    runtime: { available: false, detail: "Prepared. Verified when the local AI service starts.", state: "ready", progress: 100 },
    segmentation: { available: true, detail: "Grounding DINO-B and SAM 2.1 Small installed" },
    matting: { available: true, detail: "InSPyReNet installed" },
    depth: {
      available: false,
      detail: "Downloading depth model (42%).",
      state: "downloading",
      progress: 42,
    },
    inpainting: { available: false, detail: "Missing model assets: big-lama.pt" },
  },
  message: "Local AI is not ready.",
  startupState: "downloading",
  startupDetail: "Downloading required local model weights.",
  startupProvider: "depth",
  startupProgress: 42,
};

describe("StartupGate", () => {
  it("shows provider readiness while the local AI stack is checking", async () => {
    await i18n.changeLanguage("en");
    const t = ((key, values) => i18n.t(key, values)) as AppTranslate;
    const { getByRole, getByText } = render(
      <StartupGate phase="checking" health={testHealth} error={null} t={t} />,
    );

    expect(getByRole("heading", { name: "Downloading local AI models" })).toBeInTheDocument();
    expect(getByText("3 / 5")).toBeInTheDocument();
    expect(getByText("Local AI runtime")).toBeInTheDocument();
    expect(getByText("Segmentation models")).toBeInTheDocument();
    expect(getByText("Downloading depth model (42%).")).toBeInTheDocument();
    expect(getByText("Downloading 42%")).toBeInTheDocument();
    expect(getByRole("progressbar")).toHaveAttribute("aria-valuenow", "68");
  });

  it("keeps the last provider readout while the local service restarts", async () => {
    await i18n.changeLanguage("en");
    const t = ((key, values) => i18n.t(key, values)) as AppTranslate;
    const { getByRole, getByText } = render(
      <StartupGate phase="connecting" health={testHealth} error={null} t={t} />,
    );

    // The launcher swaps the core health service for the prepared CUDA one.
    // The headline reports the reconnect; the rows keep the last known truth.
    expect(getByRole("heading", { name: "Starting local service" })).toBeInTheDocument();
    expect(getByText("Waiting for the local service to respond.")).toBeInTheDocument();
    expect(getByText("3 / 5")).toBeInTheDocument();
  });

  it("keeps a service failure inside the startup lock", async () => {
    await i18n.changeLanguage("zh-CN");
    const t = ((key, values) => i18n.t(key, values)) as AppTranslate;
    const { getByRole, getByText } = render(
      <StartupGate phase="connecting" health={null} error="Local service failed with HTTP 502." t={t} />,
    );

    expect(getByRole("heading", { name: "正在启动本地服务" })).toBeInTheDocument();
    expect(getByText("本地服务失败，HTTP 状态码为 502。")).toBeInTheDocument();
  });
});
