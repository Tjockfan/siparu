/**
 * What decides how wide a screen's content is, in the cases where the answer is written down
 * twice and the two copies can drift apart.
 *
 * None of these widths is a matter of taste. Each comes from something outside the rule that
 * uses it - the lanes a table holds, the paper a record prints on, the figures a module in the
 * webapp measures screens with - and each of those is a second place the same number lives.
 * This file is what makes a drift loud. Quietly, it shows up as a lane drawn half off the edge
 * of a phone, or as a rule ruled across a column that is not there.
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

/**
 * The logbook table's own three, which `fitColumns.ts` in the webapp holds a copy of so it can
 * work out how many lanes a narrow screen has room for. That file says in a comment that
 * changing one without the other shows up as a lane drawn half off the right edge; the comment
 * states a condition, so it is a test, and its own suite pins the other half.
 */
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

/**
 * The two windows the page is drawn in are the same width, and it is the width their lanes add
 * up to. That clamp is what keeps the page from drawing to the panel's edge over lanes that are
 * not there: measured at 1920, a rule once ran under every row for 154px past the last lane with
 * nine columns on and 482px past it with seven, and the count in the band sat out there on its
 * own. Ruled emptiness reads as columns that failed to arrive; a margin reads as a margin.
 *
 * The bar of controls is held to it too, and for a reason that is about reading rather than
 * about rules: a bar wider than the table beneath it reads as belonging to the page instead of
 * to that table, and the window it names is the table's. The panels the bar opens - the column
 * picker and the export window - are held to the same edge, so opening one does not move the
 * page's left margin.
 */
describe("the windows the logbook is drawn in", () => {
  it("clamps the bar, the panels it opens and the table's frame together", () => {
    expect(blockSelector).toBe(".swiss .lb-ctrl, .swiss .lb-pick, .swiss .lb-frame");
  });

  it("is exactly as wide as the lanes it holds", () => {
    // 1566px with nine columns on, which is where both windows stop at 1920. What is left of
    // the panel falls either side of them, because the page centres what it holds.
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

/**
 * The voyage record's column, and the page it is printed on.
 *
 * A passage row pins its distance to the row's right edge, so a window twice as wide puts the
 * two halves of one row twice as far apart: measured with a season of passages behind it, the
 * date and the figure sat 1111px apart on a laptop and 1575px on a desk. A row is a line
 * rather than a grid, so it cannot use that width the way the board or the log table can, and
 * it is given a measure instead. The measure is the one the same record has on paper, so that
 * the Print button produces the document that was on the screen.
 *
 * That makes two figures which have to agree: the page margin the print rules set, and the
 * measure the screen holds. This is what keeps them in step. A4 is 210mm.
 */
describe("the measure the voyage record is set to", () => {
  const A4_MM = 210;

  /** The @page rule lives inside the print block, which the rule parser above cannot reach. */
  const pageMargin = (): number => {
    const m = /@page\s*\{\s*margin:\s*([\d.]+)mm/.exec(css);
    expect(m, "@page declares a margin in mm").not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  };

  const measure = (): number => {
    const [, body] = ruleDeclaring("--vy-measure");
    const m = /--vy-measure:\s*([\d.]+)mm/.exec(body);
    expect(m, "--vy-measure is declared in mm").not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  };

  it("is the width of the column this record prints in", () => {
    expect(measure()).toBe(A4_MM - 2 * pageMargin());
    expect(measure()).toBe(186);
  });

  it("holds every part of the screen to it, not only the list", () => {
    // Capping the rows alone would leave the banner and the cards running to the panel's edge
    // over a list that stops, which is the ragged half-width the log table had.
    const [, body] = ruleDeclaring("max-width", "--vy-measure");
    expect(body).toContain("var(--vy-measure)");
    expect(rules().some(([s]) => s === ".swiss .vy > *")).toBe(true);
  });
});
