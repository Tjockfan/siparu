/**
 * The width at which a lane stops being readable, pinned at its edges rather than in the
 * middle of the band. A test asserting "a phone shows five" passes for any arithmetic that
 * happens to land on five at 390px; the pair either side of the step is what fails when the
 * lane minimum or the row padding drifts away from the stylesheet.
 */
import { describe, expect, it } from "vitest";
import { fittedColumns, lanesThatFit, LANE_GAP, MIN_LANE, SIDE_PAD, TIME_LANE } from "./fitColumns";
import type { LogColumn } from "./columns";

/** The width at which the nth lane first fits, from the same parts the rule is built from. */
const widthFor = (lanes: number) => SIDE_PAD + TIME_LANE + lanes * (MIN_LANE + LANE_GAP);

const col = (key: string): LogColumn => ({
  key,
  head: key.toUpperCase(),
  book: "bridge",
  cell: () => "-",
});

const deck = ["ts", "sog", "cog", "hdg", "tws", "awa", "baro", "air", "sea", "dep"].map(col);

describe("lanesThatFit", () => {
  it("gives a 390px phone five lanes beside the time", () => {
    expect(lanesThatFit(390)).toBe(5);
  });

  it("steps at the width where the lane first fits, not before it", () => {
    expect(widthFor(6)).toBe(402);
    expect(lanesThatFit(widthFor(6) - 1)).toBe(5);
    expect(lanesThatFit(widthFor(6))).toBe(6);
  });

  it("keeps one lane on a screen too narrow for even that", () => {
    // A time column with nothing beside it is not a log; the row scrolls rather than empties.
    expect(lanesThatFit(120)).toBe(1);
    expect(lanesThatFit(0)).toBe(1);
  });

  it("does not cap a desktop", () => {
    expect(lanesThatFit(1456)).toBeGreaterThan(deck.length);
  });
});

describe("fittedColumns", () => {
  it("draws every column when the width is not known yet", () => {
    // Server-rendered, or a browser with no ResizeObserver: unmeasured is not narrow.
    expect(fittedColumns(deck, null)).toHaveLength(deck.length);
  });

  it("draws the time column plus what fits, in reading order", () => {
    const drawn = fittedColumns(deck, 390);
    expect(drawn.map((c) => c.key)).toEqual(["ts", "sog", "cog", "hdg", "tws", "awa"]);
  });

  it("holds nothing back once the columns fit", () => {
    expect(fittedColumns(deck, 1456)).toEqual(deck);
  });

  it("survives a boat that earned no columns at all", () => {
    expect(fittedColumns([], 390)).toEqual([]);
  });
});
