export {};

declare global {
  interface Window {
    stereovisor?: {
      savePng: (dataUrl: string, suggestedName: string) => Promise<boolean>;
      saveProject: (data: ArrayBuffer, suggestedName: string) => Promise<boolean>;
      saveVideo: (data: ArrayBuffer, suggestedName: string) => Promise<boolean>;
      openProject: () => Promise<ArrayBuffer | null>;
    };
  }
}
