import { describe, expect, it } from 'vitest'
import { decimateTrack, MAX_TRACK_POINTS } from '../src/track'
import type { TrackPoint } from '../src/contract'

/** A run of fixes, one per second, marching north. Index is recoverable from lat, so a thinned
 *  track can be checked for even spacing and kept endpoints. */
function fixes(n: number): TrackPoint[] {
  return Array.from({ length: n }, (_, i) => ({ ts: 1000 + i, lat: 43 + i / 1000, lon: 7, sog: 3 }))
}

describe('decimateTrack', () => {
  it('leaves a short track untouched and says so', () => {
    const t = fixes(10)
    const r = decimateTrack(t, 2000)
    expect(r.track).toEqual(t)
    expect(r.decimated).toBe(false)
  })

  it('leaves a track that exactly fits untouched', () => {
    const r = decimateTrack(fixes(2000), 2000)
    expect(r.track).toHaveLength(2000)
    expect(r.decimated).toBe(false)
  })

  it('thins a long track to at most the cap and flags it', () => {
    const r = decimateTrack(fixes(20_000), 2000)
    // At an even stride plus a kept endpoint, never over the cap by more than that one point.
    expect(r.track.length).toBeLessThanOrEqual(2001)
    expect(r.track.length).toBeGreaterThan(1000)
    expect(r.decimated).toBe(true)
  })

  it('always keeps the first and last fix, so the line starts and ends where the voyage did', () => {
    const t = fixes(20_000)
    const r = decimateTrack(t, 2000)
    expect(r.track[0]).toEqual(t[0])
    expect(r.track[r.track.length - 1]).toEqual(t[t.length - 1])
  })

  it('drops fixes at an even stride, not in a clump', () => {
    // 10000 -> stride 5; consecutive kept fixes are one stride apart in the original.
    const r = decimateTrack(fixes(10_000), 2000)
    const latToIndex = (p: TrackPoint) => Math.round((p.lat - 43) * 1000)
    const gaps = r.track.slice(1, -1).map((p, i) => latToIndex(p) - latToIndex(r.track[i]))
    expect(new Set(gaps).size).toBe(1) // uniform interior spacing
  })

  it('has a sane default cap', () => {
    expect(MAX_TRACK_POINTS).toBe(2000)
    const r = decimateTrack(fixes(50_000))
    expect(r.track.length).toBeLessThanOrEqual(MAX_TRACK_POINTS + 1)
  })
})
