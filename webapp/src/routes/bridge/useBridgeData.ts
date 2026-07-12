/** Data + derivation logic for the bridge screen - independent of theme variants.
 *  The marine / pastel / ios variants consume this hook; only the presentation differs. */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Snapshot, BaroTrend, HealthResult } from "../../lib/api";
import { usePolling } from "../../lib/usePolling";
import { depthDiagnosis, type DepthDiag } from "../../lib/depthDiag";
import { useNow } from "../../lib/useNow";
import {
  msToKnots,
  radToDeg,
  kToC,
  paToHPa,
  knotToBeaufort,
  sogKnFiltered,
} from "../../lib/format";

const POLL_FAST = 2_000;
const POLL_SLOW = 60_000;

export type GustHours = 1 | 6 | 12 | 24;

export interface BridgeData {
  snap: Snapshot | null;
  now: number;
  ageSec: number | null;
  live: boolean;
  hdgTrue: number | null;
  sogKn: number | null;
  cogDeg: number | null;
  twsKn: number | null;
  twdDeg: number | null;
  awaDeg: number | null;
  bft: number | null;
  baroHPa: number | null;
  baroDelta: number | null;
  airC: number | null;
  depth: number | null;
  /** Micro-diagnosis for why depth shows "·" (no sensor / gone silent). */
  depthDiag: DepthDiag;
  navState: string;
  utcClock: string;
  gustMax: { kn: number; ts: number } | null;
  gustHours: GustHours;
  setGustHours: (h: GustHours) => void;
  /** Sparkline series (derived from already-fetched data - for presentation). */
  gustSeries: number[];
  baroSeries: number[];
}

/** Downsamples an array to at most `target` points at even intervals. */
function downsample(arr: number[], target: number): number[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const out: number[] = [];
  for (let i = 0; i < target; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

export function useBridgeData(): BridgeData {
  const { data: snap } = usePolling<Snapshot>(api.live, POLL_FAST, [], "bridge:live");
  const { data: baro } = usePolling<BaroTrend>(() => api.tools.baroTrend(3), POLL_SLOW, [], "bridge:baro");
  const { data: health } = usePolling<HealthResult>(api.health, POLL_SLOW, [], "bridge:health");

  // 1s UTC clock tick - useNow pauses while the tab is hidden (visibility-aware).
  const now = useNow(1000);

  // === Gust history (max TWS over selected window) ===
  const [gustHours, setGustHours] = useState<GustHours>(6);
  const [gustMax, setGustMax] = useState<{ kn: number; ts: number } | null>(null);
  const [gustSeries, setGustSeries] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    const fetchGust = async () => {
      try {
        const from = Date.now() - gustHours * 3600_000;
        const rows = await api.logbook.snapshots({ from, limit: 5000, order: "asc" });
        let m: { kn: number; ts: number } | null = null;
        const series: number[] = [];
        for (const r of rows) {
          // Use the per-minute peak (wind_gust) when present; fall back to the
          // instantaneous wind_speed_true on older rows where it is NULL (backward compatible).
          const kn = msToKnots(r.wind_gust ?? r.wind_speed_true);
          if (kn !== null) {
            series.push(kn);
            if (m === null || kn > m.kn) m = { kn, ts: r.ts };
          }
        }
        if (!cancelled) {
          setGustMax(m);
          setGustSeries(downsample(series, 28));
        }
      } catch {
        /* keep stale */
      }
    };
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (t === null) t = setInterval(fetchGust, 5 * 60_000);
    };
    const stop = () => {
      if (t !== null) {
        clearInterval(t);
        t = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        fetchGust();
        start();
      }
    };
    fetchGust();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [gustHours]);

  const ageSec = snap?.ts ? Math.max(0, Math.round((now - snap.ts) / 1000)) : null;
  const live = ageSec !== null && ageSec < 30;

  const hdgTrue = radToDeg(snap?.heading_true);
  const sogKn = sogKnFiltered(snap?.sog);
  const cogDeg = sogKn !== null ? radToDeg(snap?.cog) : null;

  const twsKn = msToKnots(snap?.wind_speed_true);
  const twdDeg = radToDeg(snap?.wind_direction_true);
  const awaDeg = radToDeg(snap?.wind_angle_apparent);
  // Beaufort is computed ONLY from true wind. Falling back to apparent (the old
  // `twsKn ?? awsKn`) inflates BFT by 1-2 levels when heading into the wind
  // (AWS = TWS + boat-speed component). When TWS is missing the badge is hidden (null).
  const bft = knotToBeaufort(twsKn);

  // Live update: if current TWS exceeds stored max (and is in window), bump.
  // Deliberate setState-in-effect: we compare the new TWS from the external
  // poll against the gust window and bump state only when it exceeds the max -
  // not cascading, guarded to be idempotent.
  useEffect(() => {
    if (twsKn === null || !snap?.ts) return;
    const windowStart = Date.now() - gustHours * 3600_000;
    if (snap.ts < windowStart) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGustMax((prev) => (!prev || twsKn > prev.kn ? { kn: twsKn, ts: snap.ts } : prev));
  }, [twsKn, snap?.ts, gustHours]);

  const baroHPa = paToHPa(snap?.air_pressure_pa) ?? baro?.current_hpa ?? null;
  const baroDelta = baro?.delta_3h_hpa ?? null;
  // Baro sparkline series: baroTrend.series (hPa). If Pa comes through (>2000), convert to hPa.
  const baroSeries = downsample(
    (baro?.series ?? [])
      .map((p) => p.value)
      .filter((v): v is number => v !== null)
      .map((v) => (v > 2000 ? v / 100 : v)),
    28,
  );
  const airC = kToC(snap?.air_temp_k);
  const depth = snap?.depth ?? null;
  const depthDiag = depthDiagnosis(depth, health?.paths);

  const navState = snap?.nav_state?.toUpperCase() || "·";

  // Clip the gust max to the window at render time: live-bump only RAISES it,
  // so it can show a peak that has aged out of the window until the 5-min fetchGust prune.
  // Re-evaluated every second via now (useNow 1s).
  const displayGust =
    gustMax && now - gustMax.ts <= gustHours * 3600_000 ? gustMax : null;

  const utcClock = (() => {
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  })();

  return {
    snap: snap ?? null,
    now,
    ageSec,
    live,
    hdgTrue,
    sogKn,
    cogDeg,
    twsKn,
    twdDeg,
    awaDeg,
    bft,
    baroHPa,
    baroDelta,
    airC,
    depth,
    depthDiag,
    navState,
    utcClock,
    gustMax: displayGust,
    gustHours,
    setGustHours,
    gustSeries,
    baroSeries,
  };
}
