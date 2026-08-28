import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

let mainWindow: BrowserWindow | null = null;
let serviceProcess: ChildProcess | null = null;

function projectRoot(): string {
  return path.resolve(__dirname, "..");
}

function startService(): void {
  if (process.env.VITE_DEV_SERVER_URL) return;
  const root = projectRoot();
  const managedPython = path.join(root, ".venv", "Scripts", "python.exe");
  const python = process.env.STEREOVISOR_PYTHON ?? (process.platform === "win32" ? managedPython : path.join(root, ".venv", "bin", "python"));
  serviceProcess = spawn(
    python,
    [path.join(root, "scripts", "run-service.py")],
    {
      cwd: root,
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, STEREOVISOR_MODE: process.env.STEREOVISOR_MODE ?? "auto" }
    }
  );
  serviceProcess.on("error", (error) => console.error("Local service failed to start", error));
}

function createWindow(): void {
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
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.VITE_DEV_SERVER_URL ?? `file://${path.join(projectRoot(), "dist", "index.html")}`;
    if (!url.startsWith(allowed)) event.preventDefault();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(projectRoot(), "dist", "index.html"));
  }
}

ipcMain.handle("stereovisor:save-png", async (_event, dataUrl: string, suggestedName: string) => {
  if (!/^data:image\/png;base64,/.test(dataUrl)) throw new Error("Only PNG export is supported");
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName.replace(/[^a-zA-Z0-9_.-]/g, "-"),
    filters: [{ name: "PNG image", extensions: ["png"] }]
  });
  if (result.canceled || !result.filePath) return false;
  const data = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  await writeFile(result.filePath, data);
  return true;
});

async function saveBinary(
  data: ArrayBuffer,
  suggestedName: string,
  filterName: string,
  extension: string
): Promise<boolean> {
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0) throw new Error("The exported file is empty");
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName.replace(/[^a-zA-Z0-9_.-]/g, "-"),
    filters: [{ name: filterName, extensions: [extension] }]
  });
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, Buffer.from(data));
  return true;
}

ipcMain.handle("stereovisor:save-project", async (_event, data: ArrayBuffer, suggestedName: string) =>
  saveBinary(data, suggestedName, "Stereovisor project", "stereovisor")
);

ipcMain.handle("stereovisor:save-video", async (_event, data: ArrayBuffer, suggestedName: string) =>
  saveBinary(data, suggestedName, "WebM video", "webm")
);

ipcMain.handle("stereovisor:open-project", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Stereovisor project", extensions: ["stereovisor"] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const fileStat = await stat(filePath);
  if (fileStat.size > 512 * 1024 * 1024) throw new Error("Project packages are limited to 512 MB");
  const data = await readFile(filePath);
  return Uint8Array.from(data).buffer;
});

app.whenReady().then(() => {
  startService();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  serviceProcess?.kill();
});
