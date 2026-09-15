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

  it('accepts the real families it exists for, hyphens and underscores included', () => {
    const s = fresh()
    expect(s.ingest('propulsion.port.revolutions', 25, T0)).toBe(true)
    expect(s.ingest('tanks.fuel.0.currentLevel', 0.62, T0)).toBe(true)
    expect(s.ingest('electrical.generators.0.load', 0.4, T0)).toBe(true)
    // Instance identifiers a gateway assigns are not always camelCase.
    expect(s.ingest('electrical.generators.genset-1.revolutions', 1500, T0)).toBe(true)
    expect(s.ingest('tanks.fresh_water.0.currentLevel', 0.5, T0)).toBe(true)
  })

  it('accepts the electrical families a power screen reads', () => {
    const s = fresh()
    expect(s.ingest('electrical.batteries.0.voltage', 12.6, T0)).toBe(true)
    expect(s.ingest('electrical.batteries.0.current', -14.2, T0)).toBe(true)
    expect(s.ingest('electrical.batteries.house.capacity.stateOfCharge', 0.82, T0)).toBe(true)
    expect(s.ingest('electrical.chargers.0.acin.current', 8.4, T0)).toBe(true)
    expect(s.ingest('electrical.inverters.0.acout.voltage', 230, T0)).toBe(true)
    expect(s.ingest('electrical.solar.0.panelPower', 420, T0)).toBe(true)
    expect(s.ingest('electrical.ac.shore.1.voltage', 229.4, T0)).toBe(true)
  })

  it('leaves the state flags and switch banks of a Victron install outside', () => {
    const s = fresh()
    // Venus OS publishes dozens of these. They are not gauges, and every one of
    // them would take a slot a battery reading needs.
    expect(s.ingest('electrical.venus.dcPower', 120, T0)).toBe(false)
    expect(s.ingest('electrical.venus.acInput.0.connected', 1, T0)).toBe(false)
    expect(s.ingest('electrical.switches.bank.0.state', 'on', T0)).toBe(false)
    // No blanket electrical subscription: a family we did not name stays out.
    expect(s.ingest('electrical.something.0.voltage', 12, T0)).toBe(false)
    expect(Object.keys(s.dynamicPaths(T0))).toHaveLength(0)
  })

  it('stops taking new dynamic paths at 128, but keeps updating the known ones', () => {
    const s = fresh()
    for (let i = 0; i < 128; i++) {
      expect(s.ingest(`electrical.chargers.c${i}.setpointVoltage`, 28.4, T0)).toBe(true)
    }
    // Slot 129 is refused...
    expect(s.ingest('electrical.chargers.c128.setpointVoltage', 28.4, T0)).toBe(false)
    // ...and refusing it moved nothing: a table of fillers does not shuffle itself.
    expect(Object.keys(s.dynamicPaths(T0))).toHaveLength(128)
    expect(s.dynamicPaths(T0)['electrical.chargers.c0.setpointVoltage']).toBe(28.4)
    // ...while a path already in the table still updates.
    expect(s.ingest('electrical.chargers.c0.setpointVoltage', 27.9, T0 + 1000)).toBe(true)
    expect(s.dynamicPaths(T0 + 1000)['electrical.chargers.c0.setpointVoltage']).toBe(27.9)
  })

  it('a refused path claims no slot and stores no value', () => {
    const s = fresh()
    expect(s.ingest('propulsion.bad path.rpm', 1500, T0)).toBe(false)
    expect(Object.keys(s.dynamicPaths(T0))).toHaveLength(0)
  })
})

/**
 * What a full table keeps. A boat with two engines, two gensets, eight tanks and a
 * Victron install reports more gauges than one frame carries, and first-come-first-kept
 * hands the table to whichever device happens to wake up first: the batteries of a boat
 * whose engines boot faster would simply never appear. So the readings a dashboard is
 * built from can take a slot from a filler that is not.
 */
describe('a full table keeps the readings a dashboard is built from', () => {
  it('drops the stalest filler to make room for a battery or engine reading', () => {
    const s = fresh()
    for (let i = 0; i < 128; i++) {
      expect(s.ingest(`electrical.chargers.c${i}.setpointVoltage`, 28.4, T0 + i)).toBe(true)
    }
    // c0 arrived first and would be the obvious victim by insertion order, but it is
    // the one still talking: the quietest gauge is c1, and that is what has to go.
    expect(s.ingest('electrical.chargers.c0.setpointVoltage', 28.6, T0 + 500)).toBe(true)

    expect(s.ingest('electrical.batteries.0.voltage', 12.6, T0 + 600)).toBe(true)
    expect(s.ingest('electrical.batteries.0.current', -14.2, T0 + 600)).toBe(true)
    expect(s.ingest('electrical.batteries.0.capacity.stateOfCharge', 0.82, T0 + 600)).toBe(true)
    expect(s.ingest('propulsion.port.revolutions', 1450, T0 + 600)).toBe(true)

    const live = s.dynamicPaths(T0 + 600)
    expect(live['electrical.batteries.0.voltage']).toBe(12.6)
    expect(live['electrical.batteries.0.current']).toBe(-14.2)
    expect(live['electrical.batteries.0.capacity.stateOfCharge']).toBe(0.82)
    expect(live['propulsion.port.revolutions']).toBe(1450)
    // The cap still holds: four fillers left so four readings could come in.
    expect(Object.keys(live)).toHaveLength(128)
    // The four quietest fillers went, and the one that kept talking stayed.
    expect(live['electrical.chargers.c0.setpointVoltage']).toBe(28.6)
    expect(live['electrical.chargers.c1.setpointVoltage']).toBeUndefined()
    expect(live['electrical.chargers.c4.setpointVoltage']).toBeUndefined()
    expect(live['electrical.chargers.c5.setpointVoltage']).toBe(28.4)
  })

  it('does not let one filler push out another, so a full table cannot churn', () => {
    // Without this the table would rewrite itself on every sample period: each new
    // filler evicts a filler, and every gauge's history turns into a sawtooth.
    const s = fresh()
    for (let i = 0; i < 128; i++) {
      expect(s.ingest(`electrical.chargers.c${i}.setpointVoltage`, 28.4, T0 + i)).toBe(true)
    }
    expect(s.ingest('electrical.chargers.c999.setpointVoltage', 28.4, T0 + 500)).toBe(false)
    const live = s.dynamicPaths(T0 + 500)
    expect(Object.keys(live)).toHaveLength(128)
    expect(live['electrical.chargers.c0.setpointVoltage']).toBe(28.4)
  })

  it('does not take a slot from another reading of the same standing', () => {
    const s = fresh()
    for (let i = 0; i < 128; i++) {
      expect(s.ingest(`electrical.batteries.b${i}.voltage`, 12.6, T0 + i)).toBe(true)
    }
    expect(s.ingest('propulsion.port.revolutions', 1450, T0 + 200)).toBe(false)
    expect(Object.keys(s.dynamicPaths(T0 + 200))).toHaveLength(128)
  })
})
