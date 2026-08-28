/**
 * What one book's page remembers, and what it deliberately does not.
 *
 * The selection is stored as the columns turned off rather than as a list of the ones on, and
 * that choice is what these mostly pin. A stored list would be right until the day a gauge is
 * fitted: the new column would be missing from the list, and so missing from the log, and
 * nothing on screen would say why. A set of refusals lets the boat speak for anything nobody
 * has ruled on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_ON,
  loadSelection,
  offerable,
  same,
  saveSelection,
  visibleColumns,
  withAll,
  withToggled,
} from "./columnSelection";
import { columnsFor, type LogColumn } from "./columns";

const col = (key: string, book: "bridge" | "engine"): LogColumn => ({
  key,
  head: key.toUpperCase(),
  book,
  cell: () => "·",
});

const EARNED: LogColumn[] = [
  col("ts", "bridge"),
  col("sog", "bridge"),
  col("dep", "bridge"),
  col("p:rpm", "engine"),
  col("p:oil", "engine"),
];

const BRIDGE = columnsFor(EARNED, "bridge");
const ENGINE = columnsFor(EARNED, "engine");

const heads = (cols: LogColumn[], sel = ALL_ON) => visibleColumns(cols, sel).map((c) => c.key);

describe("one page, one book", () => {
  it("draws its own book and the hour, and none of the other book", () => {
    expect(heads(BRIDGE)).toEqual(["ts", "sog", "dep"]);
    expect(heads(ENGINE)).toEqual(["ts", "p:rpm", "p:oil"]);
  });

  /** The reason for storing refusals rather than a list: an instrument fitted since. */
  it("draws a column nobody has ruled on, and keeps the one she refused", () => {
    const chosen = withToggled(ALL_ON, col("p:rpm", "engine"));
    const later = columnsFor([...EARNED, col("p:temp", "engine")], "engine");
    expect(heads(later, chosen)).toEqual(["ts", "p:oil", "p:temp"]);
  });

  /** A row without its moment is not a log entry; the time column is not on offer. */
  it("cannot be talked out of the time column", () => {
    const none = withAll(BRIDGE, false);
    expect(heads(BRIDGE, none)).toEqual(["ts"]);
    expect(offerable(BRIDGE).map((c) => c.key)).toEqual(["sog", "dep"]);
    expect(heads(BRIDGE, withToggled(none, col("ts", "bridge")))).toEqual(["ts"]);
  });

  it("turns them all on and all off", () => {
    expect(same(withAll(ENGINE, true), ALL_ON)).toBe(true);
    expect(heads(ENGINE, withAll(ENGINE, false))).toEqual(["ts"]);
  });
});

describe("remembering it", () => {
  // The suite runs without a DOM, so there is no localStorage unless one is put here. Without
  // this the storage cases would pass by doing nothing at all, which is the shape of green
  // test this repo has been caught by before.
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  it("reads back what was written", () => {
    const sel = withToggled(ALL_ON, col("dep", "bridge"));
    saveSelection("bridge", sel);
    expect(loadSelection("bridge")).toEqual(sel);
  });

  /**
   * The two books are two decisions. Refusing a column in the deck log said nothing about the
   * engineer's, and one store would have made a reader say it twice - or worse, would have
   * emptied a page he never opened.
   */
  it("keeps each book's choice to itself", () => {
    saveSelection("bridge", withAll(BRIDGE, false));
    expect(loadSelection("engine")).toEqual(ALL_ON);
    expect(heads(ENGINE, loadSelection("engine"))).toEqual(["ts", "p:rpm", "p:oil"]);
  });

  it("falls back to every column on a torn value rather than an empty table", () => {
    globalThis.localStorage.setItem("lb:columns:bridge", "{ not json");
    expect(loadSelection("bridge")).toEqual(ALL_ON);
    globalThis.localStorage.setItem("lb:columns:bridge", JSON.stringify({ off: "all of them" }));
    expect(loadSelection("bridge")).toEqual(ALL_ON);
  });
});
