/** Tiny in-memory cache for card data warmed in the background on the landing page.
 *  Purpose: render data INSTANTLY on card entry instead of a spinner/skeleton (refreshed silently afterward).
 *  Module-level -> survives route changes, resets on a full reload. SWR-lite. */
type Entry = { value: unknown; ts: number };

const store = new Map<string, Entry>();

/** Read from the cache. Returns null if maxAge has elapsed (stale). */
export function readCache<T>(key: string, maxAgeMs = 60_000): T | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > maxAgeMs) return null;
  return e.value as T;
}

export function writeCache(key: string, value: unknown): void {
  store.set(key, { value, ts: Date.now() });
}

/** Timestamp of the last successful write (ms epoch). Null if never written.
 *  usePolling only writes on a SUCCESSFUL fetch -> "data freshness" signal
 *  (the SwissTopBar STALE badge is derived from this). */
export function cacheTimestamp(key: string): number | null {
  return store.get(key)?.ts ?? null;
}

/** Call on logout so the previous user's data does not linger in the cache. */
export function clearCache(): void {
  store.clear();
}
