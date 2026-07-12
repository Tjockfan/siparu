/** Data + logic layer for the logbook screen - independent of theme variants.
 *  The marine / pastel / ios variants consume these hooks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Snapshot } from "../../lib/api";
import { dateInputToMs, dateToInput } from "../../lib/format";
import { startVisibleInterval } from "../../lib/visibleInterval";
import { useNow } from "../../lib/useNow";

export type Granularity = "1m" | "1h" | "6h" | "1d";
export type Mode = "live" | "day";

export const GRANULARITY_MINUTES: Record<Granularity, number> = {
  "1m": 1,
  "1h": 60,
  "6h": 360,
  "1d": 1440,
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
