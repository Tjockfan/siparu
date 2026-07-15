/**
 * Snapshot queries behind GET /snapshots (and, in Phase 2, the history RPC).
 *
 * bucket=1   -> raw NDJSON, clamped to today (UTC). Never scans history.
 * bucket=60  -> hourly rollup lines, one row per hour (last values).
 * bucket=360 -> hourly rollups grouped into 6h windows, latest hour wins.
 * bucket=1440-> daily rollup lines, one row per day (last values).
 *
 * Bucketed rows carry the latest values seen in each bucket, so charts
 * read the same regardless of bucket size.
 */
import {
  MetricAgg,
  MetricField,
  PathSeriesPoint,
  PathSeriesResult,
  RollupDay,
  RollupHour,
  Snapshot,
  SnapshotsQuery,
  SnapshotsResult,
} from './contract'
import { RollupEngine } from './rollup'
import { Store } from './store'
import { dayKey, startOfUtcDay } from './time'

const ALL_FIELDS: readonly MetricField[] = [
  'lat',
  'lon',
  'sog',
  'cog',
  'heading_mag',
  'heading_true',
  'rate_of_turn',
  'magnetic_variation',
  'magnetic_deviation',
  'nav_state',
  'wind_speed_apparent',
  'wind_angle_apparent',
  'wind_speed_true',
  'wind_gust',
  'wind_direction_true',
  'air_temp_k',
  'air_pressure_pa',
  'depth',
  'water_temp_k',
  'gps_satellites',
  'ais_class'
]

export const LIMIT_DEFAULT = 200
export const LIMIT_MAX = 5000

/**
 * A rollup aggregate as a graph point, or nothing if this bucket did not carry the
 * path (so flatMap drops it). A gauge added mid-history is simply absent from earlier
 * buckets rather than a fabricated zero.
 */
function aggToPoint(ts: number, agg: MetricAgg | undefined): PathSeriesPoint[] {
  if (
    !agg ||
    typeof agg.min !== 'number' ||
    typeof agg.max !== 'number' ||
    typeof agg.avg !== 'number' ||
    typeof agg.last !== 'number'
  ) {
    return []
  }
  return [{ ts, min: agg.min, max: agg.max, avg: agg.avg, last: agg.last }]
}

function rollupToRow(r: RollupHour | RollupDay): Snapshot {
  const row = { ts: r.last_ts } as Snapshot
  for (const field of ALL_FIELDS) {
    ;(row as unknown as Record<string, unknown>)[field] = r.metrics[field]?.last ?? null
  }
  row.lat = r.pos_last?.lat ?? null
  row.lon = r.pos_last?.lon ?? null
  return row
}

export class QueryService {
  constructor(
    private store: Store,
    private rollups: RollupEngine
  ) {}

  async snapshots(q: SnapshotsQuery, now: number): Promise<SnapshotsResult> {
    const limit = Math.min(Math.max(1, q.limit ?? LIMIT_DEFAULT), LIMIT_MAX)
    const offset = Math.max(0, q.offset ?? 0)
    const order = q.order ?? 'desc'
    const to = q.to ?? now
    let clamped = false

    let rows: Snapshot[]
    if (q.bucket === 1) {
      // Raw is today-only by design; clamp and flag it.
      const todayStart = startOfUtcDay(now)
      const from = Math.max(q.from ?? todayStart, todayStart)
      if ((q.from ?? todayStart) < todayStart || to < todayStart) clamped = true
      rows = await this.readRawToday(now, from, to)
    } else if (q.bucket === 60) {
      const from = q.from ?? 0
      rows = (await this.rollups.readHourly(from, to)).map(rollupToRow)
    } else if (q.bucket === 360) {
      const from = q.from ?? 0
      const hours = await this.rollups.readHourly(from, to)
      const byWindow = new Map<number, RollupHour>()
      for (const h of hours) {
        const win = Math.floor(h.last_ts / (6 * 3_600_000))
        byWindow.set(win, h) // hours arrive ascending; the latest wins
      }
      rows = [...byWindow.values()].map(rollupToRow)
    } else if (q.bucket === 1440) {
      const from = q.from ?? 0
      rows = (await this.rollups.readDaily(from, to)).map(rollupToRow)
    } else {
      throw new QueryError('BAD_BUCKET', 'bucket must be one of 1, 60, 360, 1440')
    }

    rows = rows.filter((r) => r.ts >= (q.bucket === 1 ? 0 : (q.from ?? 0)) && r.ts <= to)
    rows.sort((a, b) => (order === 'asc' ? a.ts - b.ts : b.ts - a.ts))
    const total = rows.length
    rows = rows.slice(offset, offset + limit)
    if (offset + rows.length < total) clamped = true
    return { rows, clamped }
  }

  /**
   * One dynamic gauge's history, shaped for a graph. Same bucketing as snapshots():
   * bucket=1 reads raw (today only, clamped), the rest read rollups. A raw sample
   * becomes a point with min = max = avg = last; a rollup carries its real aggregate,
   * so a chart can draw a band. A path a rollup does not carry simply yields no point.
   */
  async pathSeries(pathName: string, q: SnapshotsQuery, now: number): Promise<PathSeriesResult> {
    const limit = Math.min(Math.max(1, q.limit ?? LIMIT_DEFAULT), LIMIT_MAX)
    const offset = Math.max(0, q.offset ?? 0)
    const order = q.order ?? 'desc'
    const to = q.to ?? now
    let clamped = false

    let points: PathSeriesPoint[]
    if (q.bucket === 1) {
      const todayStart = startOfUtcDay(now)
      const from = Math.max(q.from ?? todayStart, todayStart)
      if ((q.from ?? todayStart) < todayStart || to < todayStart) clamped = true
      points = []
      for (const r of await this.readRawToday(now, from, to)) {
        const v = r.path_values?.[pathName]
        if (typeof v === 'number') points.push({ ts: r.ts, min: v, max: v, avg: v, last: v })
      }
    } else if (q.bucket === 60) {
      const from = q.from ?? 0
      points = (await this.rollups.readHourly(from, to)).flatMap((h) =>
        aggToPoint(h.last_ts, h.path_metrics?.[pathName])
      )
    } else if (q.bucket === 360) {
      const from = q.from ?? 0
      const byWindow = new Map<number, RollupHour>()
      for (const h of await this.rollups.readHourly(from, to)) {
        byWindow.set(Math.floor(h.last_ts / (6 * 3_600_000)), h) // hours ascending; latest wins
      }
      points = [...byWindow.values()].flatMap((h) => aggToPoint(h.last_ts, h.path_metrics?.[pathName]))
    } else if (q.bucket === 1440) {
      const from = q.from ?? 0
      points = (await this.rollups.readDaily(from, to)).flatMap((d) =>
        aggToPoint(d.last_ts, d.path_metrics?.[pathName])
      )
    } else {
      throw new QueryError('BAD_BUCKET', 'bucket must be one of 1, 60, 360, 1440')
    }

    points = points.filter((p) => p.ts >= (q.bucket === 1 ? 0 : q.from ?? 0) && p.ts <= to)
    points.sort((a, b) => (order === 'asc' ? a.ts - b.ts : b.ts - a.ts))
    const total = points.length
    points = points.slice(offset, offset + limit)
    if (offset + points.length < total) clamped = true
    return { path: pathName, points, clamped }
  }

  private async readRawToday(now: number, fromTs: number, toTs: number): Promise<Snapshot[]> {
    const today = dayKey(now)
    const keys = (await this.store.listRawKeys()).filter((k) => k.startsWith(today))
    const out: Snapshot[] = []
    for (const key of keys) {
      for (const row of await this.store.readRaw(key)) {
        if (row.ts >= fromTs && row.ts <= toTs) out.push(row)
      }
    }
    return out
  }

  /** Rows recorded today (UTC) - used by /health. */
  async countToday(now: number): Promise<number> {
    const today = dayKey(now)
    const keys = (await this.store.listRawKeys()).filter((k) => k.startsWith(today))
    let n = 0
    for (const key of keys) n += (await this.store.readRaw(key)).length
    return n
  }
}

export class QueryError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}
