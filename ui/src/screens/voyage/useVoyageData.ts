/** Data logic for the Voyage screen - automatically detected voyages.
 *  `current` is polled every 60s (metrics stream live during an ongoing voyage);
 *  stats + list are fetched once on mount (avoid aggressive polling, since the
 *  backend reconciles the full history on every call). The track is fetched
 *  on-demand when a voyage is expanded. */
import { useEffect, useState } from "react";
import { useApi, ApiError } from "../../data/api";
import type { Voyage, VoyageStatsCards } from "../../data/api";
import { usePolling } from "../../data/usePolling";
import { cacheTimestamp } from "../../data/prefetchCache";

export type StatWindow = "today" | "yesterday" | "rolling_7d" | "season";

const LOAD_FAILED = "Could not load voyage data";

/** What a failed load puts on the banner.
 *
 * The raw Error message used to go there, which showed an owner "500: Internal Server Error"
 * and, when the boat's wi-fi dropped mid-request, whatever the browser calls a timeout that
 * day. Same rule as the fuel sheet: her server's own sentence is worth showing, the status
 * code it is prefixed with is not, and anything that is neither gets this screen's words
 * rather than the runtime's.
 */
export function voyageLoadError(e: unknown): string {
  if (e instanceof ApiError) return e.detail || LOAD_FAILED;
  // AbortSignal.timeout, which the API layer puts on every request.
  if (e instanceof DOMException && e.name === "TimeoutError") return "She did not answer in time";
  return LOAD_FAILED;
}

export interface VoyageData {
  current: Voyage | null;
  /** The poll behind `current` is failing, so `current` is the last answer, not the present:
   *  usePolling keeps data on error, which is right for a blip and a lie for a lamp. A pulse
   *  drawn from `current` alone kept beating after the link died. */
  currentStale: boolean;
  /** When `current` was last actually heard, for saying how old the stale answer is. */
  currentSeenTs: number | null;
  stats: VoyageStatsCards | null;
  list: Voyage[];
  loading: boolean;
  err: string | null;
}

/** `reloadKey` re-fetches stats + list when it changes: after a fuel-path change
 *  the plugin restarts and re-integrates every voyage, so the figures move. */
export function useVoyageData(reloadKey = 0): VoyageData {
  const api = useApi();
  const { data: current, error: currentErr } = usePolling<Voyage | null>(
    api.voyage.current,
    60_000,
    [reloadKey],
    "voyage:current",
  );

  const [stats, setStats] = useState<VoyageStatsCards | null>(null);
  const [list, setList] = useState<Voyage[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, l] = await Promise.all([api.voyage.stats(), api.voyage.list(50)]);
        if (!cancelled) {
          setStats(s);
          setList(l);
          // Clear a stale error from a prior reload: without this, a failed fetch
          // during the restart window would leave the banner up over good data,
          // since only reloadKey re-runs this effect (not the 60s current poll).
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(voyageLoadError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return {
    current: current ?? null,
    currentStale: currentErr !== null,
    currentSeenTs: cacheTimestamp("voyage:current"),
    stats,
    list,
    loading,
    err,
  };
}
