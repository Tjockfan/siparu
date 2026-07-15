import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Snapshot } from '../src/contract'
import { RollupEngine, buildDayRollup, buildHourRollup, haversineNm, trackDistanceNm } from '../src/rollup'
import { Store } from '../src/store'

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

function snap(ts: number, fields: Partial<Snapshot> = {}): Snapshot {
  return { ts, lat: null, lon: null, sog: null, cog: null, nav_state: null, ...fields } as Snapshot
}

describe('haversine + track distance', () => {
  it('computes a known distance (1 degree of latitude = 60 NM)', () => {
    expect(haversineNm(43.0, 6.0, 44.0, 6.0)).toBeCloseTo(60.0, 0)
  })

  it('sums consecutive fixes and skips null positions', () => {
    // 6.00 -> 6.02 lon over 2 min ≈ 0.88 NM ≈ 26 kn - realistic fast leg
    const rows = [
      snap(T0, { lat: 43.0, lon: 6.0 }),
      snap(T0 + 60_000, {}), // no fix - skipped, chain continues
      snap(T0 + 120_000, { lat: 43.0, lon: 6.02 })
    ]
    expect(trackDistanceNm(rows)).toBeCloseTo(haversineNm(43.0, 6.0, 43.0, 6.02), 6)
  })

  it('drops teleport segments implying more than the 80 kn guard', () => {
    const rows = [
      snap(T0, { lat: 43.0, lon: 6.0 }),
      snap(T0 + 60_000, { lat: 44.0, lon: 6.0 }), // 60 NM in 1 min = 3600 kn glitch
      snap(T0 + 120_000, { lat: 44.0, lon: 6.01 })
    ]
    const dist = trackDistanceNm(rows)
    expect(dist).toBeLessThan(1)
    expect(dist).toBeGreaterThan(0)
  })
})

describe('buildHourRollup', () => {
  it('aggregates linear metrics and keeps last-only for angular/string', () => {
    const rows = [
      snap(T0, { sog: 2, cog: 1.0, nav_state: 'motoring', lat: 43.0, lon: 6.0 }),
      snap(T0 + 60_000, { sog: 6, cog: 1.2 }),
      snap(T0 + 120_000, { sog: 4, cog: null, lat: 43.0, lon: 6.02 })
    ]
    const r = buildHourRollup('2026-01-15T12', rows)
    expect(r.count).toBe(3)
    expect(r.metrics.sog).toMatchObject({ min: 2, max: 6, avg: 4, last: 4 })
    expect(r.metrics.cog).toEqual({ last: 1.2 }) // angular: last non-null only
    expect(r.metrics.nav_state).toEqual({ last: 'motoring' })
    expect(r.pos_first).toEqual({ lat: 43.0, lon: 6.0 })
    expect(r.pos_last).toEqual({ lat: 43.0, lon: 6.02 })
    expect(r.first_ts).toBe(T0)
    expect(r.last_ts).toBe(T0 + 120_000)
    expect(r.distance_nm).toBeGreaterThan(0.5)
  })
})

describe('buildDayRollup', () => {
  it('sums distance/count and weights averages by sample count', () => {
    const h1 = buildHourRollup('2026-01-15T12', [snap(T0, { sog: 2 }), snap(T0 + 60_000, { sog: 4 })])
    const h2 = buildHourRollup('2026-01-15T13', [snap(T0 + 3_600_000, { sog: 8 })])
    const d = buildDayRollup('2026-01-15', [h2, h1]) // order-insensitive
    expect(d.count).toBe(3)
    expect(d.metrics.sog?.min).toBe(2)
    expect(d.metrics.sog?.max).toBe(8)
    expect(d.metrics.sog?.avg).toBeCloseTo((2 + 4 + 8) / 3, 6)
    expect(d.metrics.sog?.last).toBe(8)
    expect(d.first_ts).toBe(T0)
  })
})

describe('dynamic path history rollup', () => {
  it('aggregates a dynamic gauge across an hour like a linear metric', () => {
    const rows = [
      snap(T0, { path_values: { 'propulsion.port.revolutions': 20 } }),
      snap(T0 + 60_000, { path_values: { 'propulsion.port.revolutions': 30 } }),
      snap(T0 + 120_000, { path_values: { 'propulsion.port.revolutions': 25 } }),
    ]
    const r = buildHourRollup('2026-01-15T12', rows)
    expect(r.path_metrics?.['propulsion.port.revolutions']).toMatchObject({ min: 20, max: 30, avg: 25, last: 25 })
  })

  it('rolls dynamic gauges up into the day, weighting by sample count', () => {
    const h1 = buildHourRollup('2026-01-15T12', [
      snap(T0, { path_values: { 'tanks.fuel.0.currentLevel': 0.8 } }),
      snap(T0 + 60_000, { path_values: { 'tanks.fuel.0.currentLevel': 0.6 } }),
    ])
    const h2 = buildHourRollup('2026-01-15T13', [
      snap(T0 + 3_600_000, { path_values: { 'tanks.fuel.0.currentLevel': 0.4 } }),
    ])
    const d = buildDayRollup('2026-01-15', [h2, h1])
    const m = d.path_metrics?.['tanks.fuel.0.currentLevel']
    expect(m?.min).toBe(0.4)
    expect(m?.max).toBe(0.8)
    expect(m?.avg).toBeCloseTo((0.8 + 0.6 + 0.4) / 3, 6)
    expect(m?.last).toBe(0.4)
  })

  it('leaves path_metrics absent when the boat exposes no dynamic gauges', () => {
    const r = buildHourRollup('2026-01-15T12', [snap(T0, { sog: 5 })])
    expect(r.path_metrics).toBeUndefined()
  })
})

describe('buildDayRollup hour-boundary distance', () => {
  it('counts the leg between one hour\'s last fix and the next hour\'s first fix', () => {
    // ~26 kn leg crossing the boundary: 6.00 -> 6.02 lon over the 2 min gap
    const h1 = buildHourRollup('2026-01-15T12', [snap(T0 + 3_540_000, { lat: 43.0, lon: 6.0 })])
    const h2 = buildHourRollup('2026-01-15T13', [snap(T0 + 3_660_000, { lat: 43.0, lon: 6.02 })])
    expect(h1.distance_nm).toBe(0) // single fix per hour: no in-hour distance
    expect(h2.distance_nm).toBe(0)
    const d = buildDayRollup('2026-01-15', [h1, h2])
    expect(d.distance_nm).toBeCloseTo(haversineNm(43.0, 6.0, 43.0, 6.02), 6)
  })

  it('still guards boundary legs against teleports', () => {
    const h1 = buildHourRollup('2026-01-15T12', [snap(T0 + 3_540_000, { lat: 43.0, lon: 6.0 })])
    const h2 = buildHourRollup('2026-01-15T13', [snap(T0 + 3_660_000, { lat: 44.0, lon: 6.0 })]) // 60 NM in 2 min
    expect(buildDayRollup('2026-01-15', [h1, h2]).distance_nm).toBe(0)
  })
})

describe('RollupEngine catch-up', () => {
  let dir: string
  let store: Store
  let engine: RollupEngine

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-rollup-'))
    store = new Store(dir, 10 * 1024 * 1024, () => undefined)
    await store.init(T0)
    engine = new RollupEngine(store, () => undefined)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('materializes closed hours only, idempotently', async () => {
    await store.append(snap(T0, { sog: 3 })) // 12:xx - closed
    await store.append(snap(T0 + 3_600_000, { sog: 5 })) // 13:xx - current
    await store.flush()

    const now = T0 + 3_600_000 + 60_000 // 13:01
    await engine.catchUp(now)
    await engine.catchUp(now) // second run must not duplicate

    const hours = await engine.readHourly(0, now)
    expect(hours).toHaveLength(1)
    expect(hours[0]?.hour).toBe('2026-01-15T12')
    expect(hours[0]?.metrics.sog?.last).toBe(3)
  })

  it('builds daily rollups once the day completes', async () => {
    await store.append(snap(T0, { sog: 3, lat: 43, lon: 6 }))
    await store.append(snap(T0 + 3_600_000, { sog: 5 }))
    await store.flush()

    const nextDayNoon = T0 + 24 * 3_600_000
    await engine.catchUp(nextDayNoon)

    const days = await engine.readDaily(0, nextDayNoon)
    expect(days).toHaveLength(1)
    expect(days[0]?.date).toBe('2026-01-15')
    expect(days[0]?.count).toBe(2)

    const fresh = new RollupEngine(store, () => undefined)
    await fresh.catchUp(nextDayNoon) // restart: keys reloaded from disk, no dupes
    expect(await fresh.readDaily(0, nextDayNoon)).toHaveLength(1)
  })

  it('survives a torn hourly line without double-counting the hour', async () => {
    await store.append(snap(T0, { sog: 3 }))
    await store.append(snap(T0 + 3_600_000, { sog: 5 }))
    await store.flush()
    const now = T0 + 3_600_000 + 60_000
    await engine.catchUp(now)

    // power loss mid-append: last line torn -> parse skips it
    const file = path.join(store.rollupDir, 'hourly-2026-01.ndjson')
    await fs.appendFile(file, '{"hour":"2026-01-15T12","count":9')
    const fresh = new RollupEngine(store, () => undefined)
    await fresh.catchUp(now) // re-appends the hour (torn line invisible)

    const hours = await fresh.readHourly(0, now)
    expect(hours).toHaveLength(1) // deduped, not double-counted
    expect(hours[0]?.count).toBe(1)
  })

  it('reads hourly rollups across a month boundary', async () => {
    const jan31 = Date.UTC(2026, 0, 31, 23, 30, 0)
    const feb1 = Date.UTC(2026, 1, 1, 0, 30, 0)
    await store.append(snap(jan31, { sog: 3 }))
    await store.append(snap(feb1, { sog: 5 }))
    await store.flush()
    const now = feb1 + 3_600_000
    await engine.catchUp(now)
    const hours = await engine.readHourly(jan31 - 1, now)
    expect(hours.map((h) => h.hour)).toEqual(['2026-01-31T23', '2026-02-01T00'])
  })

  it('clamps an absurd query range instead of walking millions of buckets', async () => {
    await store.append(snap(T0, { sog: 3 }))
    await store.append(snap(T0 + 3_600_000, { sog: 5 }))
    await store.flush()
    await engine.catchUp(T0 + 3_600_000 + 60_000)

    // Hostile "to" (JS Date max) would otherwise iterate to year 275760.
    // Clamped to now, it returns quickly with the real data and no extra.
    const started = performance.now()
    const hostile = await engine.readHourly(-8.64e15, 8.64e15)
    const bounded = await engine.readHourly(0, Date.now())
    expect(hostile.map((h) => h.hour)).toEqual(bounded.map((h) => h.hour))
    expect(hostile).toHaveLength(1)
    // A single readHourly walking to year 275760 takes seconds; clamped, ms.
    expect(performance.now() - started).toBeLessThan(1000)

    // readDaily shares the same sink guard.
    expect(await engine.readDaily(-8.64e15, 8.64e15)).toHaveLength(0) // no completed day yet
  })

  it('reports pending hours for /health', async () => {
    await store.append(snap(T0, { sog: 3 }))
    await store.append(snap(T0 + 3_600_000, { sog: 5 }))
    await store.flush()
    const now = T0 + 3_600_000 + 60_000
    expect((await engine.status(now)).hours_pending).toBe(1)
    await engine.catchUp(now)
    const after = await engine.status(now)
    expect(after.hours_pending).toBe(0)
    expect(after.last_hour).toBe('2026-01-15T12')
  })
})
