import { useEffect, useRef, useState } from "react";
import { readCache, writeCache } from "./prefetchCache";

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * How soon a failed read is tried again, when the interval is longer than this.
 *
 * A slow poller - the clock asks for the boat's position once a minute - used to wait out its
 * whole interval after one refusal. Ashore the first read is refused as a rule: the screens
 * mount before her socket has opened and her first frame is a few seconds behind, so a poll
 * that failed at mount and came back a minute later left the clock on UTC for that minute.
 * Aboard the same thing follows a dropped request on a poor wi-fi. The retry is one-off and
 * never faster than the interval itself, so a fast poller is unchanged.
 */
const RETRY_MS = 5_000;

export interface PollSink<T> {
  value(v: T): void;
  error(e: Error): void;
  /** After every attempt, success or not, once it is known to be this poller's own. */
  settled(): void;
}

/**
 * The polling itself, apart from the hook so it can be run and clocked without React: an
 * immediate read, then one every interval while the tab is visible, with a single early retry
 * after a refusal. Returns the function that stops it. A read still in flight when a tick
 * comes round is left alone rather than joined by a second one - on a weak link where the
 * round trip outlasts the interval, that is what keeps requests from stacking up.
 */
export function startPolling<T>(fetcher: () => Promise<T>, intervalMs: number, sink: PollSink<T>): () => void {
  let cancelled = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const v = await fetcher();
      if (cancelled) return;
      sink.value(v);
    } catch (e) {
      if (cancelled) return;
      sink.error(e as Error);
      if (intervalMs > RETRY_MS && retry === null && !document.hidden) {
        retry = setTimeout(() => {
          retry = null;
          if (!cancelled) void run();
        }, RETRY_MS);
      }
    } finally {
      inFlight = false;
      if (!cancelled) sink.settled();
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
      void run();
      start();
    }
  };

  void run();
  if (!document.hidden) start();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    cancelled = true;
    stop();
    if (retry !== null) clearTimeout(retry);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

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

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    // The stop function owns the cancellation: a read still outstanding from a previous
    // effect can neither write state nor block the new effect's first run.
    return startPolling(() => fetcherRef.current(), intervalMs, {
      value: (v) => {
        setData(v);
        if (cacheKey) writeCache(cacheKey, v);
        setError(null);
      },
      error: (e) => setError(e),
      settled: () => setLoading(false),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}
