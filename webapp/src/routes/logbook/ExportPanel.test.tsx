/**
 * What the export window offers before anybody touches it, and the one state in it that must
 * refuse to go on.
 *
 * The panel holds its draft internally and this suite has no DOM, so what a click does is not
 * provable here; what is provable, and is where a panel like this most easily lies, is the
 * state it opens in. A window that defaults to nothing gives a reader an empty file and no
 * reason for it, and a window that ends before it begins must not be pressable at all: the
 * request would fetch an empty range and hand back a file that looks like a quiet week.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ExportPanel, { figuresFor, toggleFigure } from "./ExportPanel";

const noop = () => {};

function render(initial?: Parameters<typeof ExportPanel>[0]["initial"]): string {
  return renderToStaticMarkup(
    <ExportPanel initial={initial} onView={noop} onSave={noop} onCancel={noop} />,
  );
}

/** The value of an input, by the order the panel draws them: from, then to. */
function dates(html: string): string[] {
  return [...html.matchAll(/type="date"[^>]*value="([^"]*)"/g)].map((m) => m[1] as string);
}

describe("the export window", () => {
  it("opens on a week ending today, which is the window nobody has to fill in", () => {
    const [from, to] = dates(render());
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(to as string) - Date.parse(from as string)).toBe(7 * 86400_000);
  });

  it("reopens on the window the reader last asked for", () => {
    // The request outlives the panel: a reader who exported August and comes back for the same
    // month in another format should not have to type it again.
    const html = render({ from: "2026-08-01", to: "2026-08-31", gran: "6h", format: "pdf" });
    expect(dates(html)).toEqual(["2026-08-01", "2026-08-31"]);
    expect(html).toContain("Save PDF");
  });

  it("names the format on the button, so the verb says what it will do", () => {
    expect(render({ format: "csv" })).toContain("Save CSV");
    expect(render({ format: "pdf" })).toContain("Save PDF");
  });

  it("refuses a window that ends before it begins, and says so", () => {
    const html = render({ from: "2026-08-26", to: "2026-08-19" });
    expect(html).toContain("ends before it begins");
    // Both verbs, not just the one that writes a file: viewing it would draw an empty table
    // that a quiet week is indistinguishable from.
    expect([...html.matchAll(/<button[^>]*disabled/g)]).toHaveLength(2);
  });

  it("lets a single day through, which is a window of one day and not an error", () => {
    const html = render({ from: "2026-08-19", to: "2026-08-19" });
    expect(html).not.toContain("ends before it begins");
    expect([...html.matchAll(/<button[^>]*disabled/g)]).toHaveLength(0);
  });
});

/**
 * The figures, which are the difference between a logbook page and a data set.
 *
 * Two states have to be right or the panel offers something it cannot deliver: a minute has no
 * summary to choose from (it is the sample), and a page is one table, so it carries one figure
 * where a file carries as many as the reader wants, side by side.
 */
describe("the figures a window can be exported with", () => {
  const base = { from: "2026-06-01", to: "2026-08-31" } as const;

  it("offers them for a summarised window in a file", () => {
    const html = render({ ...base, gran: "1h", format: "csv" });
    expect(html).toContain("Figures");
    expect(html).toContain("Average");
    expect(html).toContain("Distance");
  });

  it("does not offer them for minutes, which are samples rather than windows", () => {
    expect(render({ ...base, gran: "1m", format: "csv" })).not.toContain("Figures");
  });

  /**
   * The page used to be refused them altogether, on the grounds that it is the table as it
   * stands. That was a limit of the range view rather than of paper: a season's fuel curve or
   * the sea state a boat actually met is the summary, and the boat keeps it. So the page gets
   * the figures too - one of them, because a table cell holds one number.
   */
  it("offers the page one figure, and the file as many as are ticked", () => {
    const html = render({ ...base, gran: "1h", format: "pdf" });
    expect(html).toContain("Figures");
    expect(html).toContain("Average");
    // A page is one table: the window's own numbers are columns in a file and have no cell here.
    expect(html).not.toContain("Distance");
    expect(html).not.toContain("Samples");
    // Exactly one figure lit. Counted inside the figures block: every other group in this
    // panel lights one of its own, and a count over the whole panel would pass at four.
    const figs = /<div class="lbp-book lbp-figs">[\s\S]*?<\/div><\/div>/.exec(html);
    expect(figs, "the figures block is on the page").not.toBeNull();
    expect([...(figs as RegExpExecArray)[0].matchAll(/class="lbp-c on"/g)]).toHaveLength(1);
  });

  /**
   * The two places that have to agree about how many figures a destination holds: what a press
   * does, and what leaves. A panel that lights two chips and exports one is lying, and so is
   * one that lights one and exports two.
   */
  it("lets a file take several and holds a page to one", () => {
    expect(toggleFigure("csv", ["last"], "avg")).toEqual(["last", "avg"]);
    expect(toggleFigure("csv", ["last", "avg"], "last")).toEqual(["avg"]);
    expect(toggleFigure("pdf", ["last", "avg"], "max")).toEqual(["max"]);
    expect(figuresFor("csv", ["avg", "max"])).toEqual(["avg", "max"]);
    expect(figuresFor("pdf", ["avg", "max"])).toEqual(["avg"]);
    // Nothing ticked at all, which the file's panel refuses and the page cannot.
    expect(figuresFor("pdf", [])).toEqual(["last"]);
  });

  /** A reader who ticked two for a file and then asked for a page sees which one he is getting. */
  it("lights the one figure a page would carry, not the two he chose for a file", () => {
    const html = render({ ...base, gran: "1h", format: "pdf", stats: ["avg", "max"] });
    const figs = /<div class="lbp-book lbp-figs">[\s\S]*?<\/div><\/div>/.exec(html);
    expect(figs).not.toBeNull();
    const block = (figs as RegExpExecArray)[0];
    expect(block).toMatch(/class="lbp-c on"[^>]*>Average</);
    expect(block).toMatch(/class="lbp-c"[^>]*>Maximum</);
    expect([...block.matchAll(/class="lbp-c on"/g)]).toHaveLength(1);
  });

  it("opens on the last reading, which is what the file has always held", () => {
    const html = render({ ...base, gran: "1h", format: "csv" });
    // The chip carries its state in its class; "Last" is on and "Average" is not.
    expect(html).toMatch(/class="lbp-c on"[^>]*>Last</);
    expect(html).toMatch(/class="lbp-c"[^>]*>Average</);
  });

  it("refuses to write a file with nothing in the rows", () => {
    const html = render({ ...base, gran: "1h", format: "csv", stats: [] });
    expect(html).toContain("at least one figure");
    // Save is held; View is not, because the screen has its own answer to show.
    expect([...html.matchAll(/<button[^>]*disabled/g)]).toHaveLength(1);
  });
});
