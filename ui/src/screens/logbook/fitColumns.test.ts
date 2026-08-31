/**
 * The width at which a lane stops being readable, pinned at its edges rather than in the
 * middle of the band. A test asserting "a phone shows five" passes for any arithmetic that
 * happens to land on five at 390px; the pair either side of the step is what fails when the
 * lane minimum or the row padding drifts away from the stylesheet.
 */
import { describe, expect, it } from "vitest";
import {
  fittedColumns,
  laneCount,
  lanesThatFit,
  LANE_GAP,
  MIN_LANE,
  SIDE_PAD,
  TIME_LANE,
} from "./fitColumns";
import type { LogColumn } from "./columns";

/** The width at which the nth lane first fits, from the same parts the rule is built from. */
const widthFor = (lanes: number) => SIDE_PAD + TIME_LANE + lanes * (MIN_LANE + LANE_GAP);

const col = (key: string): LogColumn => ({
  key,
  head: key.toUpperCase(),
  book: "bridge",
  cell: () => "-",
});

const wide = (key: string): LogColumn => ({ ...col(key), lanes: 2 });

const deck = ["ts", "sog", "cog", "hdg", "tws", "awa", "baro", "air", "sea", "dep"].map(col);

/** The real bridge deck leads with a position, which is what asks for two lanes. */
const withPosition = [col("ts"), wide("lat"), wide("lon"), ...deck.slice(1)];

/**
 * The half of the contract this side holds.
 *
 * These three are the stylesheet's, copied here because the count of lanes has to be worked
 * out in TypeScript and CSS cannot hand a figure back. The sheet declares them once on
 * `.swiss .lb` (`--lb-tm`, `--lb-gap`, `--lb-pad`) and its own test pins them there, so
 * whichever copy is edited alone goes red pointing at the other. Silently, the two disagreeing
 * draws a lane half off the right edge of a phone.
 */
describe("the stylesheet's measurements", () => {
  it("holds the figures the rows are actually drawn with", () => {
    expect(TIME_LANE).toBe(58);
    expect(LANE_GAP).toBe(4);
    expect(SIDE_PAD).toBe(32);
  });
});

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

/**
 * A position is not a reading and does not fit in a reading's lane.
 *
 * Measured in the browser at both widths: a bridge row's widest position cell asks for 105px
 * against a heading's 35px, and every lane was the same width, so the position was the one
 * column drawn over its neighbour. On a 390px phone the latitude overran its lane by 30px and
 * was painted straight across the longitude beside it - not clipped, so nothing that measured
 * clipping ever saw it.
 */
describe("a column that asks for more than one lane", () => {
  it("counts for what it asks, not for one", () => {
    expect(laneCount(deck.slice(1))).toBe(9);
    expect(laneCount([wide("lat"), wide("lon"), col("sog")])).toBe(5);
  });

  it("spends the phone's lanes on it rather than drawing it too narrow", () => {
    // Five lanes at 390px: the position takes four of them and the speed the fifth.
    expect(lanesThatFit(390)).toBe(5);
    expect(fittedColumns(withPosition, 390).map((c) => c.key)).toEqual(["ts", "lat", "lon", "sog"]);
  });

  it("does not draw a wide column that only half fits", () => {
    // Four lanes: the pair takes all four. A fifth column would need a lane that is not there.
    expect(fittedColumns(withPosition, widthFor(4)).map((c) => c.key)).toEqual(["ts", "lat", "lon"]);
    // Three lanes leave room for one half of the position and no more; the other half is held
    // back whole rather than drawn in a lane it cannot be read in.
    expect(fittedColumns(withPosition, widthFor(3)).map((c) => c.key)).toEqual(["ts", "lat"]);
  });

  it("holds nothing back on a desk", () => {
    expect(fittedColumns(withPosition, 1456)).toEqual(withPosition);
  });
});
