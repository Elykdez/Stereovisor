import {
  isCompatibleServiceHealth,
  probeStereovisorService,
  requiredModelFiles,
  requiredModelsReady,
  serviceLaunchPolicy,
} from "../../electron/serviceLifecycle";

const health = {
  status: "ok",
  version: "0.1.0",
  localOnly: true,
  providers: {
    runtime: {},
    segmentation: {},
    matting: {},
    depth: {},
    inpainting: {},
  },
};

describe("local service lifecycle", () => {
  it("distinguishes an installed offline model set from a stopped service", () => {
    const files = requiredModelFiles("C:\\Stereovisor\\models");
    const installed = new Set(files);

    expect(requiredModelsReady("C:\\Stereovisor\\models", (file) => installed.has(file))).toBe(true);
    installed.delete(files[3]);
    expect(requiredModelsReady("C:\\Stereovisor\\models", (file) => installed.has(file))).toBe(false);
  });

  it("keeps the hidden service owned by the app", () => {
    expect(serviceLaunchPolicy(false)).toEqual({
      detached: false,
      windowsHide: true,
      stdio: "pipe",
      stopWithApp: true,
    });
  });

  it("detaches the visible service so it survives the client", () => {
    expect(serviceLaunchPolicy(true)).toEqual({
      detached: true,
      windowsHide: false,
      stdio: "inherit",
      stopWithApp: false,
    });
  });

  it("accepts only the matching Stereovisor health contract", () => {
    expect(isCompatibleServiceHealth(health, "0.1.0")).toBe(true);
    expect(
      isCompatibleServiceHealth({ ...health, version: "0.2.0" }, "0.1.0"),
    ).toBe(false);
    expect(
      isCompatibleServiceHealth({ ...health, providers: {} }, "0.1.0"),
    ).toBe(false);
  });

  it("reuses a compatible service and forwards its access token", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      json: async () => health,
    }));

    await expect(
      probeStereovisorService(
        "http://127.0.0.1:5772",
        "0.1.0",
        " local-token ",
        request,
      ),
    ).resolves.toBe("reusable");
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:5772/api/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer local-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("distinguishes an occupied incompatible endpoint from an unused one", async () => {
    const incompatible = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "another-service" }),
    }));
    const unavailable = vi.fn(async () => {
      throw new TypeError("connection refused");
    });

    await expect(
      probeStereovisorService("http://127.0.0.1:5772", "0.1.0", "", incompatible),
    ).resolves.toBe("incompatible");
    await expect(
      probeStereovisorService("http://127.0.0.1:5772", "0.1.0", "", unavailable),
    ).resolves.toBe("unavailable");
  });
});
