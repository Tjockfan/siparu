/**
 * What the shared minute read carries back besides rows.
 *
 * The boat's `clamped` is two answers under one name (plugin/src/query.ts): the page was cut
 * at her row ceiling, OR the window reached back past the minutes she still keeps. This read
 * asks for exactly the second one on purpose - it hands her the whole window and fills what
 * lies before her floor from the hourly rollup - so taking her flag at face value would call
 * a complete answer partial. What has to reach a reader is only the first: a window that came
 * back short of what he asked for, with nothing said.
 *
 * The boat here is therefore not a stub returning a fixed flag; it answers the way she does,
 * because the bug this pins lives in the relationship between the window and her floor.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { BOAT_PAGE_MAX, sharedReads } from "./reads";
import type { RollupHour, Snapshot, SnapshotsQuery, SnapshotsResult } from "./api";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

/**
 * A boat holding one row a minute from `minutesFrom` to now, answering the way the plugin
 * does: raw rows from her floor onward, at most her page, and the flag set by either cause.
 */
function boat(minutesFrom: number) {
  const snapshots = vi.fn(async (q: SnapshotsQuery & { bucket: number }): Promise<SnapshotsResult> => {
    const to = q.to ?? NOW;
    const from = Math.max(q.from ?? minutesFrom, minutesFrom);
    let clamped = (q.from ?? minutesFrom) < minutesFrom || to < minutesFrom;
    const all: Snapshot[] = [];
    for (let ts = Math.ceil(from / MINUTE) * MINUTE; ts <= to; ts += MINUTE) all.push({ ts } as Snapshot);
    all.sort((a, b) => (q.order === "asc" ? a.ts - b.ts : b.ts - a.ts));
    const rows = all.slice(0, Math.min(q.limit ?? 200, BOAT_PAGE_MAX));
    if (rows.length < all.length) clamped = true;
    return { rows, clamped, minutesFrom };
  });
  // One row an hour for everything before her floor, which is what fills a longer window.
  const rollupHours = vi.fn(async (from: number, to: number): Promise<RollupHour[]> => {
    const out: RollupHour[] = [];
    for (let ts = Math.ceil(from / HOUR) * HOUR; ts <= to; ts += HOUR) {
      out.push({ hour: ts / HOUR, last_ts: ts, pos_last: null, metrics: {} } as unknown as RollupHour);
    }
    return out;
  });
  return { reads: sharedReads({ snapshots, rollupHours }), snapshots, rollupHours };
}

describe("the shared minute read", () => {
  it("agrees with the boat about how many rows one page holds", () => {
    // The read tells a cut page from a window that merely ended by whether the page came back
    // full, so this number has to be hers. Her declaration is read as text rather than
    // imported: these screens ship in two apps and only one of them builds beside the plugin,
    // and pulling a value across that line would put the plugin's sources in both bundles.
    const src = readFileSync(new URL("../../../plugin/src/query.ts", import.meta.url), "utf8");
    const declared = /^export const LIMIT_MAX = (\d+)$/m.exec(src)?.[1];
    expect(Number(declared)).toBe(BOAT_PAGE_MAX);
  });

  it("does not call an answer partial just because the window reached past her minutes", async () => {
    // She keeps two days of raw; a five-day window is answered in full, minutes for what she
    // has and one row an hour for the rest. She flags it, because from her side the raw range
    // was narrowed - but nothing was withheld from the reader.
    const { reads } = boat(NOW - 2 * 24 * HOUR);
    const res = await reads.minutes({ from: NOW - 5 * 24 * HOUR, to: NOW, limit: BOAT_PAGE_MAX + 1 });
    expect(res.rows.length).toBeLessThan(BOAT_PAGE_MAX);
    expect(res.clamped).toBe(false);
  });

  it("does not call a window older than her minutes partial either", async () => {
    // Nothing raw at all in this window: it is entirely before her floor and comes back as
    // hourly rows. Complete, in the only resolution that exists for those days.
    const { reads } = boat(NOW - 2 * 24 * HOUR);
    const res = await reads.minutes({ from: NOW - 20 * 24 * HOUR, to: NOW - 10 * 24 * HOUR, limit: BOAT_PAGE_MAX + 1 });
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.clamped).toBe(false);
  });

  it("carries a page she really did cut, which no count on this side can infer", async () => {
    // She keeps a week, the reader asks for a week: her ceiling bites and the answer stops
    // around three and a half days in. Asking for one row past his own ceiling proves nothing,
    // because hers is the same number - the flag is the only evidence there is.
    const { reads } = boat(NOW - 7 * 24 * HOUR);
    const res = await reads.minutes({ from: NOW - 7 * 24 * HOUR, to: NOW, limit: BOAT_PAGE_MAX + 1 });
    expect(res.rows).toHaveLength(BOAT_PAGE_MAX);
    expect(res.clamped).toBe(true);
  });

  it("reports a window well inside her minutes as whole", async () => {
    const { reads } = boat(NOW - 7 * 24 * HOUR);
    const res = await reads.minutes({ from: NOW - 2 * HOUR, to: NOW, limit: BOAT_PAGE_MAX + 1 });
    expect(res.rows).toHaveLength(121);
    expect(res.clamped).toBe(false);
  });

  it("narrows on its own account too, when the caller's limit cuts what she sent whole", async () => {
    const { reads } = boat(NOW - 7 * 24 * HOUR);
    const res = await reads.minutes({ from: NOW - 2 * HOUR, to: NOW, limit: 10 });
    expect(res.rows).toHaveLength(10);
    expect(res.clamped).toBe(true);
  });

  it("still says where the boat's minutes begin", async () => {
    const floor = NOW - 3 * 24 * HOUR;
    const { reads } = boat(floor);
    expect((await reads.minutes({ from: NOW - HOUR, to: NOW })).minutesFrom).toBe(floor);
  });
});
