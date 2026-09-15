export {};

declare global {
  // Injected by the Vite define in client/vite.config.mts from versions.json.
  const __CLIENT_VERSION__: string;

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
        version: 3;
        locale: "en" | "ja" | "ko" | "zh-CN";
        appearance: { reduceMotion: boolean; reduceEffects: boolean };
        service: { showConsole: boolean; origin: string; accessToken: string };
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
          segmentationLabels: string;
          useVlmVocabularyProposer: boolean;
        };
      }>;
      getAppVersion: () => Promise<string>;
      getRuntimePreparation?: () => Promise<{
        state: "starting" | "downloading" | "initializing" | "blocked";
        detail: string | null;
        progress: number | null;
      } | null>;
      saveSettings: (settings: {
        version: 3;
        locale: "en" | "ja" | "ko" | "zh-CN";
        appearance: { reduceMotion: boolean; reduceEffects: boolean };
        service: { showConsole: boolean; origin: string; accessToken: string };
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
          segmentationLabels: string;
          useVlmVocabularyProposer: boolean;
        };
      }) => Promise<void>;
      onOpenOptions: (listener: () => void) => () => void;
      onOpenAbout: (listener: () => void) => () => void;
      completePreparation: () => void;
      setLocale: (locale: "en" | "ja" | "ko" | "zh-CN") => void;
    };
  }
}
