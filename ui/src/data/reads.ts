/**
 * The reads every screen shares, built over the two the boat actually answers.
 *
 * A screen asks for rows over a window, and the boat serves two kinds: raw minutes, for today
 * and however many hours of raw she still keeps, and hourly summaries for everything before.
 * Splitting a window across the two is the same arithmetic from either end of the wire - the
 * dashboard aboard reads `/snapshots` and `/rollups/hourly`, the portal ashore puts the same
 * two questions over the socket - so it is written once here and each app hands in only the
 * two primitives. The barometer's trend is derived from the same rows and lives here for the
 * same reason.
 */
import type {
  BaroTrend,
  MinutesResult,
  RollupHour,
  Snapshot,
  SnapshotsQuery,
  SnapshotsResult,
  TimeSeriesPoint,
} from "./api";

/** What the boat answers directly; everything below is arranged from these two. */
export interface RawReads {
  snapshots(q: SnapshotsQuery & { bucket: number }): Promise<SnapshotsResult>;
  rollupHours(from: number, to: number): Promise<RollupHour[]>;
}

export function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const num = (v: number | string | null | undefined): number | null =>
  typeof v === "number" ? v : null;
const str = (v: number | string | null | undefined): string | null =>
  typeof v === "string" ? v : null;

/** One snapshot-shaped row per rollup hour; gust carries the hour's peak. */
export function rollupToSnapshot(h: RollupHour): Snapshot {
  const m = h.metrics;
  return {
    ts: h.last_ts,
    lat: h.pos_last?.lat ?? null,
    lon: h.pos_last?.lon ?? null,
    sog: num(m.sog?.last),
    cog: num(m.cog?.last),
    heading_mag: num(m.heading_mag?.last),
    heading_true: num(m.heading_true?.last),
    rate_of_turn: num(m.rate_of_turn?.last),
    magnetic_variation: num(m.magnetic_variation?.last),
    magnetic_deviation: num(m.magnetic_deviation?.last),
    nav_state: str(m.nav_state?.last),
    wind_speed_apparent: num(m.wind_speed_apparent?.last),
    wind_angle_apparent: num(m.wind_angle_apparent?.last),
    wind_speed_true: num(m.wind_speed_true?.last),
    wind_gust: m.wind_gust?.max ?? num(m.wind_speed_true?.max) ?? null,
    wind_direction_true: num(m.wind_direction_true?.last),
    air_temp_k: num(m.air_temp_k?.last),
    air_pressure_pa: num(m.air_pressure_pa?.last),
    depth: num(m.depth?.last),
    water_temp_k: num(m.water_temp_k?.last),
    gps_satellites: num(m.gps_satellites?.last),
    ais_class: str(m.ais_class?.last),
  };
}

const hpa = (pa: number | null): number | null => (pa === null ? null : Math.round((pa / 100) * 10) / 10);

/** The shared reads, arranged over a boat's two primitives. */
export function sharedReads(raw: RawReads) {
  const fetchSnapshots = async (q: SnapshotsQuery & { bucket: number }): Promise<Snapshot[]> =>
    (await raw.snapshots(q)).rows;

  /**
   * Minute rows with transparent history split: today comes raw, anything
   * before today comes from hourly rollups as one row per hour.
   */
  async function snapshots(q: SnapshotsQuery = {}): Promise<Snapshot[]> {
    const bucket = q.bucket ?? 1;
    if (bucket !== 1) return fetchSnapshots({ ...q, bucket });

    const now = Date.now();
    const to = q.to ?? now;
    const from = q.from ?? startOfUtcDay(now);
    const todayStart = startOfUtcDay(now);

    const parts: Promise<Snapshot[]>[] = [];
    if (from < todayStart) {
      parts.push(raw.rollupHours(from, Math.min(to, todayStart - 1)).then((hs) => hs.map(rollupToSnapshot)));
    }
    if (to >= todayStart) {
      parts.push(
        fetchSnapshots({ from: Math.max(from, todayStart), to, bucket: 1, limit: q.limit ?? 5000, order: "asc" }),
      );
    }
    let rows = (await Promise.all(parts)).flat();
    rows = rows.filter((r) => r.ts >= from && r.ts <= to);
    rows.sort((a, b) => (q.order === "desc" ? b.ts - a.ts : a.ts - b.ts));
    if (q.offset) rows = rows.slice(q.offset);
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);
    return rows;
  }

  /**
   * The boat's minutes over a window, with the hourly rollup filling whatever lies before them.
   *
   * This is the deep read, and it is deliberately not what `snapshots` does. A minute row
   * costs a few kilobytes and a boat reporting engines and tanks sends thousands of them for a
   * day; a screen that wants a track or a barometer wants rows, not minutes, and pays for the
   * summaries instead. Only a reader who asked for "every minute" comes through here.
   *
   * Where the minutes stop is the boat's answer, not a calendar's: she keeps a window of raw
   * hours, shortened by whatever her disk actually still holds, and says where it begins. So
   * the request goes out for the whole window and the fill is decided by what came back - one
   * extra round trip, on the one screen that asked for it.
   */
  async function minutes(q: SnapshotsQuery = {}): Promise<MinutesResult> {
    const now = Date.now();
    const to = q.to ?? now;
    const order = q.order ?? "desc";
    const res = await raw.snapshots({ from: q.from, to, bucket: 1, limit: q.limit ?? 5000, order });
    const floor = res.minutesFrom ?? startOfUtcDay(now);
    const from = q.from ?? floor;

    let rows = res.rows;
    if (from < floor) {
      const hours = await raw.rollupHours(from, Math.min(to, floor - 1));
      rows = hours.map(rollupToSnapshot).concat(rows);
    }
    rows = rows.filter((r) => r.ts >= from && r.ts <= to);
    rows.sort((a, b) => (order === "desc" ? b.ts - a.ts : a.ts - b.ts));
    if (q.offset) rows = rows.slice(q.offset);
    if (q.limit !== undefined) rows = rows.slice(0, q.limit);
    return { rows, minutesFrom: floor };
  }

  async function baroTrend(hours = 24): Promise<BaroTrend> {
    const now = Date.now();
    const rows = await snapshots({ from: now - hours * 3600_000, to: now, order: "asc", limit: 5000 });
    const series: TimeSeriesPoint[] = rows.map((r) => ({ ts: r.ts, value: hpa(r.air_pressure_pa) }));

    let current: number | null = null;
    for (let i = series.length - 1; i >= 0; i--) {
      const v = series[i]!.value;
      if (v !== null) {
        current = v;
        break;
      }
    }

    // 3h delta: the non-null point closest to now-3h (within a 30 min window).
    let delta: number | null = null;
    if (current !== null) {
      const target = now - 3 * 3600_000;
      let bestDt: number | null = null;
      let bestV: number | null = null;
      for (const p of series) {
        if (p.value === null || Math.abs(p.ts - target) > 30 * 60_000) continue;
        const dt = Math.abs(p.ts - target);
        if (bestDt === null || dt < bestDt) {
          bestDt = dt;
          bestV = p.value;
        }
      }
      if (bestV !== null) delta = Math.round((current - bestV) * 10) / 10;
    }

    return {
      current_hpa: current,
      delta_3h_hpa: delta,
      gale_flag: delta !== null && delta <= -3.0, // falling 3 hPa or more over 3h
      series,
    };
  }

  async function baroSeries(q: { from: number; to: number; points?: number }): Promise<{ ts: number; hpa: number }[]> {
    const rows = await snapshots({ from: q.from, to: q.to, order: "asc", limit: 5000 });
    let series = rows
      .map((r) => ({ ts: r.ts, hpa: hpa(r.air_pressure_pa) }))
      .filter((p): p is { ts: number; hpa: number } => p.hpa !== null);
    const points = q.points ?? 160;
    if (series.length > points) {
      const step = (series.length - 1) / (points - 1);
      series = Array.from({ length: points }, (_, i) => series[Math.round(i * step)]!);
    }
    return series;
  }

  return { snapshots, minutes, baroTrend, baroSeries };
}
