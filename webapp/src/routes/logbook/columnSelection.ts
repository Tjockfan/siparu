/**
 * Which of the columns a boat earns are actually drawn, and how that survives a reload.
 *
 * The two books together are wider than any screen: a three-engine motor yacht earns nine
 * bridge columns and thirty-odd engine ones. So the table shows a selection, and this is the
 * model behind it.
 *
 * It is stored as two differences from the default rather than as a list of what is on. The
 * difference matters the day an instrument is fitted: a stored list of names would leave the
 * new gauge out of the log until somebody noticed the picker, whereas a stored difference lets
 * the default speak for anything nobody has ruled on. The default is the deck log - every
 * bridge column, no engine ones - because that is the log a boat under way is kept in.
 */
import type { LogBook, LogColumn } from "./columns";

export interface ColumnSelection {
  /** Bridge columns the reader has turned off. */
  off: string[];
  /** Engine columns the reader has turned on. */
  on: string[];
}

const KEY = "lb:columns";

/** Every bridge column, no engine ones. What a boat shows before anybody chooses. */
export const DECK_LOG: ColumnSelection = { off: [], on: [] };

/**
 * The time column, which is not a choice: a row without its moment is not a log entry. It is
 * never offered in the picker and never counted in a total.
 */
export const FIXED_KEY = "ts";

export function isFixed(col: LogColumn): boolean {
  return col.key === FIXED_KEY;
}

/** Whether this column is drawn under the given selection. */
export function isOn(col: LogColumn, sel: ColumnSelection): boolean {
  if (isFixed(col)) return true;
  return col.book === "bridge" ? !sel.off.includes(col.key) : sel.on.includes(col.key);
}

export function visibleColumns(cols: LogColumn[], sel: ColumnSelection): LogColumn[] {
  return cols.filter((c) => isOn(c, sel));
}

/** The columns the picker offers for one book, in the order they would be drawn. */
export function bookColumns(cols: LogColumn[], book: LogBook): LogColumn[] {
  return cols.filter((c) => !isFixed(c) && c.book === book);
}

export function withToggled(sel: ColumnSelection, col: LogColumn): ColumnSelection {
  if (isFixed(col)) return sel;
  const on = isOn(col, sel);
  if (col.book === "bridge") {
    return { ...sel, off: on ? [...sel.off, col.key] : sel.off.filter((k) => k !== col.key) };
  }
  return { ...sel, on: on ? sel.on.filter((k) => k !== col.key) : [...sel.on, col.key] };
}

/** Every column of one book on, or every one off, leaving the other book alone. */
export function withBook(
  sel: ColumnSelection,
  cols: LogColumn[],
  book: LogBook,
  on: boolean
): ColumnSelection {
  const keys = bookColumns(cols, book).map((c) => c.key);
  if (book === "bridge") {
    return {
      ...sel,
      off: on ? sel.off.filter((k) => !keys.includes(k)) : unique([...sel.off, ...keys]),
    };
  }
  return {
    ...sel,
    on: on ? unique([...sel.on, ...keys]) : sel.on.filter((k) => !keys.includes(k)),
  };
}

export type Preset = "deck" | "engine" | "both";

/** What each preset means for the columns this boat happens to earn. */
export function preset(name: Preset, cols: LogColumn[]): ColumnSelection {
  const bridge = bookColumns(cols, "bridge").map((c) => c.key);
  const engine = bookColumns(cols, "engine").map((c) => c.key);
  if (name === "deck") return { off: [], on: [] };
  if (name === "engine") return { off: bridge, on: engine };
  return { off: [], on: engine };
}

/**
 * Which preset this selection happens to be, or null for one of her own.
 *
 * Derived rather than stored: a selection is the truth and a preset is a description of it, so
 * turning one column off after choosing "Both" leaves a selection that is simply not a preset
 * any more, rather than a preset that quietly lies.
 */
export function presetOf(sel: ColumnSelection, cols: LogColumn[]): Preset | null {
  for (const name of ["deck", "engine", "both"] as Preset[]) {
    if (same(preset(name, cols), sel)) return name;
  }
  return null;
}

export function same(a: ColumnSelection, b: ColumnSelection): boolean {
  return sorted(a.off) === sorted(b.off) && sorted(a.on) === sorted(b.on);
}

/**
 * Read back what was chosen last, or the deck log.
 *
 * Anything unreadable is the deck log too: a torn value in a browser store is not a reason to
 * show a person an empty table, and the cure is one visit to the picker.
 */
export function loadSelection(): ColumnSelection {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DECK_LOG;
    const parsed = JSON.parse(raw) as Partial<ColumnSelection>;
    return {
      off: Array.isArray(parsed.off) ? parsed.off.filter((k) => typeof k === "string") : [],
      on: Array.isArray(parsed.on) ? parsed.on.filter((k) => typeof k === "string") : [],
    };
  } catch {
    return DECK_LOG;
  }
}

export function saveSelection(sel: ColumnSelection): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(sel));
  } catch {
    // A browser refusing to store it (private mode, a full quota) still shows the table it
    // was asked for; only the memory of it is lost.
  }
}

function unique(keys: string[]): string[] {
  return [...new Set(keys)];
}

function sorted(keys: string[]): string {
  return [...keys].sort().join(" ");
}
