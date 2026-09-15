import FRAGMENT_UTILS from "./fragmentUtils.glsl?raw";
import VERTEX_UTILS from "./vertexUtils.glsl?raw";

/**
 * WebGL hands the driver a single string and GLSL ES has no #include, so shared
 * chunks are spliced in here instead. A shader asks for one with
 * `//#include "<name>"` on a line of its own, then passes its source through
 * {@link glsl} before compiling.
 *
 * The directive is written as a comment on purpose: single-file validators —
 * the editor's among them — ignore it rather than failing on a header they
 * cannot resolve. Each shader declares prototypes for the chunk functions it
 * uses, which is what those validators, and the driver, resolve calls against.
 */
const CHUNKS: Record<string, string> = {
  "fragmentUtils.glsl": FRAGMENT_UTILS,
  "vertexUtils.glsl": VERTEX_UTILS,
};

/**
 * Source-string numbers for #line. The including shader is 0 and each chunk
 * takes its index here plus one, so a driver reporting `ERROR: 1:14` means line
 * 14 of the first name below, not of the shader that pulled it in.
 */
const UNITS = Object.keys(CHUNKS);

const INCLUDE = /^[ \t]*(?:\/\/)?[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/;
// A chunk opens with a #version and its precisions so that it compiles on its
// own and an editor can check it. That preamble is scaffolding: the including
// shader owns both, and a chunk that redeclared a precision would silently
// change the rest of the file it was spliced into — including, since precision
// applies from its statement onward, the prototypes declared above the splice.
const PREAMBLE = /^[ \t]*#(?:version\b)|^[ \t]*precision[ \t]/;

function expand(source: string, unit: number, seen: Set<string>): string {
  // Normalise first: these files are edited on Windows, and a trailing \r would
  // otherwise defeat the end anchors below and leave every directive in place.
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Blank rather than drop, so #line stays true for the rest of the chunk.
    if (unit !== 0 && PREAMBLE.test(line)) {
      out.push("");
      continue;
    }
    const name = INCLUDE.exec(line)?.[1];
    if (name === undefined) {
      out.push(line);
      continue;
    }
    const chunk = CHUNKS[name];
    if (chunk === undefined) throw new Error(`Unknown shader chunk "${name}".`);
    // Include once: two chunks asking for a third must not redefine it.
    if (!seen.has(name)) {
      seen.add(name);
      const nested = UNITS.indexOf(name) + 1;
      out.push(`#line 1 ${nested}`, expand(chunk, nested, seen));
    }
    // Resume on the line after the directive, so an error in the rest of the
    // shader still points at the line its author is looking at.
    out.push(`#line ${index + 2} ${unit}`);
  }
  return out.join("\n");
}

/**
 * Resolve the include directives in a shader. #version stays the first line:
 * chunks are spliced where they are asked for, never hoisted above it.
 */
export function glsl(source: string): string {
  return expand(source, 0, new Set());
}
