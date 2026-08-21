/**
 * What the picker shows before anybody touches it.
 *
 * The draft lives inside the component and the suite has no DOM, so what a click does is
 * proved in two other places instead: the selection model next door (withToggled, preset,
 * same) covers every transition, and the live check covers the one thing neither can - that
 * pressing a chip leaves the table alone until the button at the foot is pressed. What is
 * left for this file is the opening state, which is where a picker most easily lies: showing
 * a boat columns she cannot fill, or offering an apply button for a change nobody made.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ColumnPicker from "./ColumnPicker";
import { DECK_LOG, preset } from "./columnSelection";
import type { LogColumn } from "./columns";

const col = (key: string, head: string, book: "bridge" | "engine"): LogColumn => ({
  key,
  head,
  book,
  cell: () => "·",
});

const BRIDGE_ONLY: LogColumn[] = [
  col("ts", "UTC", "bridge"),
  col("sog", "SOG", "bridge"),
  col("dep", "DEP", "bridge"),
];

const BOTH_BOOKS: LogColumn[] = [
  ...BRIDGE_ONLY,
  col("p:rpm", "P RPM", "engine"),
  col("p:oil", "P OIL", "engine"),
];

const draw = (cols: LogColumn[], applied = DECK_LOG) =>
  renderToStaticMarkup(
    <ColumnPicker cols={cols} applied={applied} onApply={() => {}} onCancel={() => {}} />
  );

describe("the picker as it opens", () => {
  it("offers the columns this boat earned, and the time column to nobody", () => {
    const html = draw(BOTH_BOOKS);
    expect(html).toContain(">SOG<");
    expect(html).toContain(">P RPM<");
    // A row without its moment is not a log entry, so UTC is not a choice.
    expect(html).not.toContain(">UTC<");
  });

  it("counts each book against what she carries, not against a written-down total", () => {
    const html = draw(BOTH_BOOKS);
    expect(html).toContain("2 of 2"); // bridge: both on under the deck log
    expect(html).toContain("0 of 2"); // engine: none, until asked for
  });

  /** The rule the whole screen keeps, one level up: no book, no heading, and no preset. */
  it("draws no engineer's book on a boat with no engine gauges", () => {
    const html = draw(BRIDGE_ONLY);
    expect(html).not.toContain("Chief engineer");
    expect(html).not.toContain("Engine log");
    expect(html).not.toContain("Both");
  });

  it("marks the preset the current selection happens to be", () => {
    const html = draw(BOTH_BOOKS, preset("both", BOTH_BOOKS));
    // The chosen preset is the one carrying the active class, and it is Both rather than Deck.
    const both = html.slice(html.indexOf("Both") - 60, html.indexOf("Both"));
    expect(both).toContain('class="on"');
  });

  /**
   * Opening the picker changes nothing, so there is nothing to apply. A live apply button on a
   * draft equal to what is on screen invites a press that does not do anything.
   */
  it("offers nothing to apply until something is drafted", () => {
    const html = draw(BOTH_BOOKS);
    const go = html.slice(html.indexOf("lbp-go"));
    expect(go.slice(0, go.indexOf(">"))).toContain("disabled");
  });
});
