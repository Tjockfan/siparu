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

export function useVoyageData(): VoyageData {
  const { data: current } = usePolling<Voyage | null>(
    api.voyage.current,
    60_000,
    [],
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
  }, []);

  return { current: current ?? null, stats, list, loading, err };
}
