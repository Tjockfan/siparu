/** Data + logic layer for the logbook screen - independent of theme variants.
 *  The marine / pastel / ios variants consume these hooks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Snapshot } from "../../lib/api";
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
  granularity: Granularity;
  changeGran: (g: Granularity) => void;
  snaps: Snapshot[];
  err: string | null;
  busy: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

export function useLogbookLive(): LogbookLive {
  const [granularity, setGranularity] = useState<Granularity>("1h");
  const [extraLoads, setExtraLoads] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bucket = GRANULARITY_MINUTES[granularity];
  const limit = ROWS_LIMIT[granularity] + extraLoads * ROWS_LIMIT[granularity];

  const changeGran = useCallback((g: Granularity) => {
    setGranularity(g);
    setExtraLoads(0);
    setSnaps([]);
    setHasMore(false);
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const fetchLimit = limit + 1;
      const rows = await api.logbook.snapshots({ bucket, limit: fetchLimit, order: "desc" });
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

  return { granularity, changeGran, snaps, err, busy, hasMore, loadMore };
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
}

/**
 * Every row in a window the reader chose, at the interval he chose.
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
export function useLogbookRange(fromStr: string, toStr: string, gran: Granularity): LogbookRange {
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const from = useMemo(() => dateInputToMs(fromStr), [fromStr]);
  const to = useMemo(() => dateInputToMs(toStr) + 86400_000 - 1, [toStr]);
  const bucket = GRANULARITY_MINUTES[gran];

  const load = useCallback(async () => {
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
      setSnaps([]);
      setTruncated(false);
      setErr(null);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    setBusy(true);
    setErr(null);
    try {
      // One more than the ceiling, so the count itself says whether anything was left behind.
      const rows = await api.logbook.snapshots({
        from,
        to,
        bucket,
        limit: RANGE_LIMIT + 1,
        order: "desc",
      });
      setTruncated(rows.length > RANGE_LIMIT);
      setSnaps(rows.slice(0, RANGE_LIMIT));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, [from, to, bucket]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { snaps, err, busy, truncated, loaded };
}
