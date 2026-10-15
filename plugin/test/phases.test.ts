import { describe, it, expect } from 'vitest'
import { DEFAULTS } from '../src/config'
import { classifyPhase, PhaseStateMachine } from '../src/phases'
import { VoyageRow } from '../src/voyage'

const MIN = 60_000
const OPTS = { ...DEFAULTS.voyage, phaseMinMinutes: 10 }

// sog is m/s. openKnots default is 1.5 kn = 0.77166 m/s.
const MOVING = 3 // ~5.8 kn
const STILL = 0

function row(
  ts: number,
  sog: number | null,
  nav_state: string | null = null,
  lat: number | null = null,
  lon: number | null = null
): VoyageRow {
  return { ts, sog, nav_state, lat, lon, path_values: undefined }
}

describe('classifyPhase', () => {
  it('under way from speed alone', () => {
    expect(classifyPhase(row(0, MOVING), 1.5)).toBe('underway')
  })

  it('under way from an explicit nav_state, even at zero speed', () => {
    expect(classifyPhase(row(0, STILL, 'under way using engine'), 1.5)).toBe('underway')
  })

  it('motion beats a stale anchored nav_state', () => {
    expect(classifyPhase(row(0, MOVING, 'at anchor'), 1.5)).toBe('underway')
  })

  it('anchored when stopped and nav_state says anchor', () => {
    expect(classifyPhase(row(0, STILL, 'at anchor'), 1.5)).toBe('anchored')
  })

  it('moored when stopped and nav_state says moored', () => {
    expect(classifyPhase(row(0, STILL, 'moored'), 1.5)).toBe('moored')
  })

  it('stopped when stationary with no telling nav_state', () => {
    expect(classifyPhase(row(0, STILL, 'motoring'), 1.5)).toBe('stopped')
    expect(classifyPhase(row(0, STILL, null), 1.5)).toBe('stopped')
    expect(classifyPhase(row(0, null, null), 1.5)).toBe('stopped')
  })

  it('the underway threshold splits exactly at openKnots', () => {
    // 0.77166 m/s == 1.5 kn. Just above is under way; at or below is not.
    expect(classifyPhase(row(0, 0.78), 1.5)).toBe('underway')
    expect(classifyPhase(row(0, 0.77), 1.5)).toBe('stopped')
  })

  it('a garbage SOG spike is discarded, not read as motion', () => {
    // 50 m/s is ~97 kn, above the 80 kn sanity ceiling: fall back to nav_state.
    expect(classifyPhase(row(0, 50, 'at anchor'), 1.5)).toBe('anchored')
    expect(classifyPhase(row(0, 50, null), 1.5)).toBe('stopped')
  })
})

describe('PhaseStateMachine', () => {
  it('opens a phase on the first row and reports no boundary yet', () => {
    const m = new PhaseStateMachine(OPTS)
    expect(m.feed(row(0, MOVING))).toBeNull()
    expect(m.current()?.kind).toBe('underway')
    expect(m.current()?.end_ts).toBeNull()
  })

  it('stays in one phase while the kind holds', () => {
    const m = new PhaseStateMachine(OPTS)
    m.feed(row(0, MOVING))
    for (let t = 1; t <= 20; t++) expect(m.feed(row(t * MIN, MOVING)), `t=${t}`).toBeNull()
    expect(m.current()?.kind).toBe('underway')
    expect(m.current()?.start_ts).toBe(0)
  })

  it('confirms a new phase only after phaseMinMinutes, back-dated to where it began', () => {
    const m = new PhaseStateMachine(OPTS)
    m.feed(row(0, MOVING)) // underway opens at 0
    let closed = null
    for (let t = 5; t <= 30; t++) {
      const r = m.feed(row(t * MIN, STILL)) // she stops at t=5 min
      if (r) {
        closed = r
        break
      }
    }
    // candidate began at t=5 min; a 10 min streak confirms it at t=15 min.
    expect(closed).not.toBeNull()
    expect(closed!.kind).toBe('underway')
    expect(closed!.start_ts).toBe(0)
    expect(closed!.end_ts).toBe(5 * MIN) // back-dated to where she stopped
    expect(m.current()?.kind).toBe('stopped')
    expect(m.current()?.start_ts).toBe(5 * MIN)
  })

  it('holds the phase-minimum boundary exactly (10 min, not 9)', () => {
    const m = new PhaseStateMachine(OPTS)
    m.feed(row(0, MOVING))
    m.feed(row(1 * MIN, STILL)) // candidate begins here, streak 0
    // rows at 2..10 min accrue 1 min of streak each: 1..9 min, never enough
    for (let t = 2; t <= 10; t++) expect(m.feed(row(t * MIN, STILL)), `t=${t}`).toBeNull()
    // t=11 min: streak reaches exactly 10 min -> boundary
    const closed = m.feed(row(11 * MIN, STILL))
    expect(closed).not.toBeNull()
    expect(closed!.end_ts).toBe(1 * MIN)
  })

  it('a blip shorter than phaseMinMinutes does not split the phase', () => {
    const m = new PhaseStateMachine(OPTS)
    m.feed(row(0, MOVING))
    m.feed(row(5 * MIN, STILL)) // candidate stopped
    m.feed(row(8 * MIN, STILL)) // streak 3 min, not a phase yet
    expect(m.feed(row(9 * MIN, MOVING))).toBeNull() // back under way -> candidate dropped
    for (let t = 10; t <= 30; t++) expect(m.feed(row(t * MIN, MOVING)), `t=${t}`).toBeNull()
    expect(m.current()?.kind).toBe('underway')
    expect(m.current()?.start_ts).toBe(0) // never split
  })

  it('a data gap with the same kind on both sides resumes the phase', () => {
    const m = new PhaseStateMachine(OPTS)
    m.feed(row(0, MOVING))
    m.feed(row(5 * MIN, STILL)) // candidate stopped begins
    m.feed(row(8 * MIN, STILL)) // streak 3 min
    // a gap of 17 min (> MAX_GAP), and she is back under way: nothing changed
    expect(m.feed(row(25 * MIN, MOVING))).toBeNull()
    expect(m.current()?.kind).toBe('underway')
    expect(m.current()?.start_ts).toBe(0)
    // the pre-gap candidate did not survive it: a fresh full streak is required
    for (let t = 26; t <= 34; t++) expect(m.feed(row(t * MIN, STILL)), `t=${t}`).toBeNull()
  })

  it('a data gap confirms the change that had begun before it, at its beginning', () => {
    const m = new PhaseStateMachine(OPTS)
    m.feed(row(0, MOVING, null, 40, 10))
    m.feed(row(5 * MIN, STILL, null, 41, 11)) // she stops here
    m.feed(row(8 * MIN, STILL, null, 41, 11)) // power goes two minutes later
    const closed = m.feed(row(14 * 60 * MIN, STILL, null, 41, 11)) // back the next afternoon, still
    expect(closed?.kind).toBe('underway')
    expect(closed?.end_ts).toBe(5 * MIN) // where she stopped, not fourteen hours on
    expect(closed?.end_lat).toBe(41)
    expect(m.current()?.kind).toBe('stopped')
    expect(m.current()?.start_ts).toBe(5 * MIN) // contiguous: the stop began before the gap
  })

  it('a data gap followed by a new kind ends the phase at the last row before it', () => {
    const m = new PhaseStateMachine(OPTS)
    m.feed(row(0, MOVING, null, 40, 10))
    m.feed(row(8 * MIN, MOVING, null, 40.1, 10.1)) // still making way when the record stops
    const closed = m.feed(row(14 * 60 * MIN, STILL, 'at anchor', 40.2, 10.2))
    expect(closed?.kind).toBe('underway')
    expect(closed?.end_ts).toBe(8 * MIN)
    expect(closed?.end_lat).toBe(40.1)
    // the hours off the air belong to no phase; the new one starts where the record resumes
    expect(m.current()?.kind).toBe('anchored')
    expect(m.current()?.start_ts).toBe(14 * 60 * MIN)
  })

  it('restores an open phase across a restart', () => {
    const m = new PhaseStateMachine(OPTS, { kind: 'anchored', start: { ts: 100, lat: 40, lon: 10 } })
    expect(m.current()?.kind).toBe('anchored')
    expect(m.current()?.start_ts).toBe(100)
    expect(m.feed(row(100 + MIN, STILL, 'at anchor'))).toBeNull()
    expect(m.current()?.kind).toBe('anchored')
  })

  it('current() carries the latest position as the running end', () => {
    const m = new PhaseStateMachine(OPTS)
    m.feed(row(0, MOVING, null, 40.0, 10.0))
    m.feed(row(MIN, MOVING, null, 40.1, 10.1))
    const cur = m.current()!
    expect(cur.end_ts).toBeNull()
    expect(cur.start_lat).toBe(40.0)
    expect(cur.end_lat).toBe(40.1)
  })

  it('produces an underway -> anchored -> underway band with carried positions', () => {
    const m = new PhaseStateMachine(OPTS)
    const closed: { kind: string; start_ts: number; end_ts: number | null }[] = []
    // under way 0..20 min
    for (let t = 0; t <= 20; t++) {
      const r = m.feed(row(t * MIN, MOVING, 'under way using engine', 40, 10))
      if (r) closed.push(r)
    }
    // at anchor 21..60 min
    for (let t = 21; t <= 60; t++) {
      const r = m.feed(row(t * MIN, STILL, 'at anchor', 41, 11))
      if (r) closed.push(r)
    }
    // under way again 61..90 min
    for (let t = 61; t <= 90; t++) {
      const r = m.feed(row(t * MIN, MOVING, 'under way using engine', 42, 12))
      if (r) closed.push(r)
    }
    expect(closed.map((p) => p.kind)).toEqual(['underway', 'anchored'])
    expect(m.current()?.kind).toBe('underway')
  })
})
