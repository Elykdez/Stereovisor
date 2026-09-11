import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { SettingsDialog } from "@/components/SettingsDialog";
import { DEFAULT_APP_SETTINGS } from "@/settings";
import { i18n } from "@/i18n";

describe("SettingsDialog", () => {
  it("keeps edits in the draft and sends the normalized settings on save", async () => {
    await i18n.changeLanguage("en");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    const { getByRole } = render(<SettingsDialog settings={DEFAULT_APP_SETTINGS} onSave={onSave} onCancel={onCancel} />);

    fireEvent.click(getByRole("button", { name: /Camera/ }));
    fireEvent.change(getByRole("spinbutton", { name: /Default zoom/ }), { target: { value: "9" } });
    fireEvent.click(getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].camera.defaultZoom).toBe(1.35);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes without saving when the user cancels", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const { getByRole } = render(<SettingsDialog settings={DEFAULT_APP_SETTINGS} onSave={onSave} onCancel={onCancel} />);

    fireEvent.click(getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("exposes the inference method and denoising step budget", async () => {
    await i18n.changeLanguage("en");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { getByRole } = render(<SettingsDialog settings={DEFAULT_APP_SETTINGS} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(getByRole("button", { name: /Inference/ }));
    fireEvent.change(getByRole("combobox", { name: /Segmentation density/ }), { target: { value: "dense" } });
    fireEvent.change(getByRole("textbox", { name: /Object vocabulary/ }), { target: { value: "person, keyboard, cup" } });
    fireEvent.click(getByRole("checkbox", { name: /Use VLM vocabulary proposer/ }));
    fireEvent.change(getByRole("combobox", { name: /Default background method/ }), { target: { value: "powerpaint" } });
    fireEvent.change(getByRole("spinbutton", { name: /Inpainting steps/ }), { target: { value: "48" } });
    fireEvent.click(getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].processing.defaultRefinement).toBe("powerpaint");
    expect(onSave.mock.calls[0][0].processing.inpaintingSteps).toBe(48);
    expect(onSave.mock.calls[0][0].processing.segmentationDensity).toBe("dense");
    expect(onSave.mock.calls[0][0].processing.segmentationLabels).toBe("person, keyboard, cup");
    expect(onSave.mock.calls[0][0].processing.useVlmVocabularyProposer).toBe(true);
  });

  it("keeps numeric sliders and value fields synchronized", async () => {
    await i18n.changeLanguage("en");
    const { getByRole } = render(<SettingsDialog settings={DEFAULT_APP_SETTINGS} onSave={vi.fn()} onCancel={vi.fn()} />);
    const navigation = getByRole("navigation", { name: /Option sections/i });
    expect(within(navigation).getAllByRole("button").map((button) => button.querySelector("strong")?.textContent)).toEqual([
      "Appearance",
      "Camera",
      "Inference",
      "Advanced"
    ]);

    fireEvent.click(getByRole("button", { name: /Camera/ }));
    fireEvent.change(getByRole("slider", { name: /Default strength slider/ }), { target: { value: "82" } });
    expect(getByRole("spinbutton", { name: /Default strength/ })).toHaveValue(82);

    fireEvent.change(getByRole("spinbutton", { name: /Default strength/ }), { target: { value: "999" } });
    expect(getByRole("slider", { name: /Default strength slider/ })).toHaveValue("100");

    fireEvent.click(getByRole("button", { name: "Default strength -" }));
    expect(getByRole("spinbutton", { name: /Default strength/ })).toHaveValue(99);

    fireEvent.click(getByRole("button", { name: "Default strength +" }));
    expect(getByRole("slider", { name: /Default strength slider/ })).toHaveValue("100");
    expect(getByRole("button", { name: "Default strength +" })).toBeDisabled();
  });

  it("opens on appearance, where language now lives beside the visual toggles", async () => {
    await i18n.changeLanguage("en");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { getByRole } = render(<SettingsDialog settings={DEFAULT_APP_SETTINGS} onSave={onSave} onCancel={vi.fn()} />);

    // No navigation click: appearance is the page the dialog lands on.
    fireEvent.change(getByRole("combobox", { name: /Language/ }), { target: { value: "ja" } });
    fireEvent.click(getByRole("checkbox", { name: /Reduce motion/ }));
    fireEvent.click(getByRole("checkbox", { name: /Reduce graphic effects/ }));
    fireEvent.click(getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].locale).toBe("ja");
    expect(onSave.mock.calls[0][0].appearance).toEqual({ reduceMotion: true, reduceEffects: true });
  });

  it("persists the external service connection settings", async () => {
    await i18n.changeLanguage("en");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { getByLabelText, getByRole } = render(<SettingsDialog settings={DEFAULT_APP_SETTINGS} onSave={onSave} onCancel={vi.fn()} />);

    fireEvent.click(getByRole("button", { name: /Advanced/ }));
    fireEvent.change(getByRole("textbox", { name: /Server address/ }), {
      target: { value: "http://192.168.1.20:5772/api/ignored" },
    });
    fireEvent.change(getByLabelText(/Server access token/), {
      target: { value: "  shared-lan-token  " },
    });
    fireEvent.click(getByRole("checkbox", { name: /Show service console/ }));
    fireEvent.click(getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].service.showConsole).toBe(true);
    expect(onSave.mock.calls[0][0].service.origin).toBe("http://192.168.1.20:5772");
    expect(onSave.mock.calls[0][0].service.accessToken).toBe("shared-lan-token");
  });
});
