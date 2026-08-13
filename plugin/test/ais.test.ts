import { describe, expect, it } from 'vitest'
import { buildAisFeed, clampAisQuery } from '../src/ais'

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const SELF = 'vessels.urn:mrn:imo:mmsi:111111111'

function vesselsModel() {
  const iso = (agoMin: number) => new Date(NOW - agoMin * 60_000).toISOString()
  return {
    'urn:mrn:imo:mmsi:111111111': {
      navigation: { position: { value: { latitude: 43.0, longitude: 7.0 }, timestamp: iso(0) } }
    },
    'urn:mrn:imo:mmsi:222222222': {
      mmsi: '222222222',
      name: { value: 'NEARBY <b>ONE</b>' },
      navigation: {
        position: { value: { latitude: 43.01, longitude: 7.0 }, timestamp: iso(2) },
        speedOverGround: { value: 5.0 },
        courseOverGroundTrue: { value: Math.PI }
      },
      design: { aisShipType: { value: { name: 'Sailing' } }, length: { value: { overall: 14 } } }
    },
    'urn:mrn:imo:mmsi:333333333': {
      mmsi: '333333333',
      navigation: { position: { value: { latitude: 44.5, longitude: 7.0 }, timestamp: iso(1) } }
    },
    'urn:mrn:imo:mmsi:444444444': {
      mmsi: '444444444',
      navigation: { position: { value: { latitude: 43.02, longitude: 7.0 }, timestamp: iso(60) } }
    }
  }
}

describe('buildAisFeed', () => {
  const q = clampAisQuery(undefined, undefined, undefined) // 5nm / 15min / 30

  it('excludes self, far and stale targets; sorts by distance', () => {
    const feed = buildAisFeed(vesselsModel(), SELF, NOW, q)
    // 333 is ~90nm away, 444 is 60min old -> only 222 remains
    expect(feed.targets.map((t) => t.mmsi)).toEqual(['222222222'])
    expect(feed.own).toEqual({ lat: 43.0, lon: 7.0 })
    expect(feed.count).toBe(1)
  })

  it('sanitizes markup out of AIS strings and converts units', () => {
    const t = buildAisFeed(vesselsModel(), SELF, NOW, q).targets[0]!
    expect(t.name).toBe('NEARBY bONE/b') // markup chars stripped
    expect(t.name).not.toMatch(/[<>"'`]/)
    expect(t.sog_kn).toBeCloseTo(9.7, 1) // 5 m/s
    expect(t.cog_deg).toBeCloseTo(180, 0)
    expect(t.ship_type).toBe('Sailing')
    expect(t.length_m).toBe(14)
  })

  it('reports an explicit error without own position', () => {
    const model = vesselsModel() as Record<string, unknown>
    delete model['urn:mrn:imo:mmsi:111111111']
    const feed = buildAisFeed(model, SELF, NOW, q)
    expect(feed.error).toBe('no-self-position')
    expect(feed.targets).toEqual([])
  })

  it('clamps query parameters into safe ranges', () => {
    expect(clampAisQuery(500, 0, 10_000)).toEqual({ maxNm: 50, maxAgeMin: 1, limit: 400 })
  })
})
