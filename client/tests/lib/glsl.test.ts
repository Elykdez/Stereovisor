import { glsl } from "@/lib/shaders/glsl";
import FOCUS_FRAGMENT from "@/lib/shaders/inpaintFocus.frag?raw";
import FOCUS_VERTEX from "@/lib/shaders/inpaintFocus.vert?raw";
import FOREGROUND_FRAGMENT from "@/lib/shaders/inpaintForeground.frag?raw";
import FOREGROUND_VERTEX from "@/lib/shaders/inpaintForeground.vert?raw";
import MOSAIC_FRAGMENT from "@/lib/shaders/maskMosaic.frag?raw";
import MOSAIC_VERTEX from "@/lib/shaders/maskMosaic.vert?raw";

const SHADERS = {
  "inpaintFocus.frag": FOCUS_FRAGMENT,
  "inpaintFocus.vert": FOCUS_VERTEX,
  "inpaintForeground.frag": FOREGROUND_FRAGMENT,
  "inpaintForeground.vert": FOREGROUND_VERTEX,
  "maskMosaic.frag": MOSAIC_FRAGMENT,
  "maskMosaic.vert": MOSAIC_VERTEX,
};

/** Function definitions, ignoring prototypes, which end in a semicolon. */
function definitions(source: string): string[] {
  return [...source.matchAll(/^\w+ (\w+)\([^)]*\) *\{/gm)].map((match) => match[1]);
}

describe("shader include composition", () => {
  it("resolves the directive and keeps the chunk once", () => {
    const composed = glsl([
      "#version 300 es",
      "precision highp float;",
      'float rand(vec2 uv);',
      '//#include "fragmentUtils.glsl"',
      '//#include "fragmentUtils.glsl"',
      "void main() { }",
    ].join("\n"));
    expect(composed).toContain("float rand(vec2 uv) {");
    expect(composed.match(/float rand\(vec2 uv\) \{/g)).toHaveLength(1);
    expect(composed).not.toMatch(/^\s*\/\/#include/m);
  });

  it("refuses a chunk it does not have", () => {
    expect(() => glsl('//#include "nope.glsl"')).toThrow(/nope\.glsl/);
  });

  it("keeps #version first and drops the chunk's own", () => {
    for (const [name, source] of Object.entries(SHADERS)) {
      const composed = glsl(source);
      const versions = [...composed.matchAll(/^[ \t]*#version\b.*$/gm)];
      expect(versions, name).toHaveLength(1);
      expect(composed.split("\n")[0], name).toBe("#version 300 es");
    }
  });

  it("leaves no directive unresolved and no prototype undefined", () => {
    for (const [name, source] of Object.entries(SHADERS)) {
      const composed = glsl(source);
      expect(composed, name).not.toMatch(/^[ \t]*(?:\/\/)?[ \t]*#include/m);
      const defined = new Set(definitions(composed));
      for (const [, prototype] of composed.matchAll(/^\w+ (\w+)\([^)]*\);$/gm)) {
        expect(defined.has(prototype), `${name} declares ${prototype}`).toBe(true);
      }
    }
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("points #line back at the shader after a chunk (%s)", (_, lineEnding) => {
    const original = SHADERS["maskMosaic.vert"].split(/\r\n|\r|\n/);
    const composed = glsl(original.join(lineEnding));
    const lines = composed.split("\n");
    const resume = lines.findIndex((line) => /^#line \d+ 0$/.test(line));
    expect(resume).toBeGreaterThan(0);
    // The directive's own line number, so the next line is the one after it.
    const [, reported] = /^#line (\d+) 0$/.exec(lines[resume]) ?? [];
    expect(original[Number(reported) - 1]).toBe(lines[resume + 1]);
  });
});
