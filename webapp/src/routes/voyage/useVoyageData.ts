/** Data logic for the Voyage screen - automatically detected voyages.
 *  `current` is polled every 60s (metrics stream live during an ongoing voyage);
 *  stats + list are fetched once on mount (avoid aggressive polling, since the
 *  backend reconciles the full history on every call). The track is fetched
 *  on-demand when a voyage is expanded. */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Voyage, VoyageStatsCards } from "../../lib/api";
import { usePolling } from "../../lib/usePolling";

export type StatWindow = "today" | "yesterday" | "rolling_7d" | "season";

export interface VoyageData {
  current: Voyage | null;
  stats: VoyageStatsCards | null;
  list: Voyage[];
  loading: boolean;
  err: string | null;
}

/** `reloadKey` re-fetches stats + list when it changes: after a fuel-path change
 *  the plugin restarts and re-integrates every voyage, so the figures move. */
export function useVoyageData(reloadKey = 0): VoyageData {
  const { data: current } = usePolling<Voyage | null>(
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
        if (!cancelled) setErr(e instanceof Error ? e.message : "Could not load voyage data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return { current: current ?? null, stats, list, loading, err };
}
