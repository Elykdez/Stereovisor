import { useState, type CSSProperties } from "react";
import { LOCALE_LABEL_KEYS, useAppTranslation, type AppTranslate } from "../i18n";
import { sanitizeAppSettings, SUPPORTED_LOCALES, type AppSettings } from "../settings";

type SettingsSection = "inference" | "appearance" | "camera" | "advanced";

interface SettingsDialogProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  onCancel: () => void;
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function steppedValue(value: number, direction: -1 | 1, min: number, max: number, step: number): number {
  const decimalPlaces = Math.max(
    (String(step).split(".")[1] ?? "").length,
    (String(min).split(".")[1] ?? "").length
  );
  const precision = 10 ** decimalPlaces;
  const next = Math.round((value + direction * step) * precision) / precision;
  return Math.min(max, Math.max(min, next));
}

interface NumericSettingProps {
  label: string;
  settingKey: string;
  value: number;
  min: number;
  max: number;
  step: number;
  help?: string;
  onChange: (value: number) => void;
}

function NumericSetting({ label, settingKey, value, min, max, step, help, onChange }: NumericSettingProps) {
  const inputId = `setting-${settingKey.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  const updateValue = (rawValue: string) => {
    const parsed = numberValue(rawValue, value);
    onChange(Math.min(max, Math.max(min, parsed)));
  };
  const progress = `${((value - min) / (max - min)) * 100}%`;

  return (
    <label className="settings-field numeric-setting">
      <span>{label} <SettingKey>{settingKey}</SettingKey></span>
      <div className="settings-value-control">
        <input
          id={`${inputId}-range`}
          className="settings-range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          style={{ "--range-progress": progress } as CSSProperties}
          aria-label={`${label} slider`}
          onChange={(event) => updateValue(event.target.value)}
        />
        <div className="settings-number-stepper">
          <button
            type="button"
            className="settings-step-button"
            aria-label={`${label} -`}
            disabled={value <= min}
            onClick={() => onChange(steppedValue(value, -1, min, max, step))}
          >
            &minus;
          </button>
          <input
            id={`${inputId}-number`}
            className="settings-number-input"
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            aria-label={label}
            onChange={(event) => updateValue(event.target.value)}
          />
          <button
            type="button"
            className="settings-step-button"
            aria-label={`${label} +`}
            disabled={value >= max}
            onClick={() => onChange(steppedValue(value, 1, min, max, step))}
          >
            +
          </button>
        </div>
      </div>
      {help && <small>{help}</small>}
    </label>
  );
}

function SectionNav({ active, onChange, t }: { active: SettingsSection; onChange: (section: SettingsSection) => void; t: AppTranslate }) {
  const sections: Array<{ id: SettingsSection; label: string; detail: string }> = [
    { id: "appearance", label: t("settings.appearance"), detail: t("settings.appearanceDetail") },
    { id: "camera", label: t("settings.camera"), detail: t("settings.cameraDetail") },
    { id: "inference", label: t("settings.inference"), detail: t("settings.inferenceDetail") },
    { id: "advanced", label: t("settings.advanced"), detail: t("settings.advancedDetail") }
  ];
  return (
    <nav className="settings-nav" aria-label={t("settings.sections")}>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          className={active === section.id ? "active" : ""}
          onClick={() => onChange(section.id)}
        >
          <strong>{section.label}</strong>
          <small>{section.detail}</small>
        </button>
      ))}
    </nav>
  );
}

function SettingKey({ children }: { children: string }) {
  return <code className="setting-key">{children}</code>;
}

export function SettingsDialog({ settings, onSave, onCancel }: SettingsDialogProps) {
  const { t } = useAppTranslation();
  const [activeSection, setActiveSection] = useState<SettingsSection>("appearance");
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function updateDraft(update: (current: AppSettings) => AppSettings): void {
    setDraft((current) => update(current));
  }

  async function submit(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(sanitizeAppSettings(draft));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onCancel();
    }}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-dialog-header">
          <div>
            <span className="eyebrow">{t("settings.subtitle")}</span>
            <h2 id="settings-title">{t("settings.options")}</h2>
          </div>
          <button type="button" className="settings-close" onClick={onCancel} disabled={saving} aria-label={t("settings.close")}>×</button>
        </header>
        <div className="settings-dialog-body">
          <SectionNav active={activeSection} onChange={setActiveSection} t={t} />
          <div className="settings-content">
            {activeSection === "inference" && (
              <div className="settings-page">
                <span className="eyebrow">{t("settings.inference")}</span>
                <h3>{t("settings.inferenceTitle")}</h3>
                <p className="settings-description">{t("settings.inferenceDescription")}</p>
                <label className="settings-field">
                  <span>{t("settings.segmentationDensity")} <SettingKey>processing.segmentationDensity</SettingKey></span>
                  <select
                    value={draft.processing.segmentationDensity}
                    aria-label={t("settings.segmentationDensity")}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      processing: {
                        ...current.processing,
                        segmentationDensity: event.target.value as AppSettings["processing"]["segmentationDensity"]
                      }
                    }))}
                  >
                    <option value="sparse">{t("settings.segmentationSparse")}</option>
                    <option value="balanced">{t("settings.segmentationBalanced")}</option>
                    <option value="dense">{t("settings.segmentationDense")}</option>
                  </select>
                  <small>{t("settings.segmentationDensityHelp")}</small>
                </label>
                <label className="settings-field settings-textarea">
                  <span>{t("settings.segmentationLabels")} <SettingKey>processing.segmentationLabels</SettingKey></span>
                  <textarea
                    value={draft.processing.segmentationLabels}
                    aria-label={t("settings.segmentationLabels")}
                    placeholder={t("settings.segmentationLabelsPlaceholder")}
                    rows={4}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      processing: { ...current.processing, segmentationLabels: event.target.value }
                    }))}
                  />
                  <small>{t("settings.segmentationLabelsHelp")}</small>
                </label>
                <label className="settings-toggle">
                  <span>
                    <strong>{t("settings.vlmVocabularyProposer")}</strong>
                    <small>{t("settings.vlmVocabularyProposerHelp")} <SettingKey>processing.useVlmVocabularyProposer</SettingKey></small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.processing.useVlmVocabularyProposer}
                    aria-label={t("settings.vlmVocabularyProposer")}
                    data-toggle-on={t("settings.toggleOn")}
                    data-toggle-off={t("settings.toggleOff")}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      processing: { ...current.processing, useVlmVocabularyProposer: event.target.checked }
                    }))}
                  />
                </label>
                <label className="settings-field">
                  <span>{t("settings.defaultRefinement")} <SettingKey>processing.defaultRefinement</SettingKey></span>
                  <select value={draft.processing.defaultRefinement} onChange={(event) => updateDraft((current) => ({
                    ...current,
                    processing: { ...current.processing, defaultRefinement: event.target.value as AppSettings["processing"]["defaultRefinement"] }
                  }))}>
                    <option value="lama">{t("build.lama")}</option>
                    <option value="powerpaint">{t("build.powerpaint")}</option>
                  </select>
                  <small>{t("settings.defaultRefinementHelp")}</small>
                </label>
                <NumericSetting
                  label={t("settings.inpaintingSteps")}
                  settingKey="processing.inpaintingSteps"
                  min={5}
                  max={100}
                  step={1}
                  value={draft.processing.inpaintingSteps}
                  help={t("settings.inpaintingStepsHelp")}
                  onChange={(value) => updateDraft((current) => ({
                    ...current,
                    processing: { ...current.processing, inpaintingSteps: value }
                  }))}
                />
              </div>
            )}
            {activeSection === "appearance" && (
              <div className="settings-page">
                <span className="eyebrow">{t("settings.appearance")}</span>
                <h3>{t("settings.appearanceTitle")}</h3>
                <p className="settings-description">{t("settings.appearanceDescription")}</p>
                <label className="settings-field">
                  <span>{t("language.label")} <SettingKey>locale</SettingKey></span>
                  <select value={draft.locale} aria-label={t("language.label")} onChange={(event) => {
                    const next = event.target.value as AppSettings["locale"];
                    updateDraft((current) => ({ ...current, locale: next }));
                  }}>
                    {SUPPORTED_LOCALES.map((locale) => (
                      <option key={locale} value={locale}>{t(LOCALE_LABEL_KEYS[locale])}</option>
                    ))}
                  </select>
                  <small>{t("settings.languageHelp")}</small>
                </label>
                <label className="settings-toggle">
                  <span>
                    <strong>{t("settings.reduceMotion")}</strong>
                    <small>{t("settings.reduceMotionHelp")} <SettingKey>appearance.reduceMotion</SettingKey></small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.appearance.reduceMotion}
                    aria-label={t("settings.reduceMotion")}
                    data-toggle-on={t("settings.toggleOn")}
                    data-toggle-off={t("settings.toggleOff")}
                    onChange={(event) => updateDraft((current) => ({ ...current, appearance: { ...current.appearance, reduceMotion: event.target.checked } }))}
                  />
                </label>
                <label className="settings-toggle">
                  <span>
                    <strong>{t("settings.reduceEffects")}</strong>
                    <small>{t("settings.reduceEffectsHelp")} <SettingKey>appearance.reduceEffects</SettingKey></small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.appearance.reduceEffects}
                    aria-label={t("settings.reduceEffects")}
                    data-toggle-on={t("settings.toggleOn")}
                    data-toggle-off={t("settings.toggleOff")}
                    onChange={(event) => updateDraft((current) => ({ ...current, appearance: { ...current.appearance, reduceEffects: event.target.checked } }))}
                  />
                </label>
              </div>
            )}
            {activeSection === "camera" && (
              <div className="settings-page">
                <span className="eyebrow">{t("settings.camera")}</span>
                <h3>{t("settings.cameraTitle")}</h3>
                <p className="settings-description">{t("settings.cameraDescription")}</p>
                <NumericSetting
                  label={t("settings.defaultZoom")}
                  settingKey="camera.defaultZoom"
                  min={1}
                  max={1.35}
                  step={0.01}
                  value={draft.camera.defaultZoom}
                  help={t("settings.defaultZoomHelp")}
                  onChange={(value) => updateDraft((current) => ({ ...current, camera: { ...current.camera, defaultZoom: value } }))}
                />
                <NumericSetting
                  label={t("settings.defaultStrength")}
                  settingKey="camera.defaultStrength"
                  min={0}
                  max={100}
                  step={1}
                  value={draft.camera.defaultStrength}
                  help={t("settings.defaultStrengthHelp")}
                  onChange={(value) => updateDraft((current) => ({ ...current, camera: { ...current.camera, defaultStrength: value } }))}
                />
                <NumericSetting
                  label={t("settings.motionSpeed")}
                  settingKey="motion.speed"
                  min={0.2}
                  max={2}
                  step={0.1}
                  value={draft.motion.speed}
                  help={t("settings.motionSpeedHelp")}
                  onChange={(value) => updateDraft((current) => ({ ...current, motion: { ...current.motion, speed: value } }))}
                />
                <div className="settings-range-grid">
                  <NumericSetting
                    label={t("settings.horizontalAmount")}
                    settingKey="motion.horizontalAmount"
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.motion.horizontalAmount}
                    onChange={(value) => updateDraft((current) => ({ ...current, motion: { ...current.motion, horizontalAmount: value } }))}
                  />
                  <NumericSetting
                    label={t("settings.verticalAmount")}
                    settingKey="motion.verticalAmount"
                    min={0}
                    max={1}
                    step={0.01}
                    value={draft.motion.verticalAmount}
                    onChange={(value) => updateDraft((current) => ({ ...current, motion: { ...current.motion, verticalAmount: value } }))}
                  />
                </div>
              </div>
            )}
            {activeSection === "advanced" && (
              <div className="settings-page">
                <span className="eyebrow">{t("settings.advanced")}</span>
                <h3>{t("settings.advancedTitle")}</h3>
                <p className="settings-description">{t("settings.advancedDescription")}</p>
                <label className="settings-field">
                  <span>{t("settings.serviceAddress")} <SettingKey>service.origin</SettingKey></span>
                  <input
                    type="url"
                    value={draft.service.origin}
                    aria-label={t("settings.serviceAddress")}
                    placeholder="http://127.0.0.1:5772"
                    spellCheck={false}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      service: { ...current.service, origin: event.target.value }
                    }))}
                  />
                  <small>{t("settings.serviceAddressHelp")}</small>
                </label>
                <label className="settings-field">
                  <span>{t("settings.serviceAccessToken")} <SettingKey>service.accessToken</SettingKey></span>
                  <input
                    type="password"
                    value={draft.service.accessToken}
                    aria-label={t("settings.serviceAccessToken")}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      service: { ...current.service, accessToken: event.target.value }
                    }))}
                  />
                  <small>{t("settings.serviceAccessTokenHelp")}</small>
                </label>
                <label className="settings-toggle">
                  <span>
                    <strong>{t("settings.showServiceConsole")}</strong>
                    <small>{t("settings.showServiceConsoleHelp")} <SettingKey>service.showConsole</SettingKey></small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.service.showConsole}
                    aria-label={t("settings.showServiceConsole")}
                    data-toggle-on={t("settings.toggleOn")}
                    data-toggle-off={t("settings.toggleOff")}
                    onChange={(event) => updateDraft((current) => ({
                      ...current,
                      service: { ...current.service, showConsole: event.target.checked }
                    }))}
                  />
                </label>
                <NumericSetting
                  label={t("settings.pollInterval")}
                  settingKey="processing.pollIntervalMs"
                  min={250}
                  max={5000}
                  step={50}
                  value={draft.processing.pollIntervalMs}
                  help={t("settings.pollIntervalHelp")}
                  onChange={(value) => updateDraft((current) => ({
                    ...current,
                    processing: { ...current.processing, pollIntervalMs: value }
                  }))}
                />
                <div className="settings-notice">
                  <strong>{t("settings.advancedNoticeTitle")}</strong>
                  <span>{t("settings.advancedNotice")}</span>
                </div>
              </div>
            )}
          </div>
        </div>
        {saveError && <div className="settings-error" role="alert">{saveError}</div>}
        <footer className="settings-dialog-footer">
          <span>{t("settings.savedAutomatically")}</span>
          <div>
            <button type="button" className="secondary-button compact" onClick={onCancel} disabled={saving}>{t("settings.cancel")}</button>
            <button type="button" className="primary-button compact" onClick={() => void submit()} disabled={saving}>
              {saving ? t("settings.saving") : t("settings.save")}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
