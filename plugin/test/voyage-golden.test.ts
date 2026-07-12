/**
 * THE gate for the voyage engine: behavior equality against the reference
 * implementation's output on ten days of real (anonymized) vessel data.
 * If this fails after a change, the change rewrote users' voyage history.
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/config'
import { ReconcileState, reconcile } from '../src/voyage'
import { FIXTURES, loadFixtureRows } from './helpers'

interface ExpectedVoyage {
  start_ts: number
  end_ts: number
  start_lat: number | null
  start_lon: number | null
  end_lat: number | null
  end_lon: number | null
  distance_nm: number
  hours_underway: number
  avg_sog_kn: number | null
  max_sog_kn: number | null
  status: string
}

describe('voyage golden fixture', () => {
  it('reproduces the reference implementation voyage-for-voyage', async () => {
    const rows = loadFixtureRows()
    const expected = JSON.parse(
      readFileSync(path.join(FIXTURES, 'expected-voyages.json'), 'utf8')
    ) as ExpectedVoyage[]

    const state: ReconcileState = { voyages: [], nextId: 1 }
    await reconcile(state, rows, DEFAULTS.voyage, [], async (from, to) =>
      rows.filter((r) => r.ts >= from && r.ts <= to)
    )

    expect(state.voyages).toHaveLength(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const got = state.voyages[i]!
      const want = expected[i]!
      const label = `voyage #${i} (start ${want.start_ts})`

      expect(got.start_ts, label).toBe(want.start_ts)
      expect(got.end_ts, label).toBe(want.end_ts)
      expect(got.status, label).toBe(want.status)
      // Positions are copied from rows, not computed - exact equality.
      expect(got.start_lat, label).toBe(want.start_lat)
      expect(got.start_lon, label).toBe(want.start_lon)
      expect(got.end_lat, label).toBe(want.end_lat)
      expect(got.end_lon, label).toBe(want.end_lon)
      // Integrated metrics: identical algorithm, but libm/rounding may differ
      // in the last ULP - tolerances sit well below anything a user can see.
      expect(got.distance_nm, label).toBeCloseTo(want.distance_nm, 2)
      expect(got.hours_underway, label).toBeCloseTo(want.hours_underway, 2)
      if (want.avg_sog_kn === null) expect(got.avg_sog_kn, label).toBeNull()
      else expect(got.avg_sog_kn, label).toBeCloseTo(want.avg_sog_kn, 1)
      if (want.max_sog_kn === null) expect(got.max_sog_kn, label).toBeNull()
      else expect(got.max_sog_kn, label).toBeCloseTo(want.max_sog_kn, 1)
    }
  })
})
