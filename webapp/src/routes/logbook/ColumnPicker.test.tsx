/**
 * What the picker shows before anybody touches it.
 *
 * The draft lives inside the component and the suite has no DOM, so what a click does is
 * proved in two other places instead: the selection model next door (withToggled, withAll,
 * same) covers every transition, and the live check covers the one thing neither can - that
 * pressing a chip leaves the table alone until the button at the foot is pressed. What is
 * left for this file is the opening state, which is where a picker most easily lies: showing
 * a boat columns she cannot fill, offering the other book's, or offering an apply button for
 * a change nobody made.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ColumnPicker from "./ColumnPicker";
import { ALL_ON, withAll } from "./columnSelection";
import { columnsFor, type LogColumn } from "./columns";

const col = (key: string, head: string, book: "bridge" | "engine"): LogColumn => ({
  key,
  head,
  book,
  cell: () => "·",
});

const EARNED: LogColumn[] = [
  col("ts", "UTC", "bridge"),
  col("sog", "SOG", "bridge"),
  col("dep", "DEP", "bridge"),
  col("p:rpm", "P RPM", "engine"),
  col("p:oil", "P OIL", "engine"),
];

const draw = (cols: LogColumn[], applied = ALL_ON) =>
  renderToStaticMarkup(
    <ColumnPicker cols={cols} applied={applied} onApply={() => {}} onCancel={() => {}} />
  );

describe("the picker as it opens", () => {
  it("offers this book's columns, the other book's to nobody, and the hour to nobody", () => {
    const html = draw(columnsFor(EARNED, "bridge"));
    expect(html).toContain(">SOG<");
    expect(html).toContain(">DEP<");
    expect(html).not.toContain(">P RPM<"); // the engineer's page has its own picker
    // A row without its moment is not a log entry, so UTC is not a choice.
    expect(html).not.toContain(">UTC<");
  });

  it("counts against what this book carries, not against a written-down total", () => {
    expect(draw(columnsFor(EARNED, "engine"))).toContain("2 of 2");
    const half = withAll(columnsFor(EARNED, "engine"), false);
    expect(draw(columnsFor(EARNED, "engine"), half)).toContain("0 of 2");
  });

  /**
   * Opening the picker changes nothing, so there is nothing to apply. A live apply button on a
   * draft equal to what is on screen invites a press that does not do anything.
   */
  it("offers nothing to apply until something is drafted", () => {
    const html = draw(columnsFor(EARNED, "bridge"));
    const go = html.slice(html.indexOf("lbp-go"));
    expect(go.slice(0, go.indexOf(">"))).toContain("disabled");
  });
});
