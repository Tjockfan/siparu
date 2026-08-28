/*
 * Merging aggregates, with nothing underneath it.
 *
 * An hour rollup is a summary of sixty raw rows; a day rollup is a summary of twenty-four of
 * those; and a six-hour window somebody asked for in an export is a summary of six. All three
 * are the same arithmetic, and it is arithmetic with one trap in it: the mean of a wider bucket
 * is the mean of its parts WEIGHTED BY THE SAMPLES BEHIND EACH. Averaging two averages is
 * correct only when both hours held the same number of readings, which is exactly what an hour
 * with a gap in it does not.
 *
 * This module exists because that arithmetic had two copies in rollup.ts already, and a third
 * was about to be written ashore for the export. It knows nothing about files, config or the
 * server: give it buckets, get a bucket.
 */
import { MetricAgg, MetricField, RollupHour, metricFields } from './contract'

const EARTH_RADIUS_NM = 3440.065

/**
 * The speed above which a leg between two fixes is a glitch rather than a passage.
 *
 * Declared here rather than in config.ts because this is the module that uses it and the one
 * the webapp can import: config.ts reads process.env, which is nothing a browser has. The
 * plugin's INTERNAL table takes its value from here, so there is still one number.
 */
export const SPEED_GUARD_KN = 80

/** A linear aggregate, which is the only kind that can be merged: min, max, mean and count. */
export interface NumAgg extends MetricAgg {
  min: number
  max: number
  avg: number
  n: number
}

const LINEAR_FIELDS: readonly MetricField[] = metricFields('linear')
const LAST_ONLY_FIELDS: readonly MetricField[] = metricFields('angular', 'text')

export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Merge already-aggregated linear buckets into one. Null when none of them carried a number. */
export function mergeAggs(aggs: readonly MetricAgg[]): NumAgg | null {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let n = 0
  let last: number | string | null = null
  for (const m of aggs) {
    if (typeof m.min !== 'number' || typeof m.max !== 'number' || typeof m.avg !== 'number') continue
    const mn = m.n ?? 1
    if (m.min < min) min = m.min
    if (m.max > max) max = m.max
    sum += m.avg * mn
    n += mn
    if (m.last !== null && m.last !== undefined) last = m.last
  }
  return n > 0 ? { min, max, avg: sum / n, n, last } : null
}

/** What a set of hours comes to. The name and the calendar are the caller's business. */
export interface WindowAgg {
  count: number
  first_ts: number
  last_ts: number
  distance_nm: number
  pos_first: { lat: number; lon: number } | null
  pos_last: { lat: number; lon: number } | null
  metrics: Partial<Record<MetricField, MetricAgg>>
  path_metrics?: Record<string, MetricAgg>
}

/**
 * A set of closed hours as one bucket.
 *
 * The distance is not simply the sum: an hour rollup measures only the fixes inside its own
 * hour, so the leg between one hour's last fix and the next hour's first fix belongs to no
 * hour and would vanish from every wider total. It is added here, behind the same speed guard
 * the raw track uses - a boat that appears to have crossed a sea between two fixes did not.
 */
export function mergeHours(hours: readonly RollupHour[], guardKn: number = SPEED_GUARD_KN): WindowAgg {
  const sorted = [...hours].sort((a, b) => a.hour.localeCompare(b.hour))
  const metrics: Partial<Record<MetricField, MetricAgg>> = {}

  for (const field of LINEAR_FIELDS) {
    const agg = mergeAggs(
      sorted.map((h) => h.metrics[field]).filter((m): m is MetricAgg => m !== undefined)
    )
    if (agg) metrics[field] = agg
  }
  // Angular and text readings have no mean - a heading of 350 and one of 010 do not average to
  // 180 - so the newest one stands for the window.
  for (const field of LAST_ONLY_FIELDS) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const m = sorted[i]?.metrics[field]
      if (m && m.last !== null && m.last !== undefined) {
        metrics[field] = { last: m.last }
        break
      }
    }
  }

  const path_metrics: Record<string, MetricAgg> = {}
  const keys = new Set<string>()
  for (const h of sorted) if (h.path_metrics) for (const k of Object.keys(h.path_metrics)) keys.add(k)
  for (const key of keys) {
    const agg = mergeAggs(
      sorted.map((h) => h.path_metrics?.[key]).filter((m): m is MetricAgg => m !== undefined)
    )
    if (agg) path_metrics[key] = agg
  }

  let distance = sorted.reduce((acc, h) => acc + h.distance_nm, 0)
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a?.pos_last || !b?.pos_first) continue
    const dtH = (b.first_ts - a.last_ts) / 3_600_000
    if (dtH <= 0) continue
    const segNm = haversineNm(a.pos_last.lat, a.pos_last.lon, b.pos_first.lat, b.pos_first.lon)
    if (segNm / dtH <= guardKn) distance += segNm
  }

  return {
    count: sorted.reduce((acc, h) => acc + h.count, 0),
    first_ts: sorted[0]?.first_ts ?? 0,
    last_ts: sorted[sorted.length - 1]?.last_ts ?? 0,
    distance_nm: distance,
    pos_first: sorted.map((h) => h.pos_first).find((p) => p !== null) ?? null,
    pos_last:
      [...sorted]
        .reverse()
        .map((h) => h.pos_last)
        .find((p) => p !== null) ?? null,
    metrics,
    ...(Object.keys(path_metrics).length > 0 ? { path_metrics } : {})
  }
}
