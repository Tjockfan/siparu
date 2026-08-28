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
import ExportPanel from "./ExportPanel";

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
 * summary to choose from (it is the sample), and a PDF is the page itself, which shows one
 * reading per row whatever is ticked here.
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

  it("does not offer them for the printed page, which is the table as it stands", () => {
    expect(render({ ...base, gran: "1h", format: "pdf" })).not.toContain("Figures");
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
