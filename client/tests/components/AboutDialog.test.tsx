import { fireEvent, render } from "@testing-library/react";
import { AboutDialog } from "@/components/AboutDialog";
import { i18n } from "@/i18n";

describe("AboutDialog", () => {
  it("renders the current version and closes through the custom UI", async () => {
    await i18n.changeLanguage("en");
    const onClose = vi.fn();
    const { getByRole, getByText } = render(<AboutDialog version="0.1.0" onClose={onClose} />);

    expect(getByRole("heading", { name: "About Stereovisor" })).toBeInTheDocument();
    expect(getByText("Version 0.1.0")).toBeInTheDocument();
    fireEvent.click(getByText("Close").closest("button")!);

    expect(onClose).toHaveBeenCalledOnce();
  });
});
