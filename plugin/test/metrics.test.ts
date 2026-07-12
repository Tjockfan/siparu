import { describe, expect, it } from 'vitest'
import { DEFAULTS, KN_TO_MS } from '../src/config'
import { MetricsState } from '../src/metrics'

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

function fresh(opts = {}) {
  return new MetricsState({ ...DEFAULTS, ...opts })
}

describe('SOG sanitize', () => {
  it('accepts plausible speed', () => {
    const s = fresh()
    expect(s.ingest('navigation.speedOverGround', 5.2, T0)).toBe(true)
    expect(s.snapshot(T0, false).sog).toBe(5.2)
  })

  it('rejects the 132 kn AIS leak and keeps the previous good value', () => {
    const s = fresh()
    s.ingest('navigation.speedOverGround', 5.2, T0)
    expect(s.ingest('navigation.speedOverGround', 132 * KN_TO_MS, T0 + 2000)).toBe(false)
    expect(s.snapshot(T0 + 2000, false).sog).toBe(5.2)
  })

  it('rejects negative speed', () => {
    const s = fresh()
    expect(s.ingest('navigation.speedOverGround', -0.1, T0)).toBe(false)
  })

  it('threshold follows config, not a hardcoded hull number', () => {
    const slowBoat = fresh({ maxSogKnots: 13 })
    expect(slowBoat.ingest('navigation.speedOverGround', 20 * KN_TO_MS, T0)).toBe(false)
    const fastBoat = fresh({ maxSogKnots: 45 })
    expect(fastBoat.ingest('navigation.speedOverGround', 20 * KN_TO_MS, T0)).toBe(true)
  })
})

describe('TWS source fallback', () => {
  it('auto: uses speedOverGround when speedTrue is absent', () => {
    const s = fresh()
    s.ingest('environment.wind.speedOverGround', 7.5, T0)
    expect(s.snapshot(T0, false).wind_speed_true).toBe(7.5)
  })

  it('auto: prefers a fresh speedTrue', () => {
    const s = fresh()
    s.ingest('environment.wind.speedOverGround', 7.5, T0)
    s.ingest('environment.wind.speedTrue', 8.1, T0 + 1000)
    expect(s.snapshot(T0 + 2000, false).wind_speed_true).toBe(8.1)
  })

  it('auto: falls back when speedTrue goes stale', () => {
    const s = fresh()
    s.ingest('environment.wind.speedTrue', 8.1, T0)
    s.ingest('environment.wind.speedOverGround', 7.5, T0 + 60_000)
    expect(s.snapshot(T0 + 60_000, false).wind_speed_true).toBe(7.5)
  })
})

describe('automatic $source selection (dual GPS case)', () => {
  it('among fresh sources the higher-rate one wins', () => {
    const s = fresh()
    // gps-b: 10s cadence; gps-a: 2s cadence - both fresh at the end
    for (let i = 0; i < 3; i++) {
      s.ingest('navigation.position', { latitude: 44.0 + i, longitude: 7.0 }, T0 + i * 10_000, 'gps-b')
    }
    for (let i = 0; i < 11; i++) {
      s.ingest('navigation.position', { latitude: 43.0, longitude: 6.0 }, T0 + i * 2000, 'gps-a')
    }
    const snap = s.snapshot(T0 + 21_000, false)
    expect(snap.lat).toBe(43.0) // gps-a, despite gps-b having comparable freshness
  })

  it('fails over when the active source goes stale, and back again', () => {
    const s = fresh()
    for (let i = 0; i < 5; i++) {
      s.ingest('navigation.position', { latitude: 43.0, longitude: 6.0 }, T0 + i * 2000, 'gps-a')
    }
    s.ingest('navigation.position', { latitude: 44.0, longitude: 7.0 }, T0 + 40_000, 'gps-b')
    // gps-a silent for 32s -> stale; only gps-b is fresh
    expect(s.snapshot(T0 + 40_000, false).lat).toBe(44.0)
    // gps-a comes back
    s.ingest('navigation.position', { latitude: 43.5, longitude: 6.5 }, T0 + 42_000, 'gps-a')
    s.ingest('navigation.position', { latitude: 43.5, longitude: 6.5 }, T0 + 44_000, 'gps-a')
    expect(s.snapshot(T0 + 44_000, false).lat).toBe(43.5)
  })

  it('with no fresh source, last-known wins', () => {
    const s = fresh()
    s.ingest('navigation.speedOverGround', 3.0, T0, 'a')
    s.ingest('navigation.speedOverGround', 4.0, T0 + 1000, 'b')
    expect(s.snapshot(T0 + 300_000, false).sog).toBe(4.0)
  })
})

describe('diagnosis signatures', () => {
  it('no data at all', () => {
    const s = fresh()
    expect(s.diagnose(T0, false).code).toBe('no-data')
  })

  it('power present but no navigation data - N2K bridge signature', () => {
    const s = fresh()
    expect(s.diagnose(T0, true).code).toBe('energy-only')
  })

  it('instruments gone quiet after data was flowing', () => {
    const s = fresh()
    s.ingest('navigation.speedOverGround', 3.0, T0)
    const d = s.diagnose(T0 + 10 * 60_000, true)
    expect(d.code).toBe('instruments-off')
    expect(d.since_ts).toBe(T0)
  })

  it('ok while fresh', () => {
    const s = fresh()
    s.ingest('navigation.speedOverGround', 3.0, T0)
    expect(s.diagnose(T0 + 5000, true).code).toBe('ok')
  })
})

describe('gust max-hold', () => {
  it('records the window peak and resets on flush', () => {
    const s = fresh()
    for (const [dt, tws] of [
      [0, 6.0],
      [2000, 9.4],
      [4000, 7.1]
    ] as const) {
      s.ingest('environment.wind.speedOverGround', tws, T0 + dt)
    }
    expect(s.snapshot(T0 + 60_000, true).wind_gust).toBe(9.4)
    // next window starts empty
    expect(s.snapshot(T0 + 120_000, true).wind_gust).toBeNull()
  })

  it('live peek does not consume the window', () => {
    const s = fresh()
    s.ingest('environment.wind.speedOverGround', 9.4, T0)
    expect(s.snapshot(T0 + 1000, false).wind_gust).toBe(9.4)
    expect(s.snapshot(T0 + 60_000, true).wind_gust).toBe(9.4)
  })
})

describe('position and misc fields', () => {
  it('ingests position objects', () => {
    const s = fresh()
    s.ingest('navigation.position', { latitude: 43.27, longitude: 6.64 }, T0)
    const snap = s.snapshot(T0, false)
    expect(snap.lat).toBe(43.27)
    expect(snap.lon).toBe(6.64)
  })

  it('rejects malformed position', () => {
    const s = fresh()
    expect(s.ingest('navigation.position', { latitude: 'x' }, T0)).toBe(false)
  })

  it('depth concept: belowTransducer > belowKeel > belowSurface priority', () => {
    const s = fresh()
    s.ingest('environment.depth.belowSurface', 14.0, T0)
    expect(s.snapshot(T0, false).depth).toBe(14.0)
    s.ingest('environment.depth.belowKeel', 9.5, T0 + 1000)
    expect(s.snapshot(T0 + 1000, false).depth).toBe(9.5)
    s.ingest('environment.depth.belowTransducer', 12.0, T0 + 2000)
    expect(s.snapshot(T0 + 2000, false).depth).toBe(12.0)
    // transducer goes stale while keel keeps updating -> keel takes over
    s.ingest('environment.depth.belowKeel', 9.8, T0 + 60_000)
    expect(s.snapshot(T0 + 60_000, false).depth).toBe(9.8)
  })

  it('accepts string fields and rejects non-finite numbers', () => {
    const s = fresh()
    expect(s.ingest('navigation.state', 'motoring', T0)).toBe(true)
    expect(s.ingest('environment.outside.pressure', NaN, T0)).toBe(false)
    expect(s.ingest('unknown.path', 1, T0)).toBe(false)
    expect(s.snapshot(T0, false).nav_state).toBe('motoring')
  })

  it('tracks last delta time for health', () => {
    const s = fresh()
    expect(s.lastDeltaTs).toBeNull()
    s.ingest('navigation.state', 'anchored', T0)
    expect(s.lastDeltaTs).toBe(T0)
  })
})
