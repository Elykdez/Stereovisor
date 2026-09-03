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
  offsetX: 0,
  offsetY: 0,
  selected: true,
  visible: true,
  bounds: [0, 50, 100, 100],
  kind: "depth-plane",
  confidence: 1
};

const person: SceneLayer = {
  ...depthPlane,
  id: "person",
  name: "Person",
  selected: false,
  order: 1,
  depth: 0.65
};

describe("LayerInspector mask refinement", () => {
  it("keeps the optimize action out of the layer list", () => {
    const { getByRole, queryByRole } = render(
      <LayerInspector
        layers={[depthPlane]}
        phase="selecting"
        editingLayerId={null}
        refiningLayerId={null}
        confirmingLayerId={null}
        maskHistory={{}}
        maskHistoryBusy={null}
        selectedLayerIds={[]}
        mergeHistory={null}
        mergeHistoryBusy={null}
        merging={false}
        backgroundUrl="/background.png"
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable
        deletingLayerId={null}
        onDeleteLayer={vi.fn()}
        onCancelEdit={vi.fn()}
        onEditMask={vi.fn()}
        onUndoRefine={vi.fn()}
        onRedoRefine={vi.fn()}
        onConfirmMask={vi.fn()}
        onSelectLayer={vi.fn()}
        onClearSelection={vi.fn()}
        onToggleSelected={vi.fn()}
        onMergeSelected={vi.fn()}
        onUndoMerge={vi.fn()}
        onRedoMerge={vi.fn()}
        onInpaintTarget={vi.fn()}
        onFocusTarget={vi.fn()}
        onChange={vi.fn()}
      />
    );

    expect(getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(queryByRole("button", { name: "Refine" })).not.toBeInTheDocument();
  });

  it("deletes a hand-brushed layer from the mask review list", () => {
    const onDeleteLayer = vi.fn();
    const added: SceneLayer = { ...person, id: "layer-04", name: "Snow drift", kind: "manual" };
    const { getByRole, getByText } = render(
      <LayerInspector
        layers={[added]}
        phase="selecting"
        editingLayerId={null}
        refiningLayerId={null}
        confirmingLayerId={null}
        maskHistory={{}}
        maskHistoryBusy={null}
        selectedLayerIds={[]}
        mergeHistory={null}
        mergeHistoryBusy={null}
        merging={false}
        backgroundUrl={null}
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable={false}
        deletingLayerId={null}
        onDeleteLayer={onDeleteLayer}
        onCancelEdit={vi.fn()}
        onEditMask={vi.fn()}
        onUndoRefine={vi.fn()}
        onRedoRefine={vi.fn()}
        onConfirmMask={vi.fn()}
        onSelectLayer={vi.fn()}
        onClearSelection={vi.fn()}
        onToggleSelected={vi.fn()}
        onMergeSelected={vi.fn()}
        onUndoMerge={vi.fn()}
        onRedoMerge={vi.fn()}
        onInpaintTarget={vi.fn()}
        onFocusTarget={vi.fn()}
        onChange={vi.fn()}
      />
    );

    // A brushed layer has no detector confidence to report.
    expect(getByText(/Added layer/)).toBeInTheDocument();
    const remove = getByRole("button", { name: "Delete" });
    expect(remove).toHaveAttribute("title", "Delete Snow drift and its masks");
    fireEvent.click(remove);
    expect(onDeleteLayer).toHaveBeenCalledWith("layer-04");
  });

  it("turns the edit action into cancel while that layer's mask is open", () => {
    const onCancelEdit = vi.fn();
    const onEditMask = vi.fn();
    const { getByRole } = render(
      <LayerInspector
        layers={[depthPlane]}
        phase="selecting"
        editingLayerId={depthPlane.id}
        refiningLayerId={null}
        confirmingLayerId={null}
        maskHistory={{}}
        maskHistoryBusy={null}
        selectedLayerIds={[]}
        mergeHistory={null}
        mergeHistoryBusy={null}
        merging={false}
        backgroundUrl={null}
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable={false}
        deletingLayerId={null}
        onDeleteLayer={vi.fn()}
        onCancelEdit={onCancelEdit}
        onEditMask={onEditMask}
        onUndoRefine={vi.fn()}
        onRedoRefine={vi.fn()}
        onConfirmMask={vi.fn()}
        onSelectLayer={vi.fn()}
        onClearSelection={vi.fn()}
        onToggleSelected={vi.fn()}
        onMergeSelected={vi.fn()}
        onUndoMerge={vi.fn()}
        onRedoMerge={vi.fn()}
        onInpaintTarget={vi.fn()}
        onFocusTarget={vi.fn()}
        onChange={vi.fn()}
      />
    );

    // Open editors used to disable this button, which stranded a quick look.
    const cancel = getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(onCancelEdit).toHaveBeenCalledOnce();
    expect(onEditMask).not.toHaveBeenCalled();
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
        maskHistory={{}}
        maskHistoryBusy={null}
        selectedLayerIds={[]}
        mergeHistory={null}
        mergeHistoryBusy={null}
        merging={false}
        backgroundUrl="/background.png"
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable
        deletingLayerId={null}
        onDeleteLayer={vi.fn()}
        onCancelEdit={vi.fn()}
        onEditMask={vi.fn()}
        onUndoRefine={vi.fn()}
        onRedoRefine={vi.fn()}
        onConfirmMask={vi.fn()}
        onSelectLayer={vi.fn()}
        onClearSelection={vi.fn()}
        onToggleSelected={vi.fn()}
        onMergeSelected={vi.fn()}
        onUndoMerge={vi.fn()}
        onRedoMerge={vi.fn()}
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
        maskHistory={{ [depthPlane.id]: { targetId: depthPlane.id, canUndo: true, canRedo: true } }}
        maskHistoryBusy={null}
        selectedLayerIds={[]}
        mergeHistory={null}
        mergeHistoryBusy={null}
        merging={false}
        backgroundUrl={null}
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable={false}
        deletingLayerId={null}
        onDeleteLayer={vi.fn()}
        onCancelEdit={vi.fn()}
        onEditMask={vi.fn()}
        onUndoRefine={onUndoRefine}
        onRedoRefine={onRedoRefine}
        onConfirmMask={vi.fn()}
        onSelectLayer={vi.fn()}
        onClearSelection={vi.fn()}
        onToggleSelected={vi.fn()}
        onMergeSelected={vi.fn()}
        onUndoMerge={vi.fn()}
        onRedoMerge={vi.fn()}
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

  it("selects layers independently from their enabled state and exposes batch actions", () => {
    const onSelectLayer = vi.fn();
    const onToggleSelected = vi.fn();
    const onMergeSelected = vi.fn();
    const { getByRole } = render(
      <LayerInspector
        layers={[depthPlane, person]}
        phase="selecting"
        editingLayerId={null}
        refiningLayerId={null}
        confirmingLayerId={null}
        maskHistory={{}}
        maskHistoryBusy={null}
        selectedLayerIds={[depthPlane.id, person.id]}
        mergeHistory={{ targetId: "layers", canUndo: true, canRedo: false }}
        mergeHistoryBusy={null}
        merging={false}
        backgroundUrl={null}
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable={false}
        deletingLayerId={null}
        onDeleteLayer={vi.fn()}
        onCancelEdit={vi.fn()}
        onEditMask={vi.fn()}
        onUndoRefine={vi.fn()}
        onRedoRefine={vi.fn()}
        onConfirmMask={vi.fn()}
        onSelectLayer={onSelectLayer}
        onClearSelection={vi.fn()}
        onToggleSelected={onToggleSelected}
        onMergeSelected={onMergeSelected}
        onUndoMerge={vi.fn()}
        onRedoMerge={vi.fn()}
        onInpaintTarget={vi.fn()}
        onFocusTarget={vi.fn()}
        onChange={vi.fn()}
      />
    );

    fireEvent.click(getByRole("button", { name: "Deselect Foreground depth plane" }));
    fireEvent.click(getByRole("button", { name: "Deselect Person" }));
    expect(onSelectLayer).toHaveBeenNthCalledWith(1, depthPlane.id);
    expect(onSelectLayer).toHaveBeenNthCalledWith(2, person.id);
    expect(getByRole("button", { name: "Toggle selected" })).toBeEnabled();
    fireEvent.click(getByRole("button", { name: "Toggle selected" }));
    fireEvent.click(getByRole("button", { name: "Merge selected" }));
    expect(onToggleSelected).toHaveBeenCalledOnce();
    expect(onMergeSelected).toHaveBeenCalledOnce();
    // The layer history also covers deletions, so its label is not merge-specific.
    expect(getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("locks layer editing while the local AI service is unavailable", () => {
    const onEditMask = vi.fn();
    const onSelectLayer = vi.fn();
    const { getByRole, getByLabelText, getByText } = render(
      <LayerInspector
        layers={[depthPlane]}
        phase="selecting"
        editingLayerId={null}
        refiningLayerId={null}
        confirmingLayerId={null}
        maskHistory={{}}
        maskHistoryBusy={null}
        selectedLayerIds={[]}
        mergeHistory={null}
        mergeHistoryBusy={null}
        merging={false}
        disabled
        deletingLayerId={null}
        backgroundUrl={null}
        inpaintingTargetId={null}
        focusedTargetId={null}
        layerInpaintAvailable={false}
        onDeleteLayer={vi.fn()}
        onCancelEdit={vi.fn()}
        onEditMask={onEditMask}
        onUndoRefine={vi.fn()}
        onRedoRefine={vi.fn()}
        onConfirmMask={vi.fn()}
        onSelectLayer={onSelectLayer}
        onClearSelection={vi.fn()}
        onToggleSelected={vi.fn()}
        onMergeSelected={vi.fn()}
        onUndoMerge={vi.fn()}
        onRedoMerge={vi.fn()}
        onInpaintTarget={vi.fn()}
        onFocusTarget={vi.fn()}
        onChange={vi.fn()}
      />
    );

    expect(getByText("The editor will unlock when the required local AI providers are ready.")).toBeInTheDocument();
    expect(getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(getByLabelText("Select Foreground depth plane")).toBeDisabled();
    fireEvent.click(getByRole("button", { name: "Edit" }));
    fireEvent.click(getByLabelText("Select Foreground depth plane"));
    expect(onEditMask).not.toHaveBeenCalled();
    expect(onSelectLayer).not.toHaveBeenCalled();
  });
});
