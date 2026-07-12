import { useEffect, useRef, useState } from "react";
import { readCache, writeCache } from "./prefetchCache";

const DEFAULT_INTERVAL_MS = 30_000;

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  deps: ReadonlyArray<unknown> = [],
  /** When provided, the first render is served from the cache warmed on the
   *  landing page (no spinner); every successful fetch refreshes the cache. */
  cacheKey?: string,
) {
  const [data, setData] = useState<T | null>(() => (cacheKey ? readCache<T>(cacheKey) : null));
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(() => !(cacheKey && readCache<T>(cacheKey) !== null));
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  const seqRef = useRef(0);
  // In-flight lock: a new tick does NOT start a request while the previous one
  // is still pending (on a weak link where RTT > interval, this stops parallel
  // requests from stacking up).
  const inFlightRef = useRef(false);

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const run = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const mySeq = ++seqRef.current;
      try {
        const v = await fetcherRef.current();
        if (cancelled || mySeq !== seqRef.current) return;
        setData(v);
        if (cacheKey) writeCache(cacheKey, v);
        setError(null);
      } catch (e) {
        if (cancelled || mySeq !== seqRef.current) return;
        setError(e as Error);
      } finally {
        inFlightRef.current = false;
        if (!cancelled && mySeq === seqRef.current) setLoading(false);
      }
    };

    const start = () => {
      if (timer === null) timer = setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    // Don't poll while the tab is hidden (saves battery/data on cellular). On
    // returning, immediately fetch fresh data and restart the interval.
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        run();
        start();
      }
    };

    run();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      // Let the effect own the lock: don't rely on the finally of an
      // outstanding stale request (so the new effect's first run isn't skipped
      // because of the old promise).
      inFlightRef.current = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
