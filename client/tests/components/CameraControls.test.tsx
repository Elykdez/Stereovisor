import { fireEvent, render } from "@testing-library/react";
import { CameraControls } from "@/components/CameraControls";
import { i18n } from "@/i18n";
import type { CameraState } from "@/types";

const camera: CameraState = {
  x: 0,
  y: 0,
  zoom: 1,
  strength: 68,
  centerPull: 0.5,
  sceneScale: 1,
  depthOfField: 8,
  focusDepth: 0.9,
};

describe("CameraControls", () => {
  it("groups the final controls and edits lens settings without changing the source state", async () => {
    await i18n.changeLanguage("en");
    const onChange = vi.fn();
    const { getByRole } = render(
      <CameraControls
        camera={camera}
        moving={false}
        onChange={onChange}
        onToggleMotion={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(getByRole("region", { name: "View" })).toBeInTheDocument();
    expect(getByRole("region", { name: "Scene depth" })).toBeInTheDocument();
    expect(getByRole("region", { name: "Lens focus" })).toBeInTheDocument();
    expect(getByRole("region", { name: "Camera controls" })).toHaveTextContent(
      "Demo exports use this rig and the motion settings in Options > Camera."
    );

    fireEvent.change(getByRole("slider", { name: "Depth of field" }), { target: { value: "12.5" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...camera, depthOfField: 12.5 });

    fireEvent.change(getByRole("slider", { name: "Focus depth" }), { target: { value: "0.4" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...camera, focusDepth: 0.4 });
    expect(camera).toEqual(expect.objectContaining({ depthOfField: 8, focusDepth: 0.9 }));
  });
});
