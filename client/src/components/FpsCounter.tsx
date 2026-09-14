import { useEffect, useState } from "react";
import { useAppTranslation } from "../i18n";

export function FpsCounter() {
  const { t } = useAppTranslation();
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    let frame = 0;
    let started: number | null = null;
    let frames = 0;

    const tick = (time: number) => {
      if (started === null) {
        started = time;
      } else {
        frames += 1;
        const elapsed = time - started;
        if (elapsed >= 1000) {
          setFps(Math.round(frames * 1000 / elapsed));
          started = time;
          frames = 0;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    const reset = () => {
      cancelAnimationFrame(frame);
      started = null;
      frames = 0;
      setFps(null);
      // Hidden windows throttle animation frames; start a fresh sample on return.
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };

    reset();
    document.addEventListener("visibilitychange", reset);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", reset);
    };
  }, []);

  return (
    <span className="fps-counter" title={t("performance.fpsDetail")}>
      <span>{fps ?? "--"}</span>
      <span className="fps-label">{t("performance.fps")}</span>
    </span>
  );
}
