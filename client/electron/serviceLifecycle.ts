import { existsSync } from "node:fs";
import path from "node:path";

const REQUIRED_PROVIDER_KEYS = [
  "runtime",
  "segmentation",
  "matting",
  "depth",
  "inpainting",
] as const;

export type ServiceProbeResult =
  | "reusable"
  | "unavailable"
  | "incompatible";

interface HealthResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

export type HealthRequest = (
  input: string,
  init?: RequestInit,
) => Promise<HealthResponse>;

export interface ServiceLaunchPolicy {
  detached: boolean;
  windowsHide: boolean;
  stdio: "inherit" | "pipe";
  stopWithApp: boolean;
}

export type DesktopPlatform = "win32" | "darwin" | "linux";

export function managedPythonPath(
  root: string,
  environmentName: string,
  platform: DesktopPlatform = process.platform as DesktopPlatform,
): string {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(
    root,
    environmentName,
    platform === "win32" ? "Scripts" : "bin",
    platform === "win32" ? "python.exe" : "python",
  );
}

export function requiredModelFiles(modelRoot: string): string[] {
  return [
    path.join(modelRoot, "grounding-dino-base", ".stereovisor-ready"),
    path.join(modelRoot, "sam2.1-hiera-small", ".stereovisor-ready"),
    path.join(modelRoot, "da3-small", ".stereovisor-ready"),
    path.join(modelRoot, "inspyrenet", "ckpt_base.pth"),
    path.join(modelRoot, "big-lama.pt"),
  ];
}

export function requiredModelsReady(
  modelRoot: string,
  fileExists: (filePath: string) => boolean = existsSync,
): boolean {
  return requiredModelFiles(modelRoot).every(fileExists);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCompatibleServiceHealth(
  value: unknown,
  expectedVersion: string,
): boolean {
  if (!isRecord(value)) return false;
  const providers = value.providers;
  if (!isRecord(providers)) return false;
  return (
    value.status === "ok" &&
    value.version === expectedVersion &&
    typeof value.localOnly === "boolean" &&
    REQUIRED_PROVIDER_KEYS.every((key) => isRecord(providers[key]))
  );
}

export function serviceLaunchPolicy(showConsole: boolean): ServiceLaunchPolicy {
  return showConsole
    ? {
        detached: true,
        windowsHide: false,
        stdio: "inherit",
        stopWithApp: false,
      }
    : {
        detached: false,
        windowsHide: true,
        stdio: "pipe",
        stopWithApp: true,
      };
}

export async function probeStereovisorService(
  origin: string,
  expectedVersion: string,
  accessToken = "",
  request: HealthRequest = fetch,
  timeoutMs = 1500,
): Promise<ServiceProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = accessToken.trim();
    const response = await request(`${origin}/api/health`, {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) return "incompatible";
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return "incompatible";
    }
    return isCompatibleServiceHealth(payload, expectedVersion)
      ? "reusable"
      : "incompatible";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
}
