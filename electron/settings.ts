import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface PersistedSettings {
  version: 1;
  locale: "en" | "ja" | "ko" | "zh-CN";
  appearance: { reduceMotion: boolean; reduceEffects: boolean };
  service: { showConsole: boolean };
  camera: { defaultZoom: number; defaultStrength: number };
  motion: { speed: number; horizontalAmount: number; verticalAmount: number };
  processing: {
    pollIntervalMs: number;
    defaultRefinement: "lama" | "powerpaint";
    inpaintingSteps: number;
    segmentationDensity: "sparse" | "balanced" | "dense";
    segmentationLabels: string;
    useVlmVocabularyProposer: boolean;
  };
}

export const DEFAULT_SETTINGS: PersistedSettings = {
  version: 1,
  locale: "en",
  appearance: { reduceMotion: false, reduceEffects: false },
  service: { showConsole: false },
  camera: { defaultZoom: 1, defaultStrength: 68 },
  motion: { speed: 1, horizontalAmount: 0.74, verticalAmount: 0.28 },
  processing: {
    pollIntervalMs: 1000,
    defaultRefinement: "lama",
    inpaintingSteps: 25,
    segmentationDensity: "balanced",
    segmentationLabels: "",
    useVlmVocabularyProposer: false,
  },
};

function clamp(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  step: number,
): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const rounded =
    Math.round(Math.min(max, Math.max(min, parsed)) / step) * step;
  return Number(rounded.toFixed(4));
}

function textSetting(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeLocale(value: unknown): PersistedSettings["locale"] {
  const normalized =
    typeof value === "string" ? value.replace("_", "-").toLowerCase() : "";
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

export function normalizeSettings(value: unknown): PersistedSettings {
  const source = object(value);
  const appearance = object(source.appearance);
  const service = object(source.service);
  const camera = object(source.camera);
  const motion = object(source.motion);
  const processing = object(source.processing);
  return {
    version: 1,
    locale: normalizeLocale(source.locale),
    appearance: {
      reduceMotion:
        typeof appearance.reduceMotion === "boolean"
          ? appearance.reduceMotion
          : DEFAULT_SETTINGS.appearance.reduceMotion,
      reduceEffects:
        typeof appearance.reduceEffects === "boolean"
          ? appearance.reduceEffects
          : DEFAULT_SETTINGS.appearance.reduceEffects,
    },
    service: {
      showConsole:
        typeof service.showConsole === "boolean"
          ? service.showConsole
          : DEFAULT_SETTINGS.service.showConsole,
    },
    camera: {
      defaultZoom: clamp(camera.defaultZoom, 1, 1, 1.35, 0.01),
      defaultStrength: clamp(camera.defaultStrength, 68, 0, 100, 1),
    },
    motion: {
      speed: clamp(motion.speed, 1, 0.2, 2, 0.1),
      horizontalAmount: clamp(motion.horizontalAmount, 0.74, 0, 1, 0.01),
      verticalAmount: clamp(motion.verticalAmount, 0.28, 0, 1, 0.01),
    },
    processing: {
      pollIntervalMs: clamp(processing.pollIntervalMs, 1000, 250, 5000, 50),
      defaultRefinement:
        processing.defaultRefinement === "powerpaint" ? "powerpaint" : "lama",
      inpaintingSteps: clamp(
        processing.inpaintingSteps,
        DEFAULT_SETTINGS.processing.inpaintingSteps,
        5,
        100,
        1,
      ),
      segmentationDensity:
        processing.segmentationDensity === "sparse" ||
        processing.segmentationDensity === "dense"
          ? processing.segmentationDensity
          : "balanced",
      segmentationLabels: textSetting(processing.segmentationLabels, "", 4096),
      useVlmVocabularyProposer:
        typeof processing.useVlmVocabularyProposer === "boolean"
          ? processing.useVlmVocabularyProposer
          : DEFAULT_SETTINGS.processing.useVlmVocabularyProposer,
    },
  };
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export async function readSettings(): Promise<PersistedSettings> {
  // A missing or malformed file falls back to safe defaults and is repaired on
  // the next write, so startup never exposes partially trusted settings.
  try {
    return normalizeSettings(
      JSON.parse(await readFile(settingsPath(), "utf8")),
    );
  } catch {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      locale: app.getLocale(),
    });
    void writeSettings(settings).catch(() => undefined);
    return settings;
  }
}

export async function writeSettings(
  value: unknown,
): Promise<PersistedSettings> {
  // Write-then-rename makes a settings update atomic even if the app exits while
  // the file is being persisted.
  const settings = normalizeSettings(value);
  const filePath = settingsPath();
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(
    temporaryPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, filePath);
  return settings;
}
