/**
 * What the picker remembers, and what it deliberately does not.
 *
 * The selection is stored as two differences from the deck log rather than as a list of the
 * columns that are on, and that choice is what these mostly pin. A stored list would be right
 * until the day a gauge is fitted: the new column would be missing from the list, and so
 * missing from the log, and nothing on screen would say why. A stored difference lets the
 * default speak for anything nobody has ruled on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DECK_LOG,
  loadSelection,
  preset,
  presetOf,
  saveSelection,
  visibleColumns,
  withBook,
  withToggled,
} from "./columnSelection";
import type { LogColumn } from "./columns";

const col = (key: string, book: "bridge" | "engine"): LogColumn => ({
  key,
  head: key.toUpperCase(),
  book,
  cell: () => "·",
});

const COLS: LogColumn[] = [
  col("ts", "bridge"),
  col("sog", "bridge"),
  col("dep", "bridge"),
  col("p:rpm", "engine"),
  col("p:oil", "engine"),
];

const heads = (sel = DECK_LOG) => visibleColumns(COLS, sel).map((c) => c.key);

describe("what a boat shows before anybody chooses", () => {
  it("keeps the deck log: every bridge column, no engine ones", () => {
    expect(heads()).toEqual(["ts", "sog", "dep"]);
  });

  /**
   * The reason for storing differences rather than a list. Both cases are an instrument fitted
   * after somebody last opened the picker.
   */
  it("draws a bridge column nobody has ruled on, and leaves a new engine one out", () => {
    const chosen = withToggled(DECK_LOG, col("sog", "bridge")); // she turned SOG off
    const later = [...COLS, col("sea", "bridge"), col("p:temp", "engine")];
    const shown = visibleColumns(later, chosen).map((c) => c.key);
    expect(shown).toContain("sea"); // the new bridge gauge appears
    expect(shown).not.toContain("p:temp"); // the new engine gauge waits to be asked for
    expect(shown).not.toContain("sog"); // and her own decision survives
  });
});

describe("the three books on the bar", () => {
  it("means what it says for the columns this boat happens to earn", () => {
    expect(visibleColumns(COLS, preset("deck", COLS)).map((c) => c.key)).toEqual([
      "ts",
      "sog",
      "dep",
    ]);
    expect(visibleColumns(COLS, preset("engine", COLS)).map((c) => c.key)).toEqual([
      "ts",
      "p:rpm",
      "p:oil",
    ]);
    expect(visibleColumns(COLS, preset("both", COLS)).map((c) => c.key)).toEqual([
      "ts",
      "sog",
      "dep",
      "p:rpm",
      "p:oil",
    ]);
  });

  /** The preset is a description of the selection, never a thing the selection remembers. */
  it("stops describing itself as a preset once she edits one column", () => {
    const both = preset("both", COLS);
    expect(presetOf(both, COLS)).toBe("both");
    expect(presetOf(withToggled(both, col("dep", "bridge")), COLS)).toBeNull();
  });

  it("turns a whole book on or off without touching the other", () => {
    const allOn = withBook(preset("deck", COLS), COLS, "engine", true);
    expect(presetOf(allOn, COLS)).toBe("both");
    const noBridge = withBook(allOn, COLS, "bridge", false);
    expect(presetOf(noBridge, COLS)).toBe("engine");
  });

  /** A row without its moment is not a log entry; the time column is not on offer. */
  it("cannot be talked out of the time column", () => {
    const stripped = withBook(withBook(DECK_LOG, COLS, "bridge", false), COLS, "engine", false);
    expect(visibleColumns(COLS, stripped).map((c) => c.key)).toEqual(["ts"]);
    expect(visibleColumns(COLS, withToggled(stripped, col("ts", "bridge"))).map((c) => c.key)).toEqual(
      ["ts"]
    );
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
    const sel = preset("both", COLS);
    saveSelection(sel);
    expect(loadSelection()).toEqual(sel);
  });

  it("falls back to the deck log on a torn value rather than an empty table", () => {
    globalThis.localStorage.setItem("lb:columns", "{ not json");
    expect(loadSelection()).toEqual(DECK_LOG);
    globalThis.localStorage.setItem("lb:columns", JSON.stringify({ off: "all of them" }));
    expect(loadSelection()).toEqual(DECK_LOG);
  });
});
