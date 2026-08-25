/**
 * Which corner of the chart each thing standing on it claims.
 *
 * A chart has four corners and more things that want one than there are corners: the coordinate
 * strip, the note stack that says why the chart is showing what it is showing, the AIS controls
 * and their panel, and the zoom control, which is not in this sheet at all - MapLibre draws it,
 * in the corner MapMarine.tsx names in ZOOM_CORNER. Because that last one is invisible from
 * here, a rule can be moved into its corner without anything in this package noticing.
 *
 * Which is what had happened. Measured with a note raised: the chip covered 40% of the zoom
 * control, and the 40% was its lower half, the zoom-out button - at the one moment the note
 * exists to describe, which is a boat with no fix, and zooming out is how you look for her.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./swiss.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * The corner an absolutely positioned rule pins itself to, as [vertical, horizontal].
 * A rule that sets both sides spans that edge rather than claiming a corner of it.
 */
function corner(body: string): [string, string] {
  // `inset: 0` is the map itself, pinned to all four sides at once, and reads here as what it
  // is: something that spans the chart rather than sitting in a part of it.
  const inset = /(^|[;{\s])inset\s*:/.test(body);
  const has = (prop: string) => inset || new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(body);
  const v = has("top") ? (has("bottom") ? "span" : "top") : has("bottom") ? "bottom" : "none";
  const h = has("left") ? (has("right") ? "span" : "left") : has("right") ? "right" : "none";
  return [v, h];
}

/** Every rule in this sheet that puts something on the chart at a fixed corner. */
function chartOverlays(): { selector: string; corner: [string, string] }[] {
  const out: { selector: string; corner: [string, string] }[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(css); m !== null; m = rule.exec(css)) {
    const selector = (m[1] ?? "").trim().replace(/\s+/g, " ");
    const body = m[2] ?? "";
    if (!/^\.swiss \.mp[\w-]*$/.test(selector)) continue;
    if (!/position:\s*absolute/.test(body)) continue;
    out.push({ selector, corner: corner(body) });
  }
  return out;
}

/**
 * Where MapMarine.tsx puts the zoom control (`ZOOM_CORNER`). Held as a copy because that file
 * is in the webapp and this sheet is a package the webapp consumes, so neither can import the
 * other's half. Its own suite pins the same value; whichever is edited alone goes red naming
 * the other.
 */
const ZOOM_CORNER: [string, string] = ["bottom", "left"];

describe("what stands in the chart's corners", () => {
  it("finds the overlays this sheet places", () => {
    // If this list empties, the rest of the file is asserting nothing.
    expect(chartOverlays().map((o) => o.selector).sort()).toEqual([
      ".swiss .mp-canvas",
      ".swiss .mp-ctrl",
      ".swiss .mp-notes",
      ".swiss .mp-strip",
    ]);
  });

  it("leaves the zoom control's corner to the zoom control", () => {
    for (const { selector, corner: c } of chartOverlays()) {
      expect([selector, c], selector).not.toEqual([selector, ZOOM_CORNER]);
    }
  });

  it("gives the two stacks a corner each", () => {
    // Both grow as they fill - the notes downward from the top, the controls upward from the
    // bottom - so two of them in one corner is two things growing into each other.
    const notes = chartOverlays().find((o) => o.selector === ".swiss .mp-notes");
    const ctrl = chartOverlays().find((o) => o.selector === ".swiss .mp-ctrl");
    expect(notes?.corner).not.toEqual(ctrl?.corner);
  });
});
