import { appLog } from "./logger";

/** Loopback default: the service runs beside the app unless configured otherwise. */
export const DEFAULT_SERVICE_ORIGIN = "http://127.0.0.1:5772";

/**
 * Reduce a configured value to a bare origin, or "" for same-origin requests.
 * An unparseable value yields "" rather than throwing at module load, so a bad
 * setting degrades to the built-in default instead of stranding the renderer.
 */
export function normalizeServiceOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return "";
  }
}

function builtinServiceOrigin(): string {
  // Development goes through the Vite proxy, so same-origin is correct there.
  if (import.meta.env.DEV) return "";
  const configured = import.meta.env.VITE_STEREOVISOR_SERVICE_ORIGIN;
  const fromEnvironment =
    typeof configured === "string" ? normalizeServiceOrigin(configured) : "";
  return fromEnvironment || DEFAULT_SERVICE_ORIGIN;
}

let serviceOrigin = builtinServiceOrigin();
let serviceAccessToken = "";
const originListeners = new Set<() => void>();

/** Point the client at a service. Empty values restore the bundled defaults. */
export function setServiceConnection(value: string, accessToken: string): void {
  const resolved = normalizeServiceOrigin(value) || builtinServiceOrigin();
  const normalizedToken = accessToken.trim();
  if (resolved === serviceOrigin && normalizedToken === serviceAccessToken)
    return;
  serviceOrigin = resolved;
  serviceAccessToken = normalizedToken;
  appLog.info("api.service-origin.updated", {
    origin: resolved || "same-origin",
    authenticated: Boolean(normalizedToken),
  });
  originListeners.forEach((listener) => listener());
}

/** Compatibility helper for callers that only retarget the origin. */
export function setServiceOrigin(value: string): void {
  setServiceConnection(value, serviceAccessToken);
}

export function resolveServiceOrigin(): string {
  return serviceOrigin;
}

export function resolveServiceAccessToken(): string {
  return serviceAccessToken;
}

export function serviceAuthSubprotocol(): string | undefined {
  if (!serviceAccessToken) return undefined;
  const bytes = new TextEncoder().encode(serviceAccessToken);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const encoded = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `stereovisor.auth.${encoded}`;
}

/** Notify dependents (the event socket) that they must retarget. */
export function onServiceOriginChange(listener: () => void): () => void {
  originListeners.add(listener);
  return () => originListeners.delete(listener);
}
