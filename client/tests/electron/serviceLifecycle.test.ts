import path from "node:path";
import {
  isCompatibleServiceHealth,
  managedPythonPath,
  probeStereovisorService,
  requiredModelFiles,
  requiredModelsReady,
  serviceLaunchPolicy,
  windowsRuntimeReady,
  parseRuntimePreparationStatus,
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
  it("requires completed setup and both downloaded environments before starting Python", () => {
    const root = "runtime";
    const missing = new Set<string>();
    const exists = (file: string) => !missing.has(file);
    expect(windowsRuntimeReady(root, exists)).toBe(true);
    missing.add(path.join(root, ".stereovisor-runtime-ready"));
    expect(windowsRuntimeReady(root, exists)).toBe(false);
    missing.clear();
    missing.add(managedPythonPath(root, ".venv-powerpaint", "win32"));
    expect(windowsRuntimeReady(root, exists)).toBe(false);
    missing.clear();
    missing.add(path.join(root, ".python-runtime", "tools", "python.exe"));
    expect(windowsRuntimeReady(root, exists)).toBe(false);
  });

  it("reads PowerShell bootstrap progress and preserves setup failures", () => {
    expect(parseRuntimePreparationStatus("\uFEFFdownloading\r\nDownloading Python.\r\nprovider=runtime\r\nprogress=42\r\n")).toEqual({
      state: "downloading", detail: "Downloading Python.", progress: 42,
    });
    expect(parseRuntimePreparationStatus("blocked\nChecksum failed.\nprogress=invalid")).toEqual({
      state: "blocked", detail: "Checksum failed.", progress: null,
    });
    expect(parseRuntimePreparationStatus("")).toEqual({ state: "starting", detail: null, progress: null });
    expect(parseRuntimePreparationStatus("initializing\nExtracting Python.\nprogress=101").progress).toBe(100);
  });

  it("resolves the same environment names using native executable layouts", () => {
    expect(managedPythonPath("/Applications/Stereovisor", ".venv-ai", "darwin")).toBe(
      "/Applications/Stereovisor/.venv-ai/bin/python",
    );
    expect(managedPythonPath("C:\\Stereovisor", ".venv-ai", "win32")).toBe(
      "C:\\Stereovisor\\.venv-ai\\Scripts\\python.exe",
    );
  });

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
