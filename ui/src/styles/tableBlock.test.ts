/**
 * How wide the logbook's table is, and that the sheet says so in one place.
 *
 * The head, the scroller the rows sit in and the caption band under them are one block, and
 * they are clamped to the width their lanes add up to. Without that clamp each of them was
 * drawn to the panel's edge instead: measured in a browser at 1920, a rule ran under every row
 * for 154px past the last lane with nine columns on and 482px past it with seven, and the
 * count in the band sat out there on its own. Ruled emptiness reads as columns that failed to
 * arrive, where a plain margin reads as a margin.
 *
 * The numbers are declared once on `.swiss .lb` because two readers work from them: these
 * rules, and `fitColumns.ts` in the webapp, which decides how many lanes a narrow screen can
 * draw and holds its own copy of the time lane, the gap and the side padding. Its test pins
 * that copy against the same figures. Changing one of them here means changing it there, and
 * whichever of the two is edited alone goes red naming the other.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Comments come out first: this file explains its rules at length above them, so a search for
// a declaration finds the prose before the rule it belongs to.
const css = readFileSync(fileURLToPath(new URL("./swiss.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every rule in the sheet, as [selector, body]. */
function rules(): [string, string][] {
  const out: [string, string][] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = rule.exec(css); m !== null; m = rule.exec(css)) {
    out.push([(m[1] ?? "").trim().replace(/\s+/g, " "), m[2] ?? ""]);
  }
  return out;
}

/** The one rule that declares a property, by the property's name and what else it mentions.
 *  The sheet sets a max-width in a dozen places; the table's is the one that reads the lane
 *  count, and a search that found more than one of anything is not looking at what it thinks. */
function ruleDeclaring(prop: string, mentioning = ""): [string, string] {
  const found = rules().filter(
    ([, body]) => new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(body) && body.includes(mentioning),
  );
  expect(found, `${prop} ${mentioning}`).toHaveLength(1);
  return found[0] as [string, string];
}

const [tableSelector, tableBody] = ruleDeclaring("--lb-tm");
const declared = (name: string): number => {
  const m = new RegExp(`--${name}:\\s*(-?[\\d.]+)px`).exec(tableBody);
  expect(m, `--${name} is declared in px`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
};

describe("the measurements the logbook table is laid out from", () => {
  it("declares them once, on the table itself", () => {
    expect(tableSelector).toBe(".swiss .lb");
  });

  /**
   * The figures fitColumns.ts is holding a copy of. A lane minimum measured against a row that
   * has since changed produces a table one lane too wide for the screen it is on, which is the
   * failure the phone was carrying until the columns were made to fit.
   */
  it("keeps the figures the webapp measures its screens against", () => {
    expect(declared("lb-tm")).toBe(58); // fitColumns.ts: TIME_LANE
    expect(declared("lb-gap")).toBe(4); // fitColumns.ts: LANE_GAP
    expect(declared("lb-pad") * 2).toBe(32); // fitColumns.ts: SIDE_PAD, both sides
  });

  /** Both grids read the declarations, so neither can drift from the width below. */
  it("draws the head and the rows from those declarations rather than from figures", () => {
    for (const selector of [".swiss .lb-cols", ".swiss .lb-row"]) {
      const body = rules().find(([s]) => s === selector)?.[1] ?? "";
      expect(body, selector).toContain(
        "var(--lb-tm) repeat(var(--lb-cols, 5), minmax(0, var(--lb-lane)))",
      );
      expect(body, selector).toContain("gap: var(--lb-gap)");
      expect(body, selector).toContain("var(--lb-pad)");
    }
  });
});

const [blockSelector, blockBody] = ruleDeclaring("max-width", "--lb-cols");
const expression = (/max-width:\s*([\s\S]*?);/.exec(blockBody) as RegExpExecArray)[1] as string;

/**
 * What that expression comes to, in px, for a table with this many data lanes.
 *
 * The arithmetic is evaluated rather than matched as text, so the assertion is about the width
 * a browser will compute and not about how the rule happens to be typed. What is evaluated is
 * this repo's own stylesheet, read from the file beside this one.
 */
function widthOf(lanes: number): number {
  const arithmetic = expression
    .replace(/var\(--lb-cols(?:,[^)]*)?\)/g, String(lanes))
    .replace(/var\((--[a-z-]+)\)/g, (_, name: string) => String(declared(name.slice(2))))
    .replace(/px/g, "")
    .replace(/\bcalc\(/g, "(")
    .replace(/\bmax\(/g, "Math.max(");
  return Number(new Function(`return ${arithmetic}`)());
}

/** The ceiling on a data lane, which is the one measurement the sheet keeps to itself. */
const LANE = declared("lb-lane");
const TIME_LANE = declared("lb-tm");
const GAP = declared("lb-gap");
const SIDES = declared("lb-pad") * 2;

describe("the block the logbook table draws in", () => {
  it("clamps the head, the rows and the band together", () => {
    expect(blockSelector).toBe(".swiss .lb-cols, .swiss .lb-day, .swiss .lb-rows");
  });

  it("is exactly as wide as the lanes it holds", () => {
    // 1566px with nine columns on, which is where the rules and the count stop at 1920.
    expect(widthOf(9)).toBe(SIDES + TIME_LANE + 9 * (LANE + GAP));
    expect(widthOf(9)).toBe(1566);
    expect(widthOf(7)).toBe(SIDES + TIME_LANE + 7 * (LANE + GAP));
  });

  /**
   * The day a boat logged nothing earns no data columns at all, and the page still draws a
   * head and a band over the empty message. Clamped to the time column alone the band would be
   * 90px wide and would spill the date it carries, so the block never goes below one lane.
   */
  it("keeps a lane's width for the day there is nothing to show", () => {
    expect(widthOf(0)).toBe(SIDES + TIME_LANE + (LANE + GAP));
  });
});
