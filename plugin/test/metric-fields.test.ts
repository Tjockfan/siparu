import { describe, expect, it } from 'vitest'
import { METRIC_KIND, metricFields, type MetricField, type Snapshot } from '../src/contract'
import { buildHourRollup } from '../src/rollup'

/**
 * One list of the core metrics, and the two places that used to keep their own copies.
 *
 * There were three hand-written lists: what the hour rollup averages, what it keeps the last
 * of, and what a rollup row turns back into a snapshot. A field added to the snapshot and to
 * one of them went into history and came back out of it silently wrong, or did not come back
 * at all - `depth_datum` was in the rollup and missing from the read, so an exported depth
 * from any hour older than today had lost the plane it was measured from. Nothing failed.
 *
 * Now the kinds are declared once beside the snapshot, `satisfies Record<MetricField, ...>`
 * makes the compiler refuse a field that is not classified, and these check that the
 * classification actually reaches the two behaviours it governs.
 */

/** A snapshot with a value in every field, so nothing can pass by being absent. */
function full(ts: number, n: number): Snapshot {
  return {
    ts,
    lat: 43.5 + n / 1000,
    lon: 7.02 + n / 1000,
    sog: 4 + n,
    cog: 1.1,
    heading_mag: 1.2,
    heading_true: 1.3,
    rate_of_turn: 0.01 * n,
    magnetic_variation: 0.05,
    magnetic_deviation: 0.01,
    nav_state: 'motoring',
    wind_speed_apparent: 8 + n,
    wind_angle_apparent: 0.7,
    wind_speed_true: 7 + n,
    wind_gust: 9 + n,
    wind_direction_true: 3.1,
    air_temp_k: 295 + n,
    air_pressure_pa: 101_300 + n,
    depth: 20 + n,
    depth_datum: 'belowTransducer',
    water_temp_k: 292 + n,
    gps_satellites: 9 + n,
    ais_class: 'A'
  }
}

describe('the core metric list', () => {
  it('classifies every field the snapshot carries', () => {
    // The compiler enforces this; the assertion is here so the count cannot quietly fall to
    // zero if the record is ever emptied.
    const all = metricFields('position', 'linear', 'angular', 'text')
    expect(all.length).toBe(Object.keys(METRIC_KIND).length)
    expect(all.length).toBeGreaterThan(15)
  })

  it('aggregates every linear field and keeps the last of every other', () => {
    const rows = [full(1_000, 0), full(2_000, 1), full(3_000, 2)]
    const r = buildHourRollup('2026-08-21T04', rows)

    for (const f of metricFields('linear')) {
      const agg = r.metrics[f]
      expect(agg, `${f} was not aggregated`).toBeDefined()
      expect(typeof agg?.avg, `${f} has no average`).toBe('number')
      expect(typeof agg?.min, `${f} has no minimum`).toBe('number')
    }
    for (const f of metricFields('angular', 'text')) {
      const agg = r.metrics[f]
      expect(agg, `${f} kept no last value`).toBeDefined()
      expect(agg?.last, `${f} kept an empty last value`).not.toBeNull()
      // An angle or a state has no meaningful average: averaging 359 and 1 gives 180.
      expect(agg?.avg, `${f} was averaged and should not have been`).toBeUndefined()
    }
    // Position rides in pos_first/pos_last, not in metrics.
    for (const f of metricFields('position')) {
      expect(r.metrics[f as MetricField], `${f} should not be a metric`).toBeUndefined()
    }
  })
})
