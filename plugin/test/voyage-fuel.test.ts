/**
 * Fuel integrated over a voyage, from the engines' own reported burn rate.
 *
 * `integrateMetrics` sums every `propulsion.*.fuel.rate` (SI m3/s) a snapshot
 * carries and trapezoidally integrates it over the same gap-guarded segments
 * distance uses. The result is litres actually burned, not a per-boat estimate:
 * where no engine reports a rate the answer is null, never a guessed number.
 *
 * These expectations are computed by hand from the rates and intervals below,
 * so a change to the integration that these do not predict is a change to
 * people's trip fuel figures.
 */
import { describe, expect, it } from 'vitest'
import { integrateMetrics, type VoyageRow } from '../src/voyage'

/** A rate in litres/hour as Signal K delivers it: cubic metres per second. */
const lh = (litresPerHour: number) => litresPerHour / 3_600_000

/** A row t seconds after epoch, holding the given engine fuel rates (L/h). */
function row(tSec: number, engines: Record<string, number>): VoyageRow {
  const path_values: Record<string, number> = {}
  for (const [name, rateLh] of Object.entries(engines)) {
    path_values[`propulsion.${name}.fuel.rate`] = lh(rateLh)
  }
  return { ts: tSec * 1000, lat: null, lon: null, sog: 0, nav_state: null, path_values }
}

describe('voyage fuel integration', () => {
  it('sums twin engines and integrates a constant rate exactly', () => {
    // port 35 + stbd 35 = 70 L/h, held over 3 x 60 s segments = 180 s = 0.05 h.
    const rows = [0, 60, 120, 180].map((t) =>
      row(t, { port: 35, starboard: 35 })
    )
    const m = integrateMetrics(rows)
    expect(m.fuel_used_l).toBeCloseTo(3.5, 6) // 70 L/h * 0.05 h
  })

  it('trapezoidally integrates a changing rate', () => {
    // single engine 10 -> 20 -> 30 L/h, 300 s apart (inside the 10-min window).
    // seg1 (10+20)/2 * (300/3600) h = 1.25 L, seg2 (20+30)/2 * ... = 2.0833 L.
    const rows = [
      row(0, { port: 10 }),
      row(300, { port: 20 }),
      row(600, { port: 30 })
    ]
    expect(integrateMetrics(rows).fuel_used_l).toBeCloseTo(3.3333, 3)
  })

  it('burns fuel at anchor: integration does not depend on movement', () => {
    // sog stays 0 throughout; hours_underway is 0 but fuel still accrues.
    const rows = [0, 600].map((t) => row(t, { port: 20 }))
    const m = integrateMetrics(rows)
    expect(m.hours_underway).toBe(0)
    expect(m.fuel_used_l).toBeCloseTo(3.3333, 3) // 20 L/h * (600/3600) h
  })

  it('returns null when no engine reports a fuel rate', () => {
    const rows: VoyageRow[] = [0, 60].map((t) => ({
      ts: t * 1000,
      lat: null,
      lon: null,
      sog: 0,
      nav_state: null
    }))
    expect(integrateMetrics(rows).fuel_used_l).toBeNull()
  })

  it('skips a segment whose gap exceeds the trust window (10 min)', () => {
    // 0->600 s valid (20 L/h * 600/3600 h), then an 11-min gap, then valid again.
    const rows = [
      row(0, { port: 20 }),
      row(600, { port: 20 }),
      row(600 + 11 * 60, { port: 20 }),
      row(600 + 11 * 60 + 600, { port: 20 })
    ]
    // Two 600 s legs of 20 L/h; the gap in the middle contributes nothing.
    const expected = 2 * (20 * (600 / 3600))
    expect(integrateMetrics(rows).fuel_used_l).toBeCloseTo(expected, 2)
  })

  it('skips a segment where one endpoint has no rate, but keeps the rest', () => {
    // Rate present at 0 and 600, absent at 300: a segment needs a rate at BOTH
    // ends, so 0->300 and 300->600 each have a bare endpoint and nothing
    // integrates - yet fuel is 0, not null, because a rate WAS seen.
    const rows: VoyageRow[] = [
      row(0, { port: 20 }),
      { ts: 300 * 1000, lat: null, lon: null, sog: 0, nav_state: null },
      row(600, { port: 20 })
    ]
    const m = integrateMetrics(rows)
    expect(m.fuel_used_l).toBe(0)
  })

  it('narrows the sum to the configured fuel-rate paths', () => {
    // A boat reporting one engine under two paths: summing both doubles it.
    // port 35 + engine 35 = 70 L/h over 180 s = 0.05 h.
    const rows = [0, 60, 120, 180].map((t) => row(t, { port: 35, engine: 35 }))
    // Default (no list): every propulsion.*.fuel.rate is summed - 70 L/h.
    expect(integrateMetrics(rows).fuel_used_l).toBeCloseTo(3.5, 6)
    // Pinned to one path: only that engine counts - 35 L/h.
    expect(integrateMetrics(rows, ['propulsion.engine.fuel.rate']).fuel_used_l).toBeCloseTo(1.75, 6)
  })

  it('returns null when the configured path is one the boat never reports', () => {
    // Pinning a path the boat does not send is "cannot know", never a silent
    // zero: no propulsion fuel rate matched the list.
    const rows = [0, 180].map((t) => row(t, { port: 20 }))
    expect(integrateMetrics(rows, ['propulsion.starboard.fuel.rate']).fuel_used_l).toBeNull()
  })
})
