import { describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/config'
import { MetricsState } from '../src/metrics'

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

function fresh() {
  return new MetricsState({ ...DEFAULTS })
}

/**
 * The boat-side mirror of the relay's telemetry sanitiser. Anyone on the bus
 * can publish a delta; these caps keep a rogue value from riding the uplink
 * or growing the path table without bound.
 */
describe('string values are capped at ingest', () => {
  it('truncates an oversized nav_state instead of storing megabytes', () => {
    const s = fresh()
    expect(s.ingest('navigation.state', 'x'.repeat(100_000), T0)).toBe(true)
    const stored = s.snapshot(T0, false).nav_state
    expect(stored).not.toBeNull()
    expect((stored as string).length).toBe(32)
  })

  it('keeps a normal nav_state untouched', () => {
    const s = fresh()
    s.ingest('navigation.state', 'under way using engine', T0)
    expect(s.snapshot(T0, false).nav_state).toBe('under way using engine')
  })

  it('truncates an oversized dynamic gauge string', () => {
    const s = fresh()
    expect(s.ingest('propulsion.port.state', 'y'.repeat(5000), T0)).toBe(true)
    const v = s.dynamicPaths(T0)['propulsion.port.state']
    expect((v as string).length).toBe(32)
  })

  it('pins the boundary: 32 passes whole, 33 loses one', () => {
    const s = fresh()
    s.ingest('navigation.state', 'a'.repeat(32), T0)
    expect((s.snapshot(T0, false).nav_state as string).length).toBe(32)
    const s2 = fresh()
    s2.ingest('navigation.state', 'a'.repeat(33), T0)
    expect((s2.snapshot(T0, false).nav_state as string).length).toBe(32)
  })
})

describe('dynamic path names are bounded', () => {
  it('rejects a path longer than 128 characters', () => {
    const s = fresh()
    const long = 'propulsion.' + 'a'.repeat(128) + '.rpm'
    expect(s.ingest(long, 1500, T0)).toBe(false)
  })

  it('rejects a path with characters outside the SK grammar', () => {
    const s = fresh()
    expect(s.ingest('propulsion.port<script>.rpm', 1500, T0)).toBe(false)
    expect(s.ingest('propulsion..rpm', 1500, T0)).toBe(false)
    expect(s.ingest('tanks.fuel 0.currentLevel', 0.5, T0)).toBe(false)
  })

  it('accepts the real families it exists for', () => {
    const s = fresh()
    expect(s.ingest('propulsion.port.revolutions', 25, T0)).toBe(true)
    expect(s.ingest('tanks.fuel.0.currentLevel', 0.62, T0)).toBe(true)
    expect(s.ingest('electrical.generators.0.load', 0.4, T0)).toBe(true)
  })

  it('stops taking new dynamic paths at 64, but keeps updating the known ones', () => {
    const s = fresh()
    for (let i = 0; i < 64; i++) {
      expect(s.ingest(`tanks.fuel.t${i}.currentLevel`, 0.5, T0)).toBe(true)
    }
    // Slot 65 is refused...
    expect(s.ingest('tanks.fuel.t64.currentLevel', 0.5, T0)).toBe(false)
    // ...while a path already in the table still updates.
    expect(s.ingest('tanks.fuel.t0.currentLevel', 0.7, T0 + 1000)).toBe(true)
    expect(s.dynamicPaths(T0 + 1000)['tanks.fuel.t0.currentLevel']).toBe(0.7)
  })

  it('a refused path claims no slot and stores no value', () => {
    const s = fresh()
    expect(s.ingest('propulsion.bad path.rpm', 1500, T0)).toBe(false)
    expect(Object.keys(s.dynamicPaths(T0))).toHaveLength(0)
  })
})
