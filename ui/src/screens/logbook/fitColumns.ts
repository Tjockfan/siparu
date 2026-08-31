/**
 * How many lanes the table can draw at a given width, and why a phone is not simply given
 * every column the reader chose.
 *
 * Measured on a 390px phone with nine bridge columns on: each figure had a 29px lane and the
 * header 8.5px of type, so "COG 117 HDG 117" read as one number printed twice. The grid shares
 * out whatever room is left, so the cure is not a narrower minimum - it is fewer lanes.
 *
 * Held back, not dropped. The selection is the reader's and is the same on every screen; a
 * narrow one draws the first lanes of it, in reading order, and the picker button carries the
 * count that says so. Nothing is hidden silently.
 */
import type { LogColumn } from "./columns";
import type { UnitMetric } from "./unitRows";

/** These match `.lb-cols` / `.lb-row` in swiss.css: the time lane, the gap between lanes, and
 *  the row's side padding. Changing one there without the other here shows up as a lane drawn
 *  half off the right edge. */
export const TIME_LANE = 58;
export const LANE_GAP = 4;
export const SIDE_PAD = 32;

/** The narrowest a data lane may be and still be read: "1014" set in 14px tabular figures is
 *  31px wide, and a four-letter head at 11px is 30px. Below this the figures touch their
 *  neighbours and two columns read as one. */
export const MIN_LANE = 48;

/** The engineer's table leads with a machine's name as well as an hour. Matches --lb-unit. */
export const UNIT_LANE = 104;

/** How many data lanes fit beside the time lane. At least one: a table with a time column and
 *  nothing beside it is not a log. */
export function lanesThatFit(width: number): number {
  const room = width - SIDE_PAD - TIME_LANE;
  return Math.max(1, Math.floor(room / (MIN_LANE + LANE_GAP)));
}

/** The lanes a set of data columns occupies. Most readings take one; a position takes two. */
export function laneCount(cols: LogColumn[]): number {
  return cols.reduce((n, c) => n + (c.lanes ?? 1), 0);
}

/**
 * The columns actually drawn at this width.
 *
 * A null width means the table has not been measured yet - server-rendered, or a browser with
 * no ResizeObserver. That is deliberately not treated as "narrow": a table that cannot see its
 * own width draws everything rather than guessing which columns to hold back.
 *
 * Spent against a budget of lanes rather than counted off one per column, because a column can
 * ask for more than one (see LogColumn.lanes). A column whose lanes do not all fit is held back
 * whole: half a position, drawn in a lane sized for a heading, is the defect this replaced.
 */
export function fittedColumns(cols: LogColumn[], width: number | null): LogColumn[] {
  if (width === null || cols.length === 0) return cols;
  let left = lanesThatFit(width);
  const drawn = cols.slice(0, 1);
  for (const c of cols.slice(1)) {
    const want = c.lanes ?? 1;
    if (want > left) break;
    left -= want;
    drawn.push(c);
  }
  return drawn;
}

/**
 * The readings actually drawn beside a machine's name.
 *
 * Held back the same way and for the same reason as a column: the unit-major table leads with
 * two lanes rather than one, so a narrow screen has that much less room for readings and gets
 * the first of them rather than a row of lanes too thin to read.
 */
export function fittedMetrics(
  metrics: UnitMetric[],
  width: number | null,
  unitLane: boolean,
): UnitMetric[] {
  if (width === null) return metrics;
  return metrics.slice(0, lanesThatFit(width - (unitLane ? UNIT_LANE + LANE_GAP : 0)));
}
