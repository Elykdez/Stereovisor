import {
  DEFAULT_APP_SETTINGS,
  LEGACY_LOCALE_STORAGE_KEY,
  SETTINGS_REGISTRY,
  SETTINGS_STORAGE_KEY,
  persistAppSettings,
  sanitizeAppSettings
} from "@/web/settings";

describe("application settings", () => {
  it("registers the advanced values exposed by Options", () => {
    expect(SETTINGS_REGISTRY.map((setting) => setting.key)).toEqual([
      "appearance.reduceMotion",
      "appearance.reduceEffects",
      "service.showConsole",
      "camera.defaultZoom",
      "camera.defaultStrength",
      "motion.speed",
      "motion.horizontalAmount",
      "motion.verticalAmount",
      "processing.pollIntervalMs",
      "processing.defaultRefinement",
      "processing.inpaintingSteps",
      "processing.segmentationDensity",
      "processing.segmentationLabels",
      "processing.useVlmVocabularyProposer"
    ]);
  });

  it("sanitizes malformed and out-of-range values", () => {
    expect(sanitizeAppSettings({
      locale: "fr",
      appearance: { reduceMotion: true, reduceEffects: "yes" },
      camera: { defaultZoom: 9, defaultStrength: -10 },
      motion: { speed: 0, horizontalAmount: 2, verticalAmount: -1 },
      processing: { pollIntervalMs: 99999, defaultRefinement: "powerpaint", inpaintingSteps: 999, segmentationLabels: 123, useVlmVocabularyProposer: true }
    })).toEqual({
      ...DEFAULT_APP_SETTINGS,
      // A non-boolean toggle falls back to its default rather than going truthy.
      appearance: { reduceMotion: true, reduceEffects: false },
      camera: { defaultZoom: 1.35, defaultStrength: 0 },
      motion: { speed: 0.2, horizontalAmount: 1, verticalAmount: 0 },
      processing: { pollIntervalMs: 5000, defaultRefinement: "powerpaint", inpaintingSteps: 100, segmentationDensity: "balanced", segmentationLabels: "", useVlmVocabularyProposer: true }
    });
  });

  it("persists a normalized browser fallback and keeps the legacy locale key", async () => {
    await persistAppSettings({
      ...DEFAULT_APP_SETTINGS,
      locale: "ja",
      camera: { defaultZoom: 1.12, defaultStrength: 74 }
    });
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}");
    expect(saved.locale).toBe("ja");
    expect(saved.camera.defaultZoom).toBe(1.12);
    expect(window.localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY)).toBe("ja");
  });
});
