/**
 * Which of the columns a book earns are actually drawn, and how that survives a reload.
 *
 * A page shows one book now, so a selection belongs to one book too. It is stored as the
 * columns turned OFF rather than as a list of the ones on. The difference matters the day an
 * instrument is fitted: a stored list of names would leave the new gauge out of the log until
 * somebody noticed the picker, whereas a stored set of refusals lets the boat speak for
 * anything nobody has ruled on. A boat that grows a fourth engine puts it in the engineer's
 * log the hour she reports it.
 *
 * Each book remembers separately. A reader who wants no barometer in the deck log has said
 * nothing about the engineer's, and a single store would make him say it twice.
 */
import type { LogBook } from "./columns";

export interface ColumnSelection {
  /** Columns of this book the reader has turned off. */
  off: string[];
}

/**
 * The one thing this module asks of an item: the key a refusal is stored under. The bridge's
 * columns carry one and so do the engineer's readings, which is how one store and one picker
 * serve a table drawn either way.
 */
export interface Keyed {
  key: string;
}

/** What the picker needs of an item: its key and the word on its chip. */
export interface PickItem extends Keyed {
  head: string;
}

/**
 * The key one book's choice is stored under.
 *
 * Named per book from the start, which also retires the single `lb:columns` of the days when
 * one page carried both books. That value is not read: it held a bridge list and an engine
 * list in one object whose meaning has no counterpart here, and a preference reset once is
 * cheaper than a translation nobody will ever look at again.
 */
const KEY = (book: LogBook) => `lb:columns:${book}`;

/** Nothing refused: every column the book earned. What a boat shows before anybody chooses. */
export const ALL_ON: ColumnSelection = { off: [] };

/**
 * The time column, which is not a choice: a row without its moment is not a log entry. It is
 * never offered in the picker and never counted in a total.
 */
export const FIXED_KEY = "ts";

export function isFixed(col: Keyed): boolean {
  return col.key === FIXED_KEY;
}

/** Whether this column is drawn under the given selection. */
export function isOn(col: Keyed, sel: ColumnSelection): boolean {
  return isFixed(col) || !sel.off.includes(col.key);
}

export function visibleColumns<T extends Keyed>(cols: T[], sel: ColumnSelection): T[] {
  return cols.filter((c) => isOn(c, sel));
}

/** The columns the picker offers, in the order they would be drawn. */
export function offerable<T extends Keyed>(cols: T[]): T[] {
  return cols.filter((c) => !isFixed(c));
}

export function withToggled(sel: ColumnSelection, col: Keyed): ColumnSelection {
  if (isFixed(col)) return sel;
  return {
    off: isOn(col, sel) ? [...sel.off, col.key] : sel.off.filter((k) => k !== col.key),
  };
}

/** Every column on, or every one off. */
export function withAll(cols: Keyed[], on: boolean): ColumnSelection {
  return { off: on ? [] : offerable(cols).map((c) => c.key) };
}

export function same(a: ColumnSelection, b: ColumnSelection): boolean {
  return sorted(a.off) === sorted(b.off);
}

/**
 * Read back what was chosen last for this book, or every column.
 *
 * Anything unreadable is every column too: a torn value in a browser store is not a reason to
 * show a person an empty table, and the cure is one visit to the picker.
 */
export function loadSelection(book: LogBook): ColumnSelection {
  try {
    const raw = globalThis.localStorage?.getItem(KEY(book));
    if (!raw) return ALL_ON;
    const parsed = JSON.parse(raw) as Partial<ColumnSelection>;
    return {
      off: Array.isArray(parsed.off) ? parsed.off.filter((k) => typeof k === "string") : [],
    };
  } catch {
    return ALL_ON;
  }
}

export function saveSelection(book: LogBook, sel: ColumnSelection): void {
  try {
    globalThis.localStorage?.setItem(KEY(book), JSON.stringify(sel));
  } catch {
    // A browser refusing to store it (private mode, a full quota) still shows the table it
    // was asked for; only the memory of it is lost.
  }
}

function sorted(keys: string[]): string {
  return [...new Set(keys)].sort().join(" ");
}
