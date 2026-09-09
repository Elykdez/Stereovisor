/**
 * Small, structured renderer logger. Workflow events use one prefix so they
 * remain easy to filter in Chromium DevTools and in packaged Electron logs.
 */
export type LogContext = Record<string, unknown>;

const PREFIX = "[Stereovisor]";

function write(
  level: "info" | "warn" | "error",
  event: string,
  context?: LogContext,
): void {
  const message = `${PREFIX} ${event}`;
  if (context && Object.keys(context).length > 0) {
    console[level](message, context);
  } else {
    console[level](message);
  }
}

export const appLog = {
  info(event: string, context?: LogContext): void {
    write("info", event, context);
  },
  warn(event: string, context?: LogContext): void {
    write("warn", event, context);
  },
  error(event: string, error?: unknown, context?: LogContext): void {
    const details: LogContext = {
      ...(context ?? {}),
      error: error instanceof Error ? error.message : error,
    };
    write("error", event, details);
  },
};
