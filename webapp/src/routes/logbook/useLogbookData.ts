/** Data + logic layer for the logbook screen - independent of theme variants.
 *  The marine / pastel / ios variants consume these hooks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Snapshot } from "../../lib/api";
import { bucketHours, bucketRow, type BucketGran, type Stat } from "../../lib/buckets";
import { dateInputToMs, dateToInput } from "../../lib/format";
import { startVisibleInterval } from "../../lib/visibleInterval";
import { useNow } from "../../lib/useNow";

export type Granularity = "1m" | "1h" | "6h" | "1d";
export type Mode = "live" | "day" | "range";

export const GRANULARITY_MINUTES: Record<Granularity, number> = {
  "1m": 1,
  "1h": 60,
  "6h": 360,
  "1d": 1440,
};

/** What an interval is called in a sentence, as opposed to on a chip ("1h"). Named once: the
 *  export panel offers these and the range view's bar reports the one that was chosen, and two
 *  copies of a list like this drift the day somebody adds an interval. */
export const INTERVAL_NAME: Record<Granularity, string> = {
  "1m": "Every minute",
  "1h": "Hourly",
  "6h": "Six-hourly",
  "1d": "Daily",
};

export const ROWS_LIMIT: Record<Granularity, number> = {
  "1m": 60,
  "1h": 48,
  "6h": 40,
  "1d": 30,
};

const REFRESH_MS = 15_000;

export { useNow } from "../../lib/useNow";

export interface LogbookLive {
  snaps: Snapshot[];
  err: string | null;
  busy: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

/**
 * The interval is the caller's now, not this hook's. The screen fades between what it shows,
 * and the choice a reader pressed has to be able to trail behind the table that is drawn -
 * which means the choice lives where the fade does, and this hook is handed the interval the
 * table should be showing.
 *
 * A change of interval keeps the rows it has until the new ones arrive, the way the day and
 * range hooks always have. Emptying the page first looked free, but the page's width comes
 * off its rows: a table with none falls back to whatever lanes fit the screen, the frame
 * swelled to that for the beat the fetch took, and the fade turned the beat into a visible
 * stretch and snap-back. The stale rows themselves are never seen - they sit under the fade,
 * and the answer lands well inside it.
 */
export function useLogbookLive(granularity: Granularity): LogbookLive {
  const [extraLoads, setExtraLoads] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [prevGran, setPrevGran] = useState(granularity);
  if (prevGran !== granularity) {
    setPrevGran(granularity);
    setExtraLoads(0);
    setHasMore(false);
  }

  const bucket = GRANULARITY_MINUTES[granularity];
  const limit = ROWS_LIMIT[granularity] + extraLoads * ROWS_LIMIT[granularity];

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const fetchLimit = limit + 1;
      // At minute resolution this is the deep read: the boat keeps a window of raw hours that
      // reaches past midnight, and the cheap path would answer the small hours of a new day
      // with a nearly empty page while she still held the night.
      const rows =
        bucket === 1
          ? (await api.logbook.minutes({ limit: fetchLimit, order: "desc" })).rows
          : await api.logbook.snapshots({ bucket, limit: fetchLimit, order: "desc" });
      setHasMore(rows.length > limit);
      setSnaps(rows.slice(0, limit));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [bucket, limit]);

  useEffect(() => {
    // load() is async - setBusy/setErr fire after the await, so no cascading
    // render. Standard mount + interval polling pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const stopInterval = startVisibleInterval(load, REFRESH_MS);
    return () => stopInterval();
  }, [load]);

  const loadMore = useCallback(() => setExtraLoads((n) => n + 1), []);

  return { snaps, err, busy, hasMore, loadMore };
}

export interface LogbookDay {
  dateStr: string;
  setDateStr: (s: string) => void;
  dayStart: number;
  isToday: boolean;
  snaps: Snapshot[];
  err: string | null;
  busy: boolean;
  prevDay: () => void;
  nextDay: () => void;
  goToday: () => void;
}

export function useLogbookDay(): LogbookDay {
  const [dateStr, setDateStr] = useState(dateToInput());
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether we're tracking "live today" - advances automatically when midnight passes.
  // False when the user navigates to a past/future day; true again on goToday.
  const following = useRef(true);

  // Local day that ticks once a minute (pauses while the tab is hidden). We derive
  // isToday from this so we notice the midnight rollover.
  const todayMs = useNow(60_000);
  const todayStr = dateToInput(new Date(todayMs));

  const dayStart = useMemo(() => dateInputToMs(dateStr), [dateStr]);
  const dayEnd = dayStart + 24 * 3600_000;
  const isToday = dateStr === todayStr;

  // When midnight passes, advance the selected day if we're still tracking today.
  // This keeps isToday true, re-establishes the polling effect (no freeze), and
  // the panel keeps following the live day.
  useEffect(() => {
    if (following.current && dateStr !== todayStr) setDateStr(todayStr);
  }, [todayStr, dateStr]);

  // Date change - enable tracking if today is selected, disable otherwise.
  const setDate = useCallback((s: string) => {
    following.current = s === dateToInput();
    setDateStr(s);
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const rows = await api.logbook.snapshots({
        from: dayStart,
        to: dayEnd,
        limit: 5000,
        order: "desc",
        bucket: 60,
      });
      setSnaps(rows);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [dayStart, dayEnd]);

  useEffect(() => {
    // load() is async - setBusy/setErr fire after the await, so no cascading
    // render. In day mode, initial fetch when a day opens + interval polling
    // only when it's "today".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    if (!isToday) return;
    // Periodic refresh only in the "today" view; pauses while the tab is hidden.
    const stopInterval = startVisibleInterval(load, REFRESH_MS);
    return () => stopInterval();
  }, [load, isToday]);

  const prevDay = useCallback(
    () => setDate(dateToInput(new Date(dayStart - 86400_000))),
    [dayStart, setDate],
  );
  const nextDay = useCallback(
    () => setDate(dateToInput(new Date(dayStart + 86400_000))),
    [dayStart, setDate],
  );
  const goToday = useCallback(() => setDate(dateToInput()), [setDate]);

  return { dateStr, setDateStr: setDate, dayStart, isToday, snaps, err, busy, prevDay, nextDay, goToday };
}

/**
 * The most rows a range will draw or write out.
 *
 * A month at one minute is 43200 rows, and neither a table nor a sheet of paper is the place
 * to find that out. The ceiling is high enough that every ordinary window fits under it and
 * low enough that the page stays a page; when it bites, the reader is told so in the same
 * sentence that gives him the count, because a file silently missing its tail is worse than
 * one that says where it stops.
 */
export const RANGE_LIMIT = 5000;

export interface LogbookRange {
  snaps: Snapshot[];
  err: string | null;
  busy: boolean;
  /** More rows exist in this window than the ceiling allows, and the oldest were dropped. */
  truncated: boolean;
  /** The window has been asked for and answered at least once. Not the same as "not busy":
   *  before the first fetch has even been issued nothing is busy either, and a caller waiting
   *  for rows to exist (the print path does) would fire against an empty table. */
  loaded: boolean;
  /** At minute resolution, the instant the boat's own minutes begin - null at every other
   *  interval, where the question does not arise. Anything in the window before it arrived as
   *  one row per hour, and the page says so rather than letting it read as a fault. */
  minutesFrom: number | null;
  /** The same windows read as plain readings, when the caller asked for a summary figure.
   *
   *  A summary cannot be taken of everything the boat logs - there is no mean of a heading and
   *  none of "motoring" - so those columns are simply not there on an average page, and a
   *  reader who chose them watches them go without being told why. Which ones went is not a
   *  list anybody should keep by hand: it is the difference between these rows and the ones
   *  above, and the caller works it out by asking both the same question. Costs no fetch; the
   *  buckets are already in hand. Empty when the figure IS the reading. */
  plain: Snapshot[];
}

/**
 * Every row in a window the reader chose, at the interval he chose, carrying the figure he
 * asked for.
 *
 * The figure is why this reads the boat's own summaries rather than `/snapshots`. That endpoint
 * hands back one value per bucket - the last one - which is a logbook page and nothing else; a
 * page of hourly means cannot be built from it. The summaries carry min, max, mean and the
 * sample count for every reading, and the CSV export has been reading them since it learned to
 * offer figures. This is the same source, so a window written to a file and the same window on
 * the page are the same numbers.
 *
 * Measured before it was moved: over a settled twelve hours, `/snapshots?bucket=60` and this
 * path's "last" agree row for row and digit for digit, and both carry the same 52 gauges. So
 * the page a reader has been printing did not change when its source did.
 *
 * Not polled. The other two views follow a boat that is still logging; a window with an end on
 * it is a closed question, and refreshing it every fifteen seconds would move the rows under a
 * reader who is reading them. It reloads when the window or the interval changes and not
 * otherwise.
 *
 * The dates are the reader's own local days, inclusive at both ends: he picks the 3rd and the
 * 5th and means the whole of the 5th too. The API takes moments, so the end is the last
 * millisecond of that day rather than its start, which is the off-by-a-day this would
 * otherwise have.
 */
export function useLogbookRange(
  fromStr: string,
  toStr: string,
  gran: Granularity,
  /** Which figure of each window the rows carry. A minute is a sample, not a window: it has no
   *  mean and no extremes, so at that interval this is not read. */
  stat: Stat = "last",
): LogbookRange {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [minutesFrom, setMinutesFrom] = useState<number | null>(null);
  const [plain, setPlain] = useState<Snapshot[]>([]);

  const from = useMemo(() => dateInputToMs(fromStr), [fromStr]);
  const to = useMemo(() => dateInputToMs(toStr) + 86400_000 - 1, [toStr]);
  const bucket = GRANULARITY_MINUTES[gran];

  const load = useCallback(async () => {
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
      setSnaps([]);
      setPlain([]);
      setTruncated(false);
      setErr(null);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    setBusy(true);
    setErr(null);
    try {
      let rows: Snapshot[];
      setPlain([]);
      if (bucket === 1) {
        // One more than the ceiling, so the count itself says whether anything was left behind.
        const r = await api.logbook.minutes({ from, to, limit: RANGE_LIMIT + 1, order: "desc" });
        setMinutesFrom(r.minutesFrom);
        rows = r.rows;
      } else {
        const hours = await api.logbook.rollupHours(from, to);
        setMinutesFrom(null);
        // bucketHours returns oldest first; the ceiling keeps the newest, the way the desc
        // fetch above does, because a window too long to draw is cut at its far end.
        const buckets = bucketHours(hours, gran as BucketGran);
        rows = buckets.map((b) => bucketRow(b, stat));
        const keep = (r: Snapshot[]) => r.slice(Math.max(0, r.length - RANGE_LIMIT));
        setTruncated(rows.length > RANGE_LIMIT);
        setSnaps(keep(rows));
        if (stat !== "last") setPlain(keep(buckets.map((b) => bucketRow(b, "last"))));
        return;
      }
      setTruncated(rows.length > RANGE_LIMIT);
      setSnaps(rows.slice(0, RANGE_LIMIT));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, [from, to, bucket, gran, stat]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { snaps, err, busy, truncated, loaded, minutesFrom, plain };
}
