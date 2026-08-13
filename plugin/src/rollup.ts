/**
 * Materialized rollups: when a raw hour file closes, an hourly summary line
 * is appended to <dataDir>/rollup/hourly-YYYY-MM.ndjson; when a UTC day
 * completes, a daily line goes to daily-YYYY.ndjson.
 *
 * Design rule (product plan §3-2): history queries ALWAYS read rollups;
 * raw NDJSON is only touched for "today". On a 1 GB Cerbo GX scanning
 * months of raw files is not an option, and the Phase-2 remote history
 * RPC's response time is bounded by the same rule.
 *
 * Catch-up on startup makes this resilient to restarts: any closed raw
 * file without a rollup line gets one, then completed days are filled in.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { MetricAgg, MetricField, RollupDay, RollupHour, Snapshot } from './contract'
import { INTERNAL } from './config'
import { Logger, Store, parseNdjson } from './store'
import { dayKey, dayOfHourKey, monthOfHourKey } from './time'

/** Linear numeric fields get min/max/avg/n; angular & string fields keep last only. */
const LINEAR_FIELDS: readonly MetricField[] = [
  'sog',
  'wind_speed_apparent',
  'wind_speed_true',
  'wind_gust',
  'air_temp_k',
  'air_pressure_pa',
  'depth',
  'water_temp_k',
  'gps_satellites',
  'rate_of_turn',
  'magnetic_variation',
  'magnetic_deviation'
]
const LAST_ONLY_FIELDS: readonly MetricField[] = [
  'cog',
  'heading_mag',
  'heading_true',
  'wind_angle_apparent',
  'wind_direction_true',
  'nav_state',
  'ais_class'
]

/**
 * Clamp a query window to [epoch, now]. No data exists before 1970 or in the
 * future, so this narrows nothing legitimate - but it stops a hostile
 * `?to=8640000000000000` from walking millions of month/year buckets and
 * freezing the single Node event loop the whole Signal K server shares.
 * Applied at the read sink so every caller (REST, voyage replay) is covered.
 */
export function clampRange(fromTs: number, toTs: number): [number, number] {
  return [Math.max(fromTs, 0), Math.min(toTs, Date.now())]
}

const EARTH_RADIUS_NM = 3440.065

export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Track distance with a glitch guard: segments implying > guard speed are skipped. */
export function trackDistanceNm(rows: Snapshot[]): number {
  const guardKn = INTERNAL.rollupSpeedGuardKn
  let dist = 0
  let prev: Snapshot | null = null
  for (const row of rows) {
    if (row.lat === null || row.lon === null) continue
    if (prev) {
      const dtH = (row.ts - prev.ts) / 3_600_000
      if (dtH > 0) {
        const segNm = haversineNm(prev.lat as number, prev.lon as number, row.lat, row.lon)
        if (segNm / dtH <= guardKn) dist += segNm
      }
    }
    prev = row
  }
  return dist
}

interface NumAgg extends MetricAgg {
  min: number
  max: number
  avg: number
  n: number
}

function aggregateLinear(values: number[]): NumAgg | null {
  if (values.length === 0) return null
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  return { min, max, avg: sum / values.length, n: values.length, last: values[values.length - 1] ?? null }
}

/** Merge already-aggregated linear buckets (hour rollups) into one. */
function mergeLinearAggs(aggs: MetricAgg[]): NumAgg | null {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let n = 0
  let last: number | string | null = null
  for (const m of aggs) {
    if (typeof m.min !== 'number' || typeof m.max !== 'number' || typeof m.avg !== 'number') continue
    const mn = (m as NumAgg).n ?? 1
    if (m.min < min) min = m.min
    if (m.max > max) max = m.max
    sum += m.avg * mn
    n += mn
    if (m.last !== null && m.last !== undefined) last = m.last
  }
  return n > 0 ? { min, max, avg: sum / n, n, last } : null
}

/** Union of dynamic path names across a set of snapshots, in first-seen order. */
function pathKeysOf(rows: Snapshot[]): string[] {
  const keys = new Set<string>()
  for (const r of rows) if (r.path_values) for (const k of Object.keys(r.path_values)) keys.add(k)
  return [...keys]
}

export function buildHourRollup(hour: string, rows: Snapshot[]): RollupHour {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts)
  const metrics: Partial<Record<MetricField, MetricAgg>> = {}

  for (const field of LINEAR_FIELDS) {
    const values = sorted.map((r) => r[field]).filter((v): v is number => typeof v === 'number')
    const agg = aggregateLinear(values)
    if (agg) metrics[field] = agg
  }

  // Dynamic gauges: each SK path a boat exposed this hour, aggregated like a linear
  // metric. Absent (not empty) when the boat carries none, so a nav-only boat's rollup
  // line is unchanged.
  const path_metrics: Record<string, MetricAgg> = {}
  for (const key of pathKeysOf(sorted)) {
    const values = sorted
      .map((r) => r.path_values?.[key])
      .filter((v): v is number => typeof v === 'number')
    const agg = aggregateLinear(values)
    if (agg) path_metrics[key] = agg
  }
  for (const field of LAST_ONLY_FIELDS) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const v = sorted[i]?.[field]
      if (v !== null && v !== undefined) {
        metrics[field] = { last: v }
        break
      }
    }
  }

  const fixes = sorted.filter((r) => r.lat !== null && r.lon !== null)
  const first = fixes[0]
  const last = fixes[fixes.length - 1]
  return {
    hour,
    count: sorted.length,
    first_ts: sorted[0]?.ts ?? 0,
    last_ts: sorted[sorted.length - 1]?.ts ?? 0,
    distance_nm: trackDistanceNm(sorted),
    pos_first: first ? { lat: first.lat as number, lon: first.lon as number } : null,
    pos_last: last ? { lat: last.lat as number, lon: last.lon as number } : null,
    metrics,
    ...(Object.keys(path_metrics).length > 0 ? { path_metrics } : {})
  }
}

export function buildDayRollup(date: string, hours: RollupHour[]): RollupDay {
  const sorted = [...hours].sort((a, b) => a.hour.localeCompare(b.hour))
  const metrics: Partial<Record<MetricField, MetricAgg>> = {}

  for (const field of LINEAR_FIELDS) {
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let n = 0
    let last: number | string | null = null
    for (const h of sorted) {
      const m = h.metrics[field]
      if (!m || typeof m.min !== 'number' || typeof m.max !== 'number' || typeof m.avg !== 'number') continue
      const mn = (m as NumAgg).n ?? 1
      if (m.min < min) min = m.min
      if (m.max > max) max = m.max
      sum += m.avg * mn
      n += mn
      if (m.last !== null && m.last !== undefined) last = m.last
    }
    if (n > 0) metrics[field] = { min, max, avg: sum / n, n, last } as NumAgg
  }
  for (const field of LAST_ONLY_FIELDS) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const m = sorted[i]?.metrics[field]
      if (m && m.last !== null && m.last !== undefined) {
        metrics[field] = { last: m.last }
        break
      }
    }
  }

  // Dynamic gauges: merge each path's hourly aggregates into the day, weighting the
  // average by sample count, same as the linear fields above.
  const path_metrics: Record<string, MetricAgg> = {}
  const dayPathKeys = new Set<string>()
  for (const h of sorted) if (h.path_metrics) for (const k of Object.keys(h.path_metrics)) dayPathKeys.add(k)
  for (const key of dayPathKeys) {
    const agg = mergeLinearAggs(
      sorted.map((h) => h.path_metrics?.[key]).filter((m): m is MetricAgg => m !== undefined)
    )
    if (agg) path_metrics[key] = agg
  }

  const firstPos = sorted.map((h) => h.pos_first).find((p) => p !== null) ?? null
  const lastPos =
    [...sorted]
      .reverse()
      .map((h) => h.pos_last)
      .find((p) => p !== null) ?? null

  // Hour rollups only cover fixes inside their own hour; the leg between
  // one hour's last fix and the next hour's first fix would otherwise
  // silently vanish from the (permanent) daily distance.
  let distance = sorted.reduce((acc, h) => acc + h.distance_nm, 0)
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a?.pos_last || !b?.pos_first) continue
    const dtH = (b.first_ts - a.last_ts) / 3_600_000
    if (dtH <= 0) continue
    const segNm = haversineNm(a.pos_last.lat, a.pos_last.lon, b.pos_first.lat, b.pos_first.lon)
    if (segNm / dtH <= INTERNAL.rollupSpeedGuardKn) distance += segNm
  }

  return {
    date,
    count: sorted.reduce((acc, h) => acc + h.count, 0),
    first_ts: sorted[0]?.first_ts ?? 0,
    last_ts: sorted[sorted.length - 1]?.last_ts ?? 0,
    distance_nm: distance,
    pos_first: firstPos,
    pos_last: lastPos,
    metrics,
    ...(Object.keys(path_metrics).length > 0 ? { path_metrics } : {})
  }
}

export class RollupEngine {
  private hourKeysDone = new Set<string>()
  private dayKeysDone = new Set<string>()
  private initialized = false

  constructor(
    private store: Store,
    private log: Logger
  ) {}

  private hourlyPath(month: string): string {
    return path.join(this.store.rollupDir, `hourly-${month}.ndjson`)
  }

  private dailyPath(year: string): string {
    return path.join(this.store.rollupDir, `daily-${year}.ndjson`)
  }

  private async listRollupFiles(prefix: 'hourly-' | 'daily-'): Promise<string[]> {
    const names = await fs.readdir(this.store.rollupDir).catch(() => [] as string[])
    return names.filter((n) => n.startsWith(prefix) && n.endsWith('.ndjson')).sort()
  }

  /** Load existing rollup keys from disk (files are small; fine on Cerbo). */
  async init(): Promise<void> {
    for (const name of await this.listRollupFiles('hourly-')) {
      const text = await fs.readFile(path.join(this.store.rollupDir, name), 'utf8').catch(() => '')
      for (const line of parseNdjson<RollupHour>(text)) this.hourKeysDone.add(line.hour)
    }
    for (const name of await this.listRollupFiles('daily-')) {
      const text = await fs.readFile(path.join(this.store.rollupDir, name), 'utf8').catch(() => '')
      for (const line of parseNdjson<RollupDay>(text)) this.dayKeysDone.add(line.date)
    }
    this.initialized = true
  }

  /**
   * Materialize rollups for every closed raw hour that lacks one, then for
   * every completed UTC day. Idempotent; safe to call on startup and on
   * every hour close.
   */
  async catchUp(now: number): Promise<void> {
    if (!this.initialized) await this.init()
    const currentHour = new Date(now).toISOString().slice(0, 13)
    const today = dayKey(now)

    const rawKeys = await this.store.listRawKeys()
    const touchedDays = new Set<string>()
    for (const key of rawKeys) {
      if (key >= currentHour || this.hourKeysDone.has(key)) continue
      const rows = await this.store.readRaw(key)
      if (rows.length === 0) {
        this.hourKeysDone.add(key) // empty/corrupt file: don't retry forever
        continue
      }
      const rollup = buildHourRollup(key, rows)
      await fs.appendFile(this.hourlyPath(monthOfHourKey(key)), JSON.stringify(rollup) + '\n', 'utf8')
      this.hourKeysDone.add(key)
      touchedDays.add(dayOfHourKey(key))
    }

    // Daily rollups for fully completed days that have hourly lines.
    const candidateDays = new Set<string>(touchedDays)
    for (const hour of this.hourKeysDone) candidateDays.add(dayOfHourKey(hour))
    for (const date of [...candidateDays].sort()) {
      if (date >= today || this.dayKeysDone.has(date)) continue
      const hours = (await this.readHourlyMonth(date.slice(0, 7))).filter((h) => dayOfHourKey(h.hour) === date)
      if (hours.length === 0) continue
      const rollup = buildDayRollup(date, hours)
      await fs.appendFile(this.dailyPath(date.slice(0, 4)), JSON.stringify(rollup) + '\n', 'utf8')
      this.dayKeysDone.add(date)
    }
  }

  private async readHourlyMonth(month: string): Promise<RollupHour[]> {
    const text = await fs.readFile(this.hourlyPath(month), 'utf8').catch(() => '')
    // Dedupe by hour, last line wins: a torn line (power loss mid-append)
    // makes catchUp re-append that hour, and double-counting an hour in the
    // daily rollup would be a silent, permanent error.
    const byHour = new Map<string, RollupHour>()
    for (const h of parseNdjson<RollupHour>(text)) byHour.set(h.hour, h)
    return [...byHour.values()]
  }

  /** Hourly rollups intersecting [fromTs, toTs], ascending by hour. */
  async readHourly(fromTs: number, toTs: number): Promise<RollupHour[]> {
    ;[fromTs, toTs] = clampRange(fromTs, toTs)
    if (toTs < fromTs) return []
    const months = new Set<string>()
    for (let t = Date.UTC(new Date(fromTs).getUTCFullYear(), new Date(fromTs).getUTCMonth(), 1); t <= toTs; ) {
      const d = new Date(t)
      months.add(d.toISOString().slice(0, 7))
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    }
    const out: RollupHour[] = []
    for (const month of [...months].sort()) {
      for (const h of await this.readHourlyMonth(month)) {
        if (h.last_ts >= fromTs && h.first_ts <= toTs) out.push(h)
      }
    }
    return out.sort((a, b) => a.hour.localeCompare(b.hour))
  }

  /** Daily rollups intersecting [fromTs, toTs], ascending by date. */
  async readDaily(fromTs: number, toTs: number): Promise<RollupDay[]> {
    ;[fromTs, toTs] = clampRange(fromTs, toTs)
    if (toTs < fromTs) return []
    const years = new Set<string>()
    for (let y = new Date(fromTs).getUTCFullYear(); y <= new Date(toTs).getUTCFullYear(); y++) {
      years.add(String(y))
    }
    const byDate = new Map<string, RollupDay>()
    for (const year of [...years].sort()) {
      const text = await fs.readFile(this.dailyPath(year), 'utf8').catch(() => '')
      for (const d of parseNdjson<RollupDay>(text)) {
        if (d.last_ts >= fromTs && d.first_ts <= toTs) byDate.set(d.date, d)
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  }

  /** For /health. */
  async status(now: number): Promise<{ last_hour: string | null; hours_pending: number }> {
    const currentHour = new Date(now).toISOString().slice(0, 13)
    const rawKeys = await this.store.listRawKeys()
    const pending = rawKeys.filter((k) => k < currentHour && !this.hourKeysDone.has(k)).length
    const done = [...this.hourKeysDone].sort()
    return { last_hour: done[done.length - 1] ?? null, hours_pending: pending }
  }
}
