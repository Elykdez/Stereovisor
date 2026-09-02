export {};

declare global {
  interface Window {
    stereovisor?: {
      savePng: (dataUrl: string, suggestedName: string) => Promise<boolean>;
      saveProject: (
        data: ArrayBuffer,
        suggestedName: string,
      ) => Promise<boolean>;
      saveVideo: (data: ArrayBuffer, suggestedName: string) => Promise<boolean>;
      openProject: () => Promise<ArrayBuffer | null>;
      getSettings: () => Promise<{
        version: 1;
        locale: "en" | "zh-CN" | "ja" | "ko";
        appearance: { reduceMotion: boolean };
        camera: { defaultZoom: number; defaultStrength: number };
        motion: {
          speed: number;
          horizontalAmount: number;
          verticalAmount: number;
        };
        processing: {
          pollIntervalMs: number;
          defaultRefinement: "lama" | "powerpaint";
          inpaintingSteps: number;
          segmentationDensity: "sparse" | "balanced" | "dense";
        };
      }>;
      getAppVersion: () => Promise<string>;
      saveSettings: (settings: {
        version: 1;
        locale: "en" | "zh-CN" | "ja" | "ko";
        appearance: { reduceMotion: boolean };
        camera: { defaultZoom: number; defaultStrength: number };
        motion: {
          speed: number;
          horizontalAmount: number;
          verticalAmount: number;
        };
        processing: {
          pollIntervalMs: number;
          defaultRefinement: "lama" | "powerpaint";
          inpaintingSteps: number;
          segmentationDensity: "sparse" | "balanced" | "dense";
        };
      }) => Promise<void>;
      onOpenOptions: (listener: () => void) => () => void;
      onOpenAbout: (listener: () => void) => () => void;
      setLocale: (locale: "en" | "zh-CN" | "ja" | "ko") => void;
    };
  }
}
