import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSettings, writeSettings } from "./settings";
import {
  managedPythonPath,
  probeStereovisorService,
  requiredModelsReady,
  serviceLaunchPolicy,
  windowsRuntimeReady,
  parseRuntimePreparationStatus,
  type RuntimePreparationStatus,
} from "./serviceLifecycle";
import {
  nativeMessages,
  type AppLocale,
  type NativeMessage,
} from "./nativeMessages";

let mainWindow: BrowserWindow | null = null;
let serviceProcess: ChildProcess | null = null;
let modelPreparationProcess: ChildProcess | null = null;
let runtimePreparationProcess: ChildProcess | null = null;
let runtimePreparationActive = false;
let runtimePreparationFailure: string | null = null;
let serviceStopsWithApp = true;
let appIsQuitting = false;
let preparationWindowActive = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let appLocale: AppLocale = "en";

function electronLog(event: string, context?: Record<string, unknown>): void {
  const message = `[Stereovisor][electron] ${event}`;
  context && Object.keys(context).length > 0
    ? console.info(message, context)
    : console.info(message);
}

function normalizeLocale(locale: string): AppLocale {
  const normalized = locale.replace("_", "-").toLowerCase();
  if (
    normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized === "zh-sg" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
  )
    return "zh-CN";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  return "en";
}

function nativeText(key: NativeMessage): string {
  return nativeMessages[appLocale][key];
}

async function installReactDevTools(): Promise<void> {
  // Keep the extension out of packaged builds: it is a development aid and
  // electron-devtools-installer downloads it from the Chrome Web Store.
  if (app.isPackaged || !process.env.VITE_DEV_SERVER_URL) return;

  try {
    const { default: installExtension, REACT_DEVELOPER_TOOLS } = await import(
      "electron-devtools-installer"
    );
    const extension = await installExtension(REACT_DEVELOPER_TOOLS, {
      // The dev renderer normally uses http://, but this also keeps the
      // extension useful if a local file URL is used during development.
      loadExtensionOptions: { allowFileAccess: true },
    });
    electronLog("devtools.react.installed", {
      id: extension.id,
      name: extension.name,
    });
  } catch (error) {
    // DevTools are optional. A blocked network or stale Chrome Web Store
    // package must not prevent the renderer from starting.
    console.warn("[Stereovisor][electron] React Developer Tools unavailable", error);
  }
}

function appRoot(): string {
  // In a packaged build the renderer lives in app.asar. In development the
  // compiled Electron code lives in client/dist-electron, so both resolve from the
  // application root instead of relying on the current working directory.
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "../..");
}

function resourceRoot(): string {
  // electron-builder places extraResources beside app.asar under resources.
  return app.isPackaged ? process.resourcesPath : appRoot();
}

function usesBundledPosixRuntime(): boolean {
  return app.isPackaged && process.platform !== "win32";
}

function runtimeRoot(): string {
  return app.isPackaged && process.platform === "win32"
    ? path.join(app.getPath("userData"), "runtime")
    : resourceRoot();
}

async function runtimePreparationStatus(): Promise<RuntimePreparationStatus | null> {
  if (!runtimePreparationActive && !runtimePreparationFailure) return null;
  let status: RuntimePreparationStatus = { state: "starting", detail: null, progress: null };
  try {
    status = parseRuntimePreparationStatus(await readFile(
      path.join(findPackagedModelRoot(), ".stereovisor-bootstrap-status"), "utf8",
    ));
  } catch {
    // The first status file is written after the preparation process starts.
  }
  return runtimePreparationFailure
    ? { ...status, state: "blocked", detail: status.state === "blocked" && status.detail ? status.detail : runtimePreparationFailure }
    : status;
}

async function prepareAndStartService(showConsole: boolean, accessToken = ""): Promise<void> {
  if (app.isPackaged && process.platform === "win32" && !windowsRuntimeReady(runtimeRoot())) {
    runtimePreparationActive = true;
    runtimePreparationFailure = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("powershell.exe", [
          "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
          path.join(resourceRoot(), "service", "scripts", "setup-packaged-runtime.ps1"),
          "-ResourceRoot", resourceRoot(), "-RuntimeRoot", runtimeRoot(),
          "-ModelRoot", findPackagedModelRoot(),
        ], { cwd: resourceRoot(), windowsHide: !showConsole, stdio: showConsole ? "inherit" : "pipe" });
        runtimePreparationProcess = child;
        child.stdout?.on("data", (chunk: Buffer) => console.info("[Stereovisor][runtime]", chunk.toString().trimEnd()));
        child.stderr?.on("data", (chunk: Buffer) => console.warn("[Stereovisor][runtime]", chunk.toString().trimEnd()));
        child.once("error", reject);
        child.once("exit", (code) => {
          runtimePreparationProcess = null;
          if (code === 0 && windowsRuntimeReady(runtimeRoot())) resolve();
          else reject(new Error(`Runtime preparation exited with code ${code}.`));
        });
      });
    } catch (error) {
      runtimePreparationFailure = error instanceof Error ? error.message : String(error);
      console.error("[Stereovisor][runtime] Preparation failed", error);
      return;
    } finally {
      runtimePreparationActive = false;
    }
  }
  if (appIsQuitting) return;
  await startService(showConsole, accessToken);
  startPackagedModelPreparation(showConsole);
}

function findPackagedModelRoot(): string {
  const configured = process.env.STEREOVISOR_MODEL_ROOT?.trim();
  if (configured) return configured;
  if (!app.isPackaged) return path.join(appRoot(), "service", ".models");

  // An unpacked build placed under the repository can reuse the existing model
  // cache. An installed build falls back to a writable per-user location.
  const searchRoots = [path.resolve(resourceRoot()), path.dirname(process.execPath)];
  for (const root of searchRoots) {
    let cursor = root;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = path.join(cursor, "service", ".models");
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return path.join(app.getPath("userData"), "models");
}

function startPackagedModelPreparation(showConsole: boolean): void {
  if (!app.isPackaged || process.env.STEREOVISOR_MODE === "preview") return;
  const root = resourceRoot();
  const modelRoot = findPackagedModelRoot();
  if (requiredModelsReady(modelRoot)) {
    electronLog("models.bootstrap.skipped-ready", { modelRoot });
    return;
  }
  const script = path.join(
    root,
    "service",
    "scripts",
    process.platform !== "win32"
      ? "prepare-packaged-ai.py"
      : "prepare-packaged-ai.ps1",
  );
  if (!existsSync(script)) {
    console.error("[Stereovisor][electron] Packaged model preparation script is missing", script);
    return;
  }
  const python =
    process.platform !== "win32"
      ? path.join(root, ".python-runtime", "bin", "python3")
      : managedPythonPath(root, ".venv-ai");
  if (process.platform !== "win32" && !existsSync(python)) {
    console.error("[Stereovisor][electron] Packaged AI runtime is missing", python);
    return;
  }
  const marker = path.join(modelRoot, ".stereovisor-bootstrap-running");
  if (existsSync(marker)) {
    // A force-quit can leave the marker behind after its child has gone away.
    // Single-instance locking means no other Stereovisor bootstrap can own it,
    // so clear the stale marker and start preparation again.
    electronLog("models.bootstrap.stale-marker", { modelRoot });
    try {
      unlinkSync(marker);
    } catch (error) {
      console.warn("[Stereovisor][electron] Could not clear stale model marker", error);
    }
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    STEREOVISOR_APP_ROOT: root,
    STEREOVISOR_MODEL_ROOT: modelRoot,
    PYTHONNOUSERSITE: "1",
  };
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  if (process.platform !== "win32") {
    // Packaged POSIX resources are signed or read-only, so bytecode belongs nowhere inside them.
    environment.PYTHONDONTWRITEBYTECODE = "1";
  }
  const command = process.platform !== "win32" ? python : "powershell.exe";
  const spawnArguments =
    process.platform !== "win32"
      ? [script, "--resource-root", root, "--model-root", modelRoot]
      : [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-ResourceRoot",
          root,
          "-ModelRoot",
          modelRoot,
          "-RuntimeRoot",
          runtimeRoot(),
        ];
  modelPreparationProcess = spawn(
    command,
    spawnArguments,
    {
      cwd: root,
      windowsHide: process.platform === "win32" && !showConsole,
      // Same reasoning as the service above: the bootstrap shares this setting,
      // and its first-run progress is the output most worth seeing in a console.
      stdio: showConsole ? "inherit" : "pipe",
      env: environment,
    },
  );
  electronLog("models.bootstrap.started", { modelRoot });
  modelPreparationProcess.stdout?.setEncoding("utf8");
  modelPreparationProcess.stdout?.on("data", (chunk: string) => {
    const output = chunk.trimEnd();
    if (output) console.info("[Stereovisor][models]", output);
  });
  modelPreparationProcess.stderr?.setEncoding("utf8");
  modelPreparationProcess.stderr?.on("data", (chunk: string) => {
    const output = chunk.trimEnd();
    if (output) console.warn("[Stereovisor][models]", output);
  });
  modelPreparationProcess.on("exit", (code, signal) => {
    electronLog("models.bootstrap.exited", { code, signal });
    modelPreparationProcess = null;
  });
  modelPreparationProcess.on("error", (error) => {
    console.error("[Stereovisor][electron] Local model preparation failed", error);
  });
}

function localServiceOrigin(): string {
  const configured = Number.parseInt(
    process.env.STEREOVISOR_SERVICE_PORT ?? "",
    10,
  );
  const port =
    Number.isInteger(configured) && configured >= 1 && configured <= 65535
      ? configured
      : 5772;
  return `http://127.0.0.1:${port}`;
}

async function startService(
  showConsole: boolean,
  accessToken = "",
): Promise<void> {
  // Development uses the separately launched service. Packaged mode either
  // reuses the persistent visible service or launches a predictable local child.
  if (process.env.VITE_DEV_SERVER_URL) {
    electronLog("service.start.skipped-dev");
    return;
  }
  if (showConsole) {
    const origin = localServiceOrigin();
    const probe = await probeStereovisorService(
      origin,
      app.getVersion(),
      accessToken,
    );
    if (appIsQuitting) return;
    if (probe === "reusable") {
      electronLog("service.start.reused", { origin });
      return;
    }
    if (probe === "incompatible") {
      console.error(
        `[Stereovisor][electron] ${origin} is occupied by an incompatible service`,
      );
      return;
    }
  }
  if (appIsQuitting) return;
  const root = resourceRoot();
  const managedPython =
    usesBundledPosixRuntime()
      ? path.join(root, ".python-runtime", "bin", "python3")
      : managedPythonPath(runtimeRoot(), app.isPackaged ? ".venv-ai" : ".venv");
  const python =
    process.env.STEREOVISOR_PYTHON ??
    (existsSync(managedPython)
      ? managedPython
      : process.platform === "win32"
        ? "python"
        : path.join(root, ".venv", "bin", "python"));
  const serviceRoot = root;
  const packagedDataRoot = path.join(app.getPath("userData"), "workspace");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    STEREOVISOR_MODE: process.env.STEREOVISOR_MODE ?? "auto",
    STEREOVISOR_APP_ROOT: serviceRoot,
  };
  if (process.platform === "darwin") {
    environment.PYTORCH_ENABLE_MPS_FALLBACK =
      process.env.PYTORCH_ENABLE_MPS_FALLBACK ?? "1";
  }
  if (usesBundledPosixRuntime()) environment.PYTHONDONTWRITEBYTECODE = "1";
  if (app.isPackaged) {
    environment.PYTHONNOUSERSITE = "1";
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    environment.STEREOVISOR_PROJECT_ROOT = path.join(packagedDataRoot, "projects");
    environment.STEREOVISOR_MODEL_ROOT = findPackagedModelRoot();
    environment.STEREOVISOR_POWERPAINT_PYTHON =
      process.platform !== "win32"
        ? managedPython
        : managedPythonPath(runtimeRoot(), ".venv-powerpaint");
    if (process.platform !== "win32") {
      environment.STEREOVISOR_POWERPAINT_PACKAGES = path.join(
        root,
        ".python-runtime",
        "powerpaint-site-packages",
      );
    }
    environment.STEREOVISOR_POWERPAINT_VENDOR = path.join(runtimeRoot(), ".cache", "vendor", "PowerPaint");
  }
  // POSIX GUI applications do not own the Windows console lifecycle. Keep the
  // bundled service attached so closing the app cannot leave an orphan behind.
  const launchPolicy = serviceLaunchPolicy(
    process.platform === "win32" && showConsole,
  );
  const launchedService = spawn(
    python,
    [path.join(serviceRoot, "service", "scripts", "run-service.py")],
    {
      cwd: root,
      detached: launchPolicy.detached,
      windowsHide: launchPolicy.windowsHide,
      // A visible console is only useful if the child writes into it. Piped
      // stdio forwards the output to this process instead, and a packaged GUI
      // Electron has no console of its own, so the window Windows allocates for
      // the child would stay empty. Inherit only on the opt-in path.
      stdio: launchPolicy.stdio,
      env: environment,
    },
  );
  serviceProcess = launchedService;
  serviceStopsWithApp = launchPolicy.stopWithApp;
  if (!serviceStopsWithApp) launchedService.unref();
  electronLog("service.start.requested", {
    python,
    root: serviceRoot,
    modelRoot: environment.STEREOVISOR_MODEL_ROOT,
    mode: process.env.STEREOVISOR_MODE ?? "auto",
    persistent: !serviceStopsWithApp,
  });
  launchedService.stdout?.setEncoding("utf8");
  launchedService.stdout?.on("data", (chunk: string) => {
    const output = chunk.trimEnd();
    if (output) console.info("[Stereovisor][service]", output);
  });
  launchedService.stderr?.setEncoding("utf8");
  launchedService.stderr?.on("data", (chunk: string) => {
    const output = chunk.trimEnd();
    if (output) console.warn("[Stereovisor][service]", output);
  });
  launchedService.on("exit", (code, signal) => {
    electronLog("service.exited", { code, signal });
    if (serviceProcess === launchedService) serviceProcess = null;
  });
  launchedService.on("error", (error) =>
    console.error(
      "[Stereovisor][electron] Local service failed to start",
      error,
    ),
  );
}

function installApplicationMenu(): void {
  // Role commands retain Electron's native behavior while explicit labels keep
  // the menu synchronized with the renderer's selected locale.
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: nativeText("fileMenu"),
      submenu: [
        {
          label: `${nativeText("options")}  ${
            process.platform === "darwin" ? "Cmd+," : "Ctrl+,"
          }`,
          click: () => mainWindow?.webContents.send("stereovisor:open-options"),
        },
        { type: "separator" },
        { role: "quit", label: nativeText("exit") },
      ],
    },
    {
      label: nativeText("editMenu"),
      submenu: [
        { role: "undo", label: nativeText("undo") },
        { role: "redo", label: nativeText("redo") },
        { type: "separator" },
        { role: "cut", label: nativeText("cut") },
        { role: "copy", label: nativeText("copy") },
        { role: "paste", label: nativeText("paste") },
        { role: "selectAll", label: nativeText("selectAll") },
      ],
    },
    {
      label: nativeText("view"),
      submenu: [
        { role: "reload", label: nativeText("reload") },
        { role: "forceReload", label: nativeText("forceReload") },
        { type: "separator" },
        {
          role: "toggleDevTools",
          label: nativeText("toggleDevTools"),
          accelerator:
            process.platform === "darwin" ? "Alt+Command+I" : "Control+Shift+I",
        },
        { type: "separator" },
        { role: "resetZoom", label: nativeText("resetZoom") },
        { role: "zoomIn", label: nativeText("zoomIn") },
        { role: "zoomOut", label: nativeText("zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: nativeText("toggleFullscreen") },
      ],
    },
    {
      label: nativeText("helpMenu"),
      submenu: [
        {
          label: nativeText("about"),
          click: () => mainWindow?.webContents.send("stereovisor:open-about"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------
//  Application Window
// --------------------------------
function createWindow(preparationOnly = false): void {
  preparationWindowActive = preparationOnly;
  // Keep nodeIntegration disabled; all renderer filesystem actions cross the
  // narrow, validated preload API below.
  mainWindow = new BrowserWindow({
    width: preparationOnly ? 760 : 1480,
    height: preparationOnly ? 600 : 920,
    minWidth: preparationOnly ? 680 : 1020,
    minHeight: preparationOnly ? 520 : 680,
    icon: path.join(appRoot(), "client", "dist", "app-icon.png"),
    backgroundColor: "#10110f",
    titleBarStyle: "hiddenInset",
    autoHideMenuBar: preparationOnly,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed =
      process.env.VITE_DEV_SERVER_URL ??
      `file://${path.join(appRoot(), "client", "dist", "index.html")}`;
    if (!url.startsWith(allowed)) event.preventDefault();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    const rendererUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    if (preparationOnly) rendererUrl.searchParams.set("startup", "preparation");
    electronLog("window.load.dev", { url: rendererUrl.toString(), preparationOnly });
    void mainWindow.loadURL(rendererUrl.toString());
  } else {
    electronLog("window.load.package", { preparationOnly });
    // Actual ingress -> index.html
    void mainWindow.loadFile(path.join(appRoot(), "client", "dist", "index.html"), {
      query: preparationOnly ? { startup: "preparation" } : undefined,
    });
  }
}

ipcMain.handle(
  "stereovisor:save-png",
  async (_event, dataUrl: string, suggestedName: string) => {
    electronLog("ipc.save-png.requested", { suggestedName });
    if (!/^data:image\/png;base64,/.test(dataUrl))
      throw new Error(nativeText("onlyPng"));
    const result = await dialog.showSaveDialog({
      defaultPath: suggestedName.replace(/[^a-zA-Z0-9_.-]/g, "-"),
      filters: [{ name: nativeText("pngImage"), extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return false;
    const data = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    await writeFile(result.filePath, data);
    electronLog("ipc.save-png.completed", { bytes: data.byteLength });
    return true;
  },
);

async function saveBinary(
  data: ArrayBuffer,
  suggestedName: string,
  filterName: string,
  extension: string,
): Promise<boolean> {
  // Validate the transfer before opening a save dialog; empty buffers are
  // usually a renderer/export failure and should not create misleading files.
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0)
    throw new Error(nativeText("emptyExport"));
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName.replace(/[^a-zA-Z0-9_.-]/g, "-"),
    filters: [{ name: filterName, extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, Buffer.from(data));
  electronLog("ipc.binary-save.completed", {
    filterName,
    bytes: data.byteLength,
  });
  return true;
}

ipcMain.handle(
  "stereovisor:save-project",
  async (_event, data: ArrayBuffer, suggestedName: string) =>
    saveBinary(data, suggestedName, nativeText("project"), "stereovisor"),
);

ipcMain.handle(
  "stereovisor:save-video",
  async (_event, data: ArrayBuffer, suggestedName: string) => {
    const extension =
      path.extname(suggestedName).toLowerCase() === ".mp4" ? "mp4" : "webm";
    return saveBinary(
      data,
      suggestedName,
      extension === "mp4" ? nativeText("mp4Video") : nativeText("webmVideo"),
      extension,
    );
  },
);

ipcMain.handle("stereovisor:open-project", async () => {
  electronLog("ipc.open-project.requested");
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: nativeText("project"), extensions: ["stereovisor"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const fileStat = await stat(filePath);
  if (fileStat.size > 512 * 1024 * 1024)
    throw new Error(nativeText("projectTooLarge"));
  const data = await readFile(filePath);
  electronLog("ipc.open-project.completed", { bytes: data.byteLength });
  return Uint8Array.from(data).buffer;
});

ipcMain.handle("stereovisor:get-settings", () => readSettings());
ipcMain.handle("stereovisor:get-app-version", () => app.getVersion());
ipcMain.handle("stereovisor:get-runtime-preparation", () => runtimePreparationStatus());
ipcMain.handle(
  "stereovisor:save-settings",
  async (_event, settings: unknown) => {
    electronLog("ipc.save-settings.requested");
    await writeSettings(settings);
    electronLog("ipc.save-settings.completed");
  },
);

ipcMain.on("stereovisor:set-locale", (_event, locale: string) => {
  appLocale = normalizeLocale(locale);
  electronLog("locale.updated", { locale: appLocale });
  void readSettings()
    .then((settings) => writeSettings({ ...settings, locale: appLocale }))
    .catch(() => undefined);
  installApplicationMenu();
});

ipcMain.on("stereovisor:preparation-complete", (event) => {
  if (!preparationWindowActive || !mainWindow || event.sender !== mainWindow.webContents)
    return;
  preparationWindowActive = false;
  mainWindow.setMinimumSize(1020, 680);
  mainWindow.setSize(1480, 920, true);
  mainWindow.center();
  mainWindow.setAutoHideMenuBar(false);
  mainWindow.setMenuBarVisibility(true);
  installApplicationMenu();
  electronLog("window.preparation.completed");
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // App Entrance
  app.whenReady().then(() => {
    // A first launch gets a dedicated preparation surface. Once the required
    // offline assets exist, later launches open the editor and start the local
    // service in the background without re-entering model preparation.
    const preparationOnly =
      process.env.STEREOVISOR_PREPARATION_ONLY === "1" ||
      (app.isPackaged && (requiredModelsReady(findPackagedModelRoot()) === false ||
        (process.platform === "win32" && !windowsRuntimeReady(runtimeRoot()))));
    if (!preparationOnly) installApplicationMenu();
    createWindow(preparationOnly);

    void readSettings()
      .then((settings) => {
        appLocale = settings.locale ?? normalizeLocale(app.getLocale());
        electronLog("app.ready", { locale: appLocale });
        if (!preparationWindowActive) installApplicationMenu();
        if (settings.service.origin) {
          electronLog("service.start.skipped-external", {
            origin: settings.service.origin,
          });
        } else {
          void prepareAndStartService(
            settings.service.showConsole,
            settings.service.accessToken,
          );
        }
        void installReactDevTools();
      })
      .catch((error) => {
        // A damaged settings file should not strand the app at a blank window.
        // The renderer can still recover with its defaults and expose the
        // local-service error through the startup gate.
        console.error("[Stereovisor][electron] Settings unavailable; using defaults", error);
        void prepareAndStartService(false);
        void installReactDevTools();
      });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0)
        createWindow(preparationWindowActive);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    appIsQuitting = true;
    electronLog("app.quitting");
    for (const child of [runtimePreparationProcess, modelPreparationProcess]) {
      if (process.platform === "win32" && child?.pid) {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore",
        }).unref();
      } else {
        child?.kill();
      }
    }
    if (serviceStopsWithApp) {
      serviceProcess?.kill();
    } else if (serviceProcess) {
      electronLog("service.left-running", { pid: serviceProcess.pid });
    }
  });
}
