import { mergeProjectResult } from "@/lib/projectAssets";
import type { SceneProject } from "@/types";

function scene(cutoutUrl: string, backgroundUrl: string | null): SceneProject {
  return {
    id: "project-id",
    width: 720,
    height: 1080,
    sourceUrl: "/source.png",
    backgroundUrl,
    unionMaskUrl: null,
    depthMapUrl: null,
    backgroundPrompt: null,
    inpaintProvider: null,
    vramPeaksMb: {},
    engine: "ai",
    layers: [{
      id: "person",
      name: "Person",
      cutoutUrl,
      maskUrl: cutoutUrl.replace("cutout", "mask"),
      proposalMaskUrl: "/person-proposal-mask.png",
      refinementState: "refined",
      confirmed: true,
      maskRevision: 2,
      depth: 0.91,
      order: 1,
      offsetX: 0,
      offsetY: 0,
      selected: true,
      visible: true,
      bounds: [100, 300, 650, 1080],
      kind: "instance",
      confidence: 0.85
    }]
  };
}

describe("project asset revisions", () => {
  it("keeps the reviewed cutout revision when building the background", () => {
    const reviewed = scene("/person-cutout.png?v=refined-gun", null);
    const built = scene("/person-cutout.png", "/background.png");

    const merged = mergeProjectResult(reviewed, built);

    expect(merged.backgroundUrl).toBe("/background.png");
    expect(merged.layers[0].cutoutUrl).toBe("/person-cutout.png?v=refined-gun");
    expect(merged.layers[0].maskUrl).toBe("/person-mask.png?v=refined-gun");
  });
});
