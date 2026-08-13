import { describe, expect, it } from 'vitest'
import { tripReadings } from './trip'
import type { Voyage } from './api'

const START = Date.UTC(2026, 7, 4, 8, 0, 0)
const NOW = START + 5 * 3600_000 + 23 * 60_000 // 5h 23m of wall clock

/** A passage under way: 4h 58m moving inside that span, 36.7 nm, 30.1 L burned. */
function voyage(over: Partial<Voyage> = {}): Voyage {
  return {
    id: 7,
    start_ts: START,
    end_ts: null,
    start_lat: 58.1,
    start_lon: 8.2,
    end_lat: 58.2,
    end_lon: 8.3,
    distance_nm: 36.7,
    hours_underway: 4 + 58 / 60,
    avg_sog_kn: 6.8,
    max_sog_kn: 18.2,
    fuel_used_l: 30.1,
    start_port: null,
    end_port: null,
    status: 'open',
    ...over,
  } as Voyage
}

function byKey(v: Voyage, now = NOW) {
  return Object.fromEntries(tripReadings(v, now).map((r) => [r.key, r]))
}

describe('tripReadings', () => {
  it('measures duration to now while the passage is open', () => {
    expect(byKey(voyage()).duration.value).toBe('05:23')
  })

  it('measures duration to the end once she has closed it', () => {
    const closed = voyage({ end_ts: START + 2 * 3600_000, status: 'closed' })
    // Still 02:00 an hour after the close: a finished passage stops counting.
    expect(byKey(closed, NOW).duration.value).toBe('02:00')
  })

  it('reports time under way apart from duration, and never derives idle from the two', () => {
    const r = byKey(voyage())
    expect(r.underway.value).toBe('04:58')
    // The gap between them is 25 minutes of SOMETHING: lying still, or the boat switched off
    // between snapshots. The two cannot be told apart here, so no cell claims to.
    expect(r.idle).toBeUndefined()
  })

  it('passes distance and the speeds through as the boat measured them', () => {
    const r = byKey(voyage())
    expect(r.distance.value).toBe('36.7')
    expect(r.avgSpeed.value).toBe('6.8')
    expect(r.maxSpeed.value).toBe('18.2')
  })

  it('divides the litres by hours and by miles', () => {
    const r = byKey(voyage())
    expect(r.fuelPerHour.value).toBe('6.1') // 30.1 / 4.9667
    expect(r.fuelPerMile.value).toBe('0.82') // 30.1 / 36.7
  })

  it('drops every fuel cell on a boat whose engines report no rate', () => {
    const r = byKey(voyage({ fuel_used_l: null }))
    expect(r.fuelUsed).toBeUndefined()
    expect(r.fuelPerHour).toBeUndefined()
    expect(r.fuelPerMile).toBeUndefined()
    // What she does measure is still there.
    expect(r.distance.value).toBe('36.7')
  })

  it('drops a divided cell rather than dividing by nothing', () => {
    const still = byKey(voyage({ hours_underway: 0, distance_nm: 0, avg_sog_kn: null }))
    expect(still.fuelPerHour).toBeUndefined()
    expect(still.fuelPerMile).toBeUndefined()
    expect(still.avgSpeed).toBeUndefined()
    // Fuel burned at anchor is real and stays.
    expect(still.fuelUsed.value).toBe('30.1')
  })

  it('shows hours past a day rather than wrapping to zero', () => {
    const long = voyage({ hours_underway: 30.5 })
    expect(byKey(long, START + 31 * 3600_000).duration.value).toBe('31:00')
    expect(byKey(long, START + 31 * 3600_000).underway.value).toBe('30:30')
  })

  it('refuses a clock that runs backwards instead of printing a negative span', () => {
    expect(byKey(voyage(), START - 60_000).duration).toBeUndefined()
  })
})
