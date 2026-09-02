import { contextBridge, ipcRenderer } from "electron";

// Expose only narrow IPC capabilities. The renderer never receives Node.js
// primitives or arbitrary channel access, preserving the context-isolation
// boundary configured by the main process.
contextBridge.exposeInMainWorld("stereovisor", {
  savePng: (dataUrl: string, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke("stereovisor:save-png", dataUrl, suggestedName),
  saveProject: (data: ArrayBuffer, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke("stereovisor:save-project", data, suggestedName),
  saveVideo: (data: ArrayBuffer, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke("stereovisor:save-video", data, suggestedName),
  openProject: (): Promise<ArrayBuffer | null> => ipcRenderer.invoke("stereovisor:open-project"),
  getSettings: () => ipcRenderer.invoke("stereovisor:get-settings"),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("stereovisor:get-app-version"),
  saveSettings: (settings: unknown): Promise<void> => ipcRenderer.invoke("stereovisor:save-settings", settings),
  onOpenOptions: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("stereovisor:open-options", handler);
    return () => ipcRenderer.removeListener("stereovisor:open-options", handler);
  },
  onOpenAbout: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("stereovisor:open-about", handler);
    return () => ipcRenderer.removeListener("stereovisor:open-about", handler);
  },
  setLocale: (locale: "en" | "zh-CN" | "ja" | "ko"): void => ipcRenderer.send("stereovisor:set-locale", locale)
});
