import { fireEvent, render, waitFor } from "@testing-library/react";
import { localeResources } from "@/i18n/generated";
import { SUPPORTED_LOCALES } from "@/settings";
import {
  LOCALE_STORAGE_KEY,
  detectLocale,
  i18n,
  normalizeLocale,
  translateLayerName,
  translateRuntimeText,
  useAppTranslation,
  type AppTranslate
} from "@/i18n";

function translate(key: Parameters<AppTranslate>[0], values?: Parameters<AppTranslate>[1]): string {
  return i18n.t(key as string, values) as string;
}

function LanguageProbe() {
  const { locale, setLocale, t } = useAppTranslation();
  return (
    <button type="button" onClick={() => setLocale("ja")}>
      {locale}:{t("source.openImage")}
    </button>
  );
}

describe("localization", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("normalizes supported browser locales and prioritizes a saved choice", () => {
    expect(normalizeLocale("zh-Hans-SG")).toBe("zh-CN");
    expect(normalizeLocale("ja-JP")).toBe("ja");
    expect(detectLocale("ko", ["ja-JP"])).toBe("ko");
    expect(detectLocale(null, ["fr-FR", "zh-CN"])).toBe("zh-CN");
    expect(detectLocale(null, ["fr-FR"])).toBe("en");
  });

  it("keeps the language list in the product order", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "ja", "ko", "zh-CN"]);
  });

  it("keeps every generated locale aligned to the English key set", () => {
    const englishKeys = Object.keys(localeResources.en.translation);
    for (const resource of Object.values(localeResources)) {
      expect(Object.keys(resource.translation)).toEqual(englishKeys);
    }
  });

  it("uses i18next plural rules and translates dynamic service progress", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("build.confirmMasks", { count: 1 })).toBe("Confirm 1 mask");
    expect(i18n.t("build.confirmMasks", { count: 3 })).toBe("Confirm 3 masks");

    await i18n.changeLanguage("zh-CN");
    expect(translateRuntimeText("Creating 3 editable object layers.", translate)).toBe("正在创建 3 个可编辑对象图层。");
    expect(translateLayerName("Object 02", translate)).toBe("对象 02");
    expect(translateRuntimeText("Unrecognized diagnostic", translate)).toBe("Unrecognized diagnostic");
  });

  it("rerenders and persists when the user changes language", async () => {
    await i18n.changeLanguage("en");
    const { getByRole } = render(<LanguageProbe />);
    fireEvent.click(getByRole("button"));

    await waitFor(() => expect(getByRole("button")).toHaveTextContent("ja:画像を開く"));
    expect(document.documentElement.lang).toBe("ja");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ja");
  });
});
