import i18n from "i18next";
import { useCallback } from "react";
import { initReactI18next, useTranslation } from "react-i18next";
import { localeResources, type MessageKey, type TranslationKey } from "./generated";
import {
  LEGACY_LOCALE_STORAGE_KEY,
  normalizeAppLocale,
  persistLocaleSetting,
  SUPPORTED_LOCALES,
  type AppLocale
} from "../settings";

export { SUPPORTED_LOCALES } from "../settings";
export type { AppLocale } from "../settings";
export const LOCALE_LABEL_KEYS = {
  en: "language.en",
  ja: "language.ja",
  ko: "language.ko",
  "zh-CN": "language.zhCN"
} as const satisfies Record<AppLocale, TranslationKey>;
export type TranslationValues = Record<string, string | number>;
export type AppTranslate = (key: TranslationKey, values?: TranslationValues) => string;

export const LOCALE_STORAGE_KEY = LEGACY_LOCALE_STORAGE_KEY;

export function normalizeLocale(locale: string | null | undefined): AppLocale | null {
  return normalizeAppLocale(locale);
}

export function detectLocale(savedLocale?: string | null, browserLocales?: readonly string[]): AppLocale {
  const saved = normalizeLocale(savedLocale);
  if (saved) return saved;
  for (const locale of browserLocales ?? []) {
    const supported = normalizeLocale(locale);
    if (supported) return supported;
  }
  return "en";
}

function initialLocale(): AppLocale {
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Storage can be disabled; navigator detection remains available.
  }
  return detectLocale(saved, typeof navigator === "undefined" ? [] : navigator.languages);
}

function applyLocale(locale: AppLocale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  persistLocaleSetting(locale);
}

const startingLocale = typeof window === "undefined" ? "en" : initialLocale();
void i18n
  .use(initReactI18next)
  .init({
    resources: localeResources,
    lng: startingLocale,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LOCALES],
    load: "currentOnly",
    keySeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false
  });

i18n.on("languageChanged", (locale) => applyLocale(normalizeLocale(locale) ?? "en"));
if (typeof window !== "undefined") applyLocale(startingLocale);

export function useAppTranslation(): {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: AppTranslate;
  runtimeText: (text: string) => string;
  layerName: (name: string) => string;
} {
  const { i18n: instance } = useTranslation();
  const locale = normalizeLocale(instance.resolvedLanguage ?? instance.language) ?? "en";
  const t = useCallback<AppTranslate>(
    (key, values) => instance.t(key as string, values) as string,
    [instance, locale]
  );
  const setLocale = useCallback((next: AppLocale) => {
    void instance.changeLanguage(next);
  }, [instance]);
  const runtimeText = useCallback((text: string) => translateRuntimeText(text, t), [t]);
  const layerName = useCallback((name: string) => translateLayerName(name, t), [t]);
  return { locale, setLocale, t, runtimeText, layerName };
}

const RUNTIME_KEYS: Readonly<Record<string, MessageKey>> = {
  "Queued": "runtime.queued",
  "Starting": "runtime.starting",
  "Complete": "runtime.complete",
  "Failed": "runtime.failed",
  "Preparing image": "runtime.preparingImage",
  "Segmenting objects": "runtime.segmentingObjects",
  "Building layers": "runtime.buildingLayers",
  "Joining masks": "runtime.joiningMasks",
  "Rebuilding background": "runtime.rebuildingBackground",
  "Estimating depth": "runtime.estimatingDepth",
  "Preparing refinement": "runtime.preparingRefinement",
  "Refining mask": "runtime.refiningMask",
  "Saving refined mask": "runtime.savingRefinedMask",
  "Describing background": "runtime.describingBackground",
  "Loading PowerPaint": "runtime.loadingPowerPaint",
  "Redrawing background": "runtime.redrawingBackground",
  "Finalizing plate": "runtime.finalizingPlate",
  "Preparing layer inpaint": "runtime.preparingLayerInpaint",
  "Inpainting layer": "runtime.inpaintingLayer",
  "Preparing the local AI job.": "runtime.preparingAI",
  "Preparing the local inpainting job.": "runtime.preparingInpaint",
  "Waiting for the local AI worker.": "runtime.waitingWorker",
  "Starting the local AI worker.": "runtime.startingWorker",
  "Local processing finished.": "runtime.finished",
  "Processing cancelled by the user.": "processing.cancelled",
  "Normalizing orientation and color.": "runtime.normalizing",
  "Describing objects": "runtime.describingObjects",
  "Finding distinct foreground regions.": "runtime.findingRegions",
  "Combining the selected foreground mattes.": "runtime.combiningMattes",
  "Synthesizing the hidden background plate.": "runtime.synthesizingPlate",
  "Grounding DINO-B and SAM 2.1 are finding individual objects.": "runtime.findingObjects",
  "Qwen3-VL is proposing a scene vocabulary.": "runtime.proposingVocabulary",
  "Depth Anything 3 is mapping near and distant regions.": "runtime.mappingDepth",
  "Preparing depth ordering and transparent cutouts.": "runtime.preparingCutouts",
  "InSPyReNet is removing the local background and resolving soft edges.": "runtime.refiningEdges",
  "Local mask-guided segmentation is aligning this foreground layer to image edges.": "runtime.aligningMask",
  "Updating this layer's alpha and foreground cutout.": "runtime.updatingLayer",
  "Combining selected objects into the inpainting mask.": "runtime.combiningInpaintMask",
  "Qwen3-VL is creating a local background prompt.": "runtime.creatingPrompt",
  "Loading local checkpoints and preparing CPU/GPU offload before the first denoising step.": "runtime.loadingCheckpoints",
  "Big LaMa is filling the masked structure.": "runtime.lamaFilling",
  "Saving the rebuilt background and scene metadata.": "runtime.savingPlate",
  "Optional PowerPaint v2.1 weights are incomplete or not installed": "runtime.optionalPowerpaintWeights",
  "Optional PowerPaint v2.1 runtime is not installed": "runtime.optionalPowerpaintRuntime",
  "PowerPaint v2.1 full-redraw runtime installed": "runtime.powerpaintInstalled",
  "Optional Qwen3-VL weights are incomplete or not installed": "runtime.optionalQwenWeights",
  "The local vision service is unavailable.": "error.serviceUnavailable",
  "Image analysis failed.": "error.analysisFailed",
  "Finish the active mask edit or refinement before inpainting.": "error.finishMaskOperation",
  "Select at least one foreground object before building the scene.": "error.selectForeground",
  "Enter a background prompt or finish installing Qwen3-VL before using PowerPaint full redraw.": "error.promptRequired",
  "Background inpainting failed.": "error.backgroundInpaintFailed",
  "The selected scene layer no longer exists.": "error.layerMissing",
  "Layer inpainting requires the local PowerPaint full-redraw model.": "error.powerpaintRequired",
  "Refine requires the Local AI engine and InSPyReNet.": "error.refineRequiresAI",
  "The selected mask could not be refined.": "error.refineFailed",
  "The selected mask could not be confirmed.": "error.confirmFailed",
  "The edited mask could not be saved.": "error.saveMaskFailed",
  "Paint an area before inpainting this layer.": "error.paintFirst",
  "The selected layer could not be inpainted.": "error.layerInpaintFailed",
  "The layer inpaint could not be undone.": "error.undoInpaintFailed",
  "The layer inpaint could not be redone.": "error.redoInpaintFailed",
  "The file operation failed.": "error.fileOperationFailed",
  "The scene canvas is not ready.": "error.canvasNotReady",
  "Discard the current editor state and return to the image upload screen?": "error.confirmReset",
  "Could not load scene assets.": "error.loadAssets",
  "This runtime cannot encode demo video.": "error.videoUnsupported",
  "This runtime has no supported MP4 or WebM encoder.": "error.videoFormatUnsupported",
  "Demo video encoding failed.": "error.videoEncoding",
  "The scene images are not ready for video export.": "error.videoAssetsNotReady",
  "The video encoder produced an empty file.": "error.videoEmpty",
  "PNG export failed.": "error.pngExport",
  "Wait for the scene images to finish loading.": "error.waitForImages",
  "The full scene composition is not ready.": "error.compositionNotReady",
  "The composition could not be encoded.": "error.compositionEncoding",
  "Choose a mask before applying brush changes.": "error.chooseMask",
  "Could not load the editable mask.": "error.editableMaskLoad",
  "Could not prepare the mask editor.": "error.prepareMaskEditor",
  "Mask editing is unavailable in this renderer.": "error.maskEditingUnavailable",
  "Wait for the mask to finish loading.": "error.waitMask",
  "Mask export is unavailable in this renderer.": "error.maskExportUnavailable",
  "The edited mask could not be encoded.": "error.maskEncoding",
  "Local processing completed without a project result.": "error.processingNoResult",
  "Use PNG, JPEG, or WebP.": "error.unsupportedImage",
  "Images are limited to 40 MB.": "error.imageTooLarge",
  "The selected file is not a readable image.": "error.decodeFailed",
  "The project no longer exists.": "error.projectMissing",
  "The processing job no longer exists.": "error.jobMissing",
  "The project asset does not exist.": "error.assetMissing",
  "Project packages are limited to 512 MB.": "error.projectTooLarge",
  "The local AI stack is not installed. Run service/scripts/setup-ai.ps1, then restart Stereovisor.": "error.aiStackMissing"
};

interface RuntimePattern {
  expression: RegExp;
  key: MessageKey;
  values: (match: RegExpMatchArray, t: AppTranslate) => TranslationValues;
}

const RUNTIME_PATTERNS: readonly RuntimePattern[] = [
  { expression: /^Creating (\d+) editable object layers\.$/, key: "runtime.creatingLayers", values: (match) => ({ count: match[1] }) },
  { expression: /^Saving layer (\d+) of (\d+)\.$/, key: "runtime.savingLayer", values: (match) => ({ current: match[1], total: match[2] }) },
  { expression: /^Cropping the original image around (.+)\.$/, key: "runtime.croppingLayer", values: (match, t) => ({ name: translateLayerName(match[1], t) }) },
  { expression: /^PowerPaint denoising step (\d+) of (\d+)\.$/, key: "runtime.denoisingStep", values: (match) => ({ current: match[1], total: match[2] }) },
  { expression: /^Using the full composition as context for (.+)\.$/, key: "runtime.layerContext", values: (match, t) => ({ name: translateLayerName(match[1], t) }) },
  { expression: /^PowerPaint full-redraw step (\d+) of (\d+) for (.+)\.$/, key: "runtime.fullRedrawStep", values: (match, t) => ({ current: match[1], total: match[2], name: translateLayerName(match[3], t) }) },
  { expression: /^Preparing (.+) for local refinement\.$/, key: "runtime.preparingLayer", values: (match, t) => ({ name: translateLayerName(match[1], t) }) },
  { expression: /^Preparing (.+) for full-redraw inpainting\.$/, key: "runtime.preparingTarget", values: (match, t) => ({ name: translateLayerName(match[1], t) }) },
  { expression: /^Confirm every selected mask before inpainting: (.+)\.$/, key: "error.confirmSelected", values: (match, t) => ({ names: match[1].split(", ").map((name) => translateLayerName(name, t)).join(", ") }) },
  { expression: /^Local service failed with HTTP (\d+)\.$/, key: "error.http", values: (match) => ({ status: match[1] }) },
  { expression: /^Could not load (.+)$/, key: "error.loadAsset", values: (match) => ({ source: match[1] }) }
];

export function translateRuntimeText(text: string, t: AppTranslate): string {
  // Service messages remain English identifiers for API compatibility; map
  // stable messages/patterns here only at the display boundary.
  const key = RUNTIME_KEYS[text];
  if (key) return t(key);
  for (const pattern of RUNTIME_PATTERNS) {
    const match = text.match(pattern.expression);
    if (match) return t(pattern.key, pattern.values(match, t));
  }
  return text;
}

export function translateLayerName(name: string, t: AppTranslate): string {
  if (/^background$/i.test(name)) return t("layers.background");
  if (/^foreground layer$/i.test(name)) return t("layers.foregroundGeneric");
  if (name === "Foreground depth plane") return t("layerName.depthPlane");
  const object = name.match(/^Object (\d+)$/);
  if (object) return t("layerName.object", { number: object[1] });
  // Default name for a hand-brushed layer; a renamed one passes through.
  const area = name.match(/^Area (\d+)$/);
  if (area) return t("layerName.area", { number: area[1] });
  if (name === "extra inpaint area") return t("mask.extraAreaName");
  const inpaintArea = name.match(/^(.+) inpaint area$/);
  if (inpaintArea) return t("mask.inpaintAreaName", { name: translateLayerName(inpaintArea[1], t) });
  return name;
}

export { i18n };
