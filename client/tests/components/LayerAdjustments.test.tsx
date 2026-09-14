import { fireEvent, render } from "@testing-library/react";
import { LayerAdjustments } from "@/components/LayerAdjustments";
import type { SceneLayer } from "@/types";

const layer: SceneLayer = {
  id: "person",
  name: "Person",
  cutoutUrl: "/person-cutout.png",
  maskUrl: "/person-mask.png",
  proposalMaskUrl: null,
  refinementState: "refined",
  confirmed: true,
  maskRevision: 0,
  depth: 0.6,
  order: 0,
  offsetX: 0,
  offsetY: 0,
  selected: true,
  visible: true,
  bounds: [20, 20, 80, 90],
  kind: "instance",
  confidence: 1,
};

describe("LayerAdjustments", () => {
  it("starts feathering every layer at four pixels and lets the layer override it", () => {
    const onChange = vi.fn();
    const { getByRole, getByText } = render(
      <LayerAdjustments
        layer={layer}
        camera={{ x: 0, y: 0, zoom: 1, strength: 68, depthOfField: 15, focusDepth: 1 }}
        disabled={false}
        onChange={onChange}
      />
    );
    const feather = getByRole("slider", { name: "Person Feather" });

    expect(feather).toHaveValue("4");
    expect(getByText("4px")).toBeInTheDocument();
    expect(getByText("Default is 4 px for every layer.")).toBeInTheDocument();
    fireEvent.change(feather, { target: { value: "8" } });
    expect(onChange).toHaveBeenCalledWith({ feather: 8 });
    const blur = getByRole("slider", { name: "Person Blur offset" });
    expect(blur).toHaveValue("0");
    fireEvent.change(blur, { target: { value: "-6" } });
    expect(onChange).toHaveBeenCalledWith({ blur: -6 });
    expect(getByText("Auto 6.0 px + offset 0 px = final 6.0 px")).toBeInTheDocument();
  });

  it.each([0, 2, 8])("preserves explicit feathering of %i pixels and resets to four", (feather) => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <LayerAdjustments
        layer={{ ...layer, feather }}
        camera={{ x: 0, y: 0, zoom: 1, strength: 68 }}
        disabled={false}
        onChange={onChange}
      />
    );

    expect(getByRole("slider", { name: "Person Feather" })).toHaveValue(String(feather));
    fireEvent.click(getByRole("button", { name: "Reset" }));
    expect(onChange).toHaveBeenCalledWith({ centerPull: 0.5, scale: 1, feather: 4, blur: 0 });
  });
});
