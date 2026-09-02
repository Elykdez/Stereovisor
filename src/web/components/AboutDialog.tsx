import { useEffect, useRef } from "react";
import { useAppTranslation } from "../i18n";

interface AboutDialogProps {
  version: string;
  onClose: () => void;
}

export function AboutDialog({ version, onClose }: AboutDialogProps) {
  const { t } = useAppTranslation();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="about-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" aria-describedby="about-description">
        <button
          ref={closeButtonRef}
          type="button"
          className="about-close"
          onClick={onClose}
          aria-label={t("about.close")}
        >
          ×
        </button>
        <div className="about-dialog-body">
          <img className="about-icon" src="./app-icon.png" alt="" />
          <span className="eyebrow">{t("brand.tagline")}</span>
          <h2 id="about-title">{t("native.about")}</h2>
          <p className="about-version">{t("native.aboutVersion")} {version}</p>
          <p id="about-description" className="about-description">{t("native.aboutDescription")}</p>
        </div>
        <footer className="about-dialog-footer">
          <button type="button" className="primary-button compact" onClick={onClose}>
            {t("about.close")}
          </button>
        </footer>
      </section>
    </div>
  );
}
