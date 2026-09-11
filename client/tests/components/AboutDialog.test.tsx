import { fireEvent, render } from "@testing-library/react";
import { AboutDialog } from "@/components/AboutDialog";
import { i18n } from "@/i18n";

describe("AboutDialog", () => {
  it("renders the current version and closes through the custom UI", async () => {
    await i18n.changeLanguage("en");
    const onClose = vi.fn();
    const { getByRole, getByText, queryByText } = render(<AboutDialog version="0.1.0" onClose={onClose} />);

    expect(getByRole("heading", { name: "Stereovisor" })).toBeInTheDocument();
    expect(queryByText("About Stereovisor")).not.toBeInTheDocument();
    expect(getByText("Version 0.1.0")).toBeInTheDocument();
    expect(getByRole("link", { name: "Designed by Elykdez" })).toHaveAttribute(
      "href",
      "https://github.com/Elykdez/Stereovisor",
    );
    expect(getByRole("link", { name: "Designed by Elykdez" })).toHaveAttribute("target", "_blank");
    expect(getByRole("link", { name: "Designed by Elykdez" })).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(getByText("Close").closest("button")!);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["ja", "デザイン: Elykdez"],
    ["ko", "Elykdez 디자인"],
    ["zh-CN", "由 Elykdez 设计"],
  ])("keeps the product-only heading in %s", async (language, attribution) => {
    await i18n.changeLanguage(language);
    const { getByRole } = render(<AboutDialog version="0.1.0" onClose={vi.fn()} />);

    expect(getByRole("heading", { name: "Stereovisor" })).toBeInTheDocument();
    expect(getByRole("link", { name: attribution })).toHaveAttribute(
      "href",
      "https://github.com/Elykdez/Stereovisor",
    );
  });
});
