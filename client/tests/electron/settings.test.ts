import { DEFAULT_SETTINGS, normalizeSettings } from "../../electron/settings";
import { DEFAULT_APP_SETTINGS, sanitizeAppSettings } from "@/settings";

vi.mock("electron", () => ({ app: {} }));

describe("desktop and renderer camera defaults", () => {
  it("uses the same explicit 1.10x zoom on both sides of IPC", () => {
    expect(DEFAULT_SETTINGS.camera.defaultZoom).toBe(1.1);
    expect(DEFAULT_SETTINGS.camera.defaultStrength).toBe(30);
    expect(DEFAULT_SETTINGS.camera).toEqual(DEFAULT_APP_SETTINGS.camera);
    expect(normalizeSettings({}).camera.defaultZoom).toBe(1.1);
    expect(sanitizeAppSettings({}).camera.defaultZoom).toBe(1.1);
  });

  it.each([undefined, 1])("migrates the old 1.00x default from settings version %s", (version) => {
    const legacy = { version, camera: { defaultZoom: 1, defaultStrength: 74 } };
    for (const normalize of [normalizeSettings, sanitizeAppSettings]) {
      const upgraded = normalize(legacy);
      expect(upgraded).toMatchObject({ version: 3, camera: { defaultZoom: 1.1, defaultStrength: 74 } });
      expect(normalize(upgraded)).toEqual(upgraded);
    }
  });

  it.each([undefined, 1, 2])("upgrades the former strength default in version %s", (version) => {
    for (const normalize of [normalizeSettings, sanitizeAppSettings]) {
      expect(normalize({ version, camera: { defaultStrength: 68 } }).camera.defaultStrength).toBe(30);
      expect(normalize({ version, camera: { defaultStrength: 74 } }).camera.defaultStrength).toBe(74);
      expect(normalize({ version: 3, camera: { defaultStrength: 68 } }).camera.defaultStrength).toBe(68);
    }
  });

  it.each([
    { version: 1, zoom: 1.25 },
    { version: 2, zoom: 1 },
    { version: 2, zoom: 1.1 },
  ])("preserves a chosen zoom of $zoom in settings version $version", ({ version, zoom }) => {
    for (const normalize of [normalizeSettings, sanitizeAppSettings]) {
      expect(normalize({ version, camera: { defaultZoom: zoom } }).camera.defaultZoom).toBe(zoom);
    }
  });
});
