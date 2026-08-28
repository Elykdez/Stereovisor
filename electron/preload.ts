import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("stereovisor", {
  savePng: (dataUrl: string, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke("stereovisor:save-png", dataUrl, suggestedName),
  saveProject: (data: ArrayBuffer, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke("stereovisor:save-project", data, suggestedName),
  saveVideo: (data: ArrayBuffer, suggestedName: string): Promise<boolean> =>
    ipcRenderer.invoke("stereovisor:save-video", data, suggestedName),
  openProject: (): Promise<ArrayBuffer | null> => ipcRenderer.invoke("stereovisor:open-project")
});
