export const SUPPORTED_LOCALES = ["en", "zh-CN", "ja", "ko"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export type SegmentationDensity = "sparse" | "balanced" | "dense";

export const SETTINGS_STORAGE_KEY = "stereovisor.settings";
export const LEGACY_LOCALE_STORAGE_KEY = "stereovisor.locale";

export interface AppSettings {
  version: 1;
  locale: AppLocale;
  appearance: {
    reduceMotion: boolean;
  };
  camera: {
    defaultZoom: number;
    defaultStrength: number;
  };
  motion: {
    speed: number;
    horizontalAmount: number;
    verticalAmount: number;
  };
  processing: {
    pollIntervalMs: number;
    defaultRefinement: "lama" | "powerpaint";
    inpaintingSteps: number;
    segmentationDensity: SegmentationDensity;
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 1,
  locale: "en",
  appearance: { reduceMotion: false },
  camera: { defaultZoom: 1, defaultStrength: 68 },
  motion: { speed: 1, horizontalAmount: 0.74, verticalAmount: 0.28 },
  processing: {
    pollIntervalMs: 1000,
    defaultRefinement: "lama",
    inpaintingSteps: 25,
    segmentationDensity: "balanced",
  },
};

/** The registry is the single list of user-editable settings exposed by Options. */
export const SETTINGS_REGISTRY = [
  {
    key: "appearance.reduceMotion",
    category: "appearance",
    type: "boolean",
    defaultValue: false,
  },
  {
    key: "camera.defaultZoom",
    category: "camera",
    type: "number",
    defaultValue: 1,
    min: 1,
    max: 1.35,
    step: 0.01,
  },
  {
    key: "camera.defaultStrength",
    category: "camera",
    type: "number",
    defaultValue: 68,
    min: 0,
    max: 100,
    step: 1,
  },
  {
    key: "motion.speed",
    category: "motion",
    type: "number",
    defaultValue: 1,
    min: 0.2,
    max: 2,
    step: 0.1,
  },
  {
    key: "motion.horizontalAmount",
    category: "motion",
    type: "number",
    defaultValue: 0.74,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "motion.verticalAmount",
    category: "motion",
    type: "number",
    defaultValue: 0.28,
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "processing.pollIntervalMs",
    category: "processing",
    type: "number",
    defaultValue: 1000,
    min: 250,
    max: 5000,
    step: 50,
  },
  {
    key: "processing.defaultRefinement",
    category: "inference",
    type: "select",
    defaultValue: "lama",
  },
  {
    key: "processing.inpaintingSteps",
    category: "inference",
    type: "number",
    defaultValue: 25,
    min: 5,
    max: 100,
    step: 1,
  },
  {
    key: "processing.segmentationDensity",
    category: "inference",
    type: "select",
    defaultValue: "balanced",
  },
] as const;

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
  return value !== null && typeof value === "object"
    ? (value as RecordLike)
    : {};
}

function numberSetting(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  step: number,
): number {
  // Persisted values are untrusted input (old versions, hand-edits, or a
  // browser extension), so normalize them before they reach controls/runtime.
  const parsed =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.min(max, Math.max(min, parsed));
  return Math.round(clamped / step) * step;
}

export function isAppLocale(value: unknown): value is AppLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function normalizeAppLocale(value: unknown): AppLocale | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace("_", "-").toLowerCase();
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
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return null;
}

export function sanitizeAppSettings(value: unknown): AppSettings {
  // Build a complete settings object rather than spreading unknown data. This
  // keeps newly added fields deterministic and makes migrations idempotent.
  const source = record(value);
  const appearance = record(source.appearance);
  const camera = record(source.camera);
  const motion = record(source.motion);
  const processing = record(source.processing);
  const defaultRefinement =
    processing.defaultRefinement === "powerpaint" ? "powerpaint" : "lama";
  const segmentationDensity =
    processing.segmentationDensity === "sparse" ||
    processing.segmentationDensity === "dense"
      ? processing.segmentationDensity
      : "balanced";
  return {
    version: 1,
    locale: normalizeAppLocale(source.locale) ?? DEFAULT_APP_SETTINGS.locale,
    appearance: {
      reduceMotion:
        typeof appearance.reduceMotion === "boolean"
          ? appearance.reduceMotion
          : DEFAULT_APP_SETTINGS.appearance.reduceMotion,
    },
    camera: {
      defaultZoom: numberSetting(
        camera.defaultZoom,
        DEFAULT_APP_SETTINGS.camera.defaultZoom,
        1,
        1.35,
        0.01,
      ),
      defaultStrength: numberSetting(
        camera.defaultStrength,
        DEFAULT_APP_SETTINGS.camera.defaultStrength,
        0,
        100,
        1,
      ),
    },
    motion: {
      speed: numberSetting(
        motion.speed,
        DEFAULT_APP_SETTINGS.motion.speed,
        0.2,
        2,
        0.1,
      ),
      horizontalAmount: numberSetting(
        motion.horizontalAmount,
        DEFAULT_APP_SETTINGS.motion.horizontalAmount,
        0,
        1,
        0.01,
      ),
      verticalAmount: numberSetting(
        motion.verticalAmount,
        DEFAULT_APP_SETTINGS.motion.verticalAmount,
        0,
        1,
        0.01,
      ),
    },
    processing: {
      pollIntervalMs: numberSetting(
        processing.pollIntervalMs,
        DEFAULT_APP_SETTINGS.processing.pollIntervalMs,
        250,
        5000,
        50,
      ),
      defaultRefinement,
      inpaintingSteps: numberSetting(
        processing.inpaintingSteps,
        DEFAULT_APP_SETTINGS.processing.inpaintingSteps,
        5,
        100,
        1,
      ),
      segmentationDensity,
    },
  };
}

function readBrowserSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_APP_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return sanitizeAppSettings(JSON.parse(raw));
    const legacyLocale = window.localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY);
    const browserLocale =
      typeof navigator === "undefined"
        ? null
        : navigator.languages
            .map((locale) => normalizeAppLocale(locale))
            .find((locale): locale is AppLocale => locale !== null);
    return sanitizeAppSettings({ locale: legacyLocale ?? browserLocale });
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export async function loadAppSettings(): Promise<AppSettings> {
  // Electron is authoritative when available; browser storage remains a safe
  // fallback for the Vite preview and for first launch before IPC is ready.
  const fallback = readBrowserSettings();
  try {
    const persisted = await window.stereovisor?.getSettings?.();
    return persisted ? sanitizeAppSettings(persisted) : fallback;
  } catch {
    return fallback;
  }
}

export async function persistAppSettings(value: AppSettings): Promise<void> {
  // Write both stores so a project opened in the browser and the packaged app
  // observe the same normalized settings shape.
  const settings = sanitizeAppSettings(value);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(settings),
      );
      window.localStorage.setItem(LEGACY_LOCALE_STORAGE_KEY, settings.locale);
    } catch {
      // A blocked browser store should not prevent an in-session settings change.
    }
    if (window.stereovisor?.saveSettings)
      await window.stereovisor.saveSettings(settings);
  }
}

export function persistLocaleSetting(locale: AppLocale): void {
  if (typeof window === "undefined") return;
  try {
    const settings = sanitizeAppSettings({ ...readBrowserSettings(), locale });
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    window.localStorage.setItem(LEGACY_LOCALE_STORAGE_KEY, locale);
  } catch {
    // A blocked browser store should not prevent an in-session language change.
  }
  window.stereovisor?.setLocale?.(locale);
}
