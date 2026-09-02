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
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSettings, writeSettings } from "./settings";
import {
  nativeMessages,
  type AppLocale,
  type NativeMessage,
} from "./nativeMessages";

let mainWindow: BrowserWindow | null = null;
let serviceProcess: ChildProcess | null = null;
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

function projectRoot(): string {
  // Compiled Electron code lives in dist-electron; resolve resources from the
  // repository/package root instead of relying on the current working folder.
  return path.resolve(__dirname, "..");
}

function startService(): void {
  // Development uses the separately launched service. Packaged mode owns one
  // child process so renderer health checks have a predictable local endpoint.
  if (process.env.VITE_DEV_SERVER_URL) {
    electronLog("service.start.skipped-dev");
    return;
  }
  const root = projectRoot();
  const managedPython = path.join(root, ".venv", "Scripts", "python.exe");
  const python =
    process.env.STEREOVISOR_PYTHON ??
    (process.platform === "win32"
      ? managedPython
      : path.join(root, ".venv", "bin", "python"));
  serviceProcess = spawn(
    python,
    [path.join(root, "scripts", "run-service.py")],
    {
      cwd: root,
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        STEREOVISOR_MODE: process.env.STEREOVISOR_MODE ?? "auto",
      },
    },
  );
  electronLog("service.start.requested", {
    python,
    mode: process.env.STEREOVISOR_MODE ?? "auto",
  });
  serviceProcess.stdout?.setEncoding("utf8");
  serviceProcess.stdout?.on("data", (chunk: string) => {
    const output = chunk.trimEnd();
    if (output) console.info("[Stereovisor][service]", output);
  });
  serviceProcess.stderr?.setEncoding("utf8");
  serviceProcess.stderr?.on("data", (chunk: string) => {
    const output = chunk.trimEnd();
    if (output) console.warn("[Stereovisor][service]", output);
  });
  serviceProcess.on("exit", (code, signal) =>
    electronLog("service.exited", { code, signal }),
  );
  serviceProcess.on("error", (error) =>
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
          label: `${nativeText("options")}  Ctrl+,`,
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
function createWindow(): void {
  // Keep nodeIntegration disabled; all renderer filesystem actions cross the
  // narrow, validated preload API below.
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1020,
    minHeight: 680,
    icon: path.join(projectRoot(), "public", "app-icon.png"),
    backgroundColor: "#10110f",
    titleBarStyle: "hiddenInset",
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
      `file://${path.join(projectRoot(), "dist", "index.html")}`;
    if (!url.startsWith(allowed)) event.preventDefault();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    electronLog("window.load.dev", { url: process.env.VITE_DEV_SERVER_URL });
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    electronLog("window.load.package");
    // Actual ingress -> index.html
    void mainWindow.loadFile(path.join(projectRoot(), "dist", "index.html"));
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
    void readSettings().then((settings) => {
      appLocale = settings.locale ?? normalizeLocale(app.getLocale());
      electronLog("app.ready", { locale: appLocale });
      startService();
      installApplicationMenu();
      createWindow();
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    electronLog("app.quitting");
    serviceProcess?.kill();
  });
}
