import { fireEvent, render } from "@testing-library/react";
import { LayerInspector } from "@/web/components/LayerInspector";
import type { SceneLayer } from "@/web/types";

const depthPlane: SceneLayer = {
  id: "depth-plane",
  name: "Foreground depth plane",
  cutoutUrl: "/depth-plane-cutout.png",
  maskUrl: "/depth-plane-mask.png",
  proposalMaskUrl: "/depth-plane-proposal.png",
  refinementState: "rough",
  confirmed: false,
  maskRevision: 0,
  depth: 0.87,
  order: 0,
  selected: true,
  visible: true,
  bounds: [0, 50, 100, 100],
  kind: "depth-plane",
  confidence: 1
};

describe("LayerInspector mask refinement", () => {
  it("allows every foreground layer type to be refined", () => {
    const onRefineMask = vi.fn();
    const { getByRole } = render(
      <LayerInspector
        layers={[depthPlane]}
        phase="selecting"
        editingLayerId={null}
        refiningLayerId={null}
        confirmingLayerId={null}
        aiRefineAvailable
        maskHistory={{}}
        maskHistoryBusy={null}
        backgroundUrl="/background.png"
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable
        onEditMask={vi.fn()}
        onRefineMask={onRefineMask}
        onUndoRefine={vi.fn()}
        onRedoRefine={vi.fn()}
        onConfirmMask={vi.fn()}
        onInpaintTarget={vi.fn()}
        onFocusTarget={vi.fn()}
        onChange={vi.fn()}
      />
    );

    const refine = getByRole("button", { name: "Refine" });
    expect(refine).toBeEnabled();
    fireEvent.click(refine);
    expect(onRefineMask).toHaveBeenCalledWith(depthPlane);
  });

  it("presents the background and every foreground layer as inpaint targets", () => {
    const onInpaintTarget = vi.fn();
    const onFocusTarget = vi.fn();
    const { getAllByRole, getByText } = render(
      <LayerInspector
        layers={[depthPlane]}
        phase="editing"
        editingLayerId={null}
        refiningLayerId={null}
        confirmingLayerId={null}
        aiRefineAvailable
        maskHistory={{}}
        maskHistoryBusy={null}
        backgroundUrl="/background.png"
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable
        onEditMask={vi.fn()}
        onRefineMask={vi.fn()}
        onUndoRefine={vi.fn()}
        onRedoRefine={vi.fn()}
        onConfirmMask={vi.fn()}
        onInpaintTarget={onInpaintTarget}
        onFocusTarget={onFocusTarget}
        onChange={vi.fn()}
      />
    );

    expect(getByText("Background")).toBeInTheDocument();
    const actions = getAllByRole("button", { name: "Inpaint" });
    expect(actions).toHaveLength(2);
    fireEvent.click(actions[0]);
    fireEvent.click(actions[1]);
    expect(onInpaintTarget).toHaveBeenNthCalledWith(1, null);
    expect(onInpaintTarget).toHaveBeenNthCalledWith(2, depthPlane.id);
    expect(onFocusTarget).toHaveBeenCalledWith("background");
    expect(onFocusTarget).toHaveBeenCalledWith(depthPlane.id);
  });

  it("exposes refinement undo and redo for the selected layer", () => {
    const onUndoRefine = vi.fn();
    const onRedoRefine = vi.fn();
    const { getByRole } = render(
      <LayerInspector
        layers={[depthPlane]}
        phase="selecting"
        editingLayerId={null}
        refiningLayerId={null}
        confirmingLayerId={null}
        aiRefineAvailable
        maskHistory={{ [depthPlane.id]: { targetId: depthPlane.id, canUndo: true, canRedo: true } }}
        maskHistoryBusy={null}
        backgroundUrl={null}
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable={false}
        onEditMask={vi.fn()}
        onRefineMask={vi.fn()}
        onUndoRefine={onUndoRefine}
        onRedoRefine={onRedoRefine}
        onConfirmMask={vi.fn()}
        onInpaintTarget={vi.fn()}
        onFocusTarget={vi.fn()}
        onChange={vi.fn()}
      />
    );

    fireEvent.click(getByRole("button", { name: "Undo refine" }));
    fireEvent.click(getByRole("button", { name: "Redo refine" }));
    expect(onUndoRefine).toHaveBeenCalledWith(depthPlane.id);
    expect(onRedoRefine).toHaveBeenCalledWith(depthPlane.id);
  });
});
