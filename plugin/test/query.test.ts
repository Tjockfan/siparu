import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Snapshot } from '../src/contract'
import { QueryError, QueryService } from '../src/query'
import { RollupEngine } from '../src/rollup'
import { Store } from '../src/store'

// "now": 2026-01-16 12:30 UTC - yesterday (Jan 15) is fully closed history.
const NOW = Date.UTC(2026, 0, 16, 12, 30, 0)
const YESTERDAY_NOON = Date.UTC(2026, 0, 15, 12, 0, 0)
const TODAY_START = Date.UTC(2026, 0, 16, 0, 0, 0)

function snap(
  ts: number,
  sog: number,
  pathValues?: Record<string, number>,
  core?: Partial<Snapshot>
): Snapshot {
  return {
    ts,
    sog,
    lat: 43.0,
    lon: 6.0,
    nav_state: 'motoring',
    ...(pathValues ? { path_values: pathValues } : {}),
    ...core,
  } as unknown as Snapshot
}

const RPM = 'propulsion.port.revolutions'

let dir: string
let store: Store
let engine: RollupEngine
let query: QueryService

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-query-'))
  store = new Store(dir, 10 * 1024 * 1024, () => undefined)
  await store.init(NOW)
  engine = new RollupEngine(store, () => undefined)
  query = new QueryService(store, engine)

  // yesterday: two hours of data; today: a morning hour + the open half hour.
  // Each snapshot also carries one engine gauge, so the dynamic-path history has data.
  // The core snapshot also carries wind + barometer, so a Bridge gauge (which lives in the
  // fixed Snapshot fields, not in path_values) has history to graph too.
  await store.append(snap(YESTERDAY_NOON, 4, { [RPM]: 20 }, { wind_speed_true: 5, air_pressure_pa: 101300 }))
  await store.append(snap(YESTERDAY_NOON + 3_600_000, 5, { [RPM]: 30 }, { wind_speed_true: 7, air_pressure_pa: 101000 }))
  await store.append(snap(TODAY_START + 9 * 3_600_000, 6, { [RPM]: 25 }, { wind_speed_true: 6, air_pressure_pa: 101200 })) // 09:00 today
  await store.append(snap(NOW - 60_000, 7, { [RPM]: 26 }, { wind_speed_true: 8, air_pressure_pa: 101100 })) // 12:29 today
  await store.flush()
  await engine.catchUp(NOW)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('bucket=1 (raw, the last week)', () => {
  it('serves every raw row in the window, not only today', async () => {
    const r = await query.snapshots({ bucket: 1, order: 'asc' }, NOW)
    expect(r.rows.map((x) => x.sog)).toEqual([4, 5, 6, 7])
    expect(r.clamped).toBe(false)
  })

  it('clamps a range reaching past the window and flags it', async () => {
    const r = await query.snapshots({ bucket: 1, from: NOW - 30 * 86_400_000, order: 'asc' }, NOW)
    expect(r.rows.map((x) => x.sog)).toEqual([4, 5, 6, 7])
    expect(r.clamped).toBe(true)
  })
})

describe('what a bucketed row carries back', () => {
  /**
   * The plane a depth was measured from is recorded in every hour and was read back from
   * none: the field was in the rollup's list and missing from the one that turns a rollup
   * line into a snapshot. Nothing failed - the depth came out of history as a bare number,
   * which is exactly the reading a surveyor is entitled to dismiss.
   */
  /**
   * The engine gauges are in the rollup (path_metrics) and were not in the row it produced, so
   * the logbook could offer an engineer's column for today and none for yesterday: the same
   * boat, the same recording, a table that lost half its columns as soon as the hour closed.
   */
  it('carries the engine gauges out of history, not only the navigation ones', async () => {
    const r = await query.snapshots({ bucket: 60, order: 'asc' }, NOW)
    const withRpm = r.rows.filter((x) => typeof x.path_values?.[RPM] === 'number')
    expect(withRpm.length, 'no hourly row carried an engine gauge').toBeGreaterThan(0)
    expect(withRpm[0]?.path_values?.[RPM]).toBeGreaterThan(0)
  })

  it('carries the depth datum out of history, not only the depth', async () => {
    await store.append(
      snap(YESTERDAY_NOON + 7_200_000, 5, undefined, {
        depth: 18.4,
        depth_datum: 'belowKeel'
      })
    )
    await store.flush()
    await engine.catchUp(NOW)

    const r = await query.snapshots({ bucket: 60, order: 'asc' }, NOW)
    const row = r.rows.find((x) => x.depth === 18.4)
    expect(row, 'the hour holding the depth was not returned').toBeDefined()
    expect(row?.depth_datum).toBe('belowKeel')
  })
})

describe('bucket=60 (hourly rollups)', () => {
  it('returns one row per closed hour with last values', async () => {
    const r = await query.snapshots({ bucket: 60, order: 'asc' }, NOW)
    // 3 closed hours: yesterday 12, yesterday 13, today 09 (12:xx is still open)
    expect(r.rows).toHaveLength(3)
    expect(r.rows.map((x) => x.sog)).toEqual([4, 5, 6])
    expect(r.rows[0]?.ts).toBe(YESTERDAY_NOON)
    expect(r.rows[0]?.lat).toBe(43.0)
    expect(r.rows[0]?.nav_state).toBe('motoring')
  })

  it('respects from/to', async () => {
    const r = await query.snapshots({ bucket: 60, from: TODAY_START, order: 'asc' }, NOW)
    expect(r.rows.map((x) => x.sog)).toEqual([6])
  })
})

describe('bucket=1 edge cases', () => {
  it('flags a range older than the window as clamped instead of silently empty', async () => {
    const old = NOW - 30 * 86_400_000
    const r = await query.snapshots({ bucket: 1, from: old, to: old + 3_600_000 }, NOW)
    expect(r.rows).toEqual([])
    expect(r.clamped).toBe(true)
  })
})

describe('bucket=360 (6h windows)', () => {
  it('returns the latest hour per window', async () => {
    const r = await query.snapshots({ bucket: 360, order: 'asc' }, NOW)
    // windows: yesterday 12:00-18:00 (hours 12+13 -> last wins: sog 5), today 06:00-12:00 (hour 09: sog 6)
    expect(r.rows.map((x) => x.sog)).toEqual([5, 6])
  })
})

describe('bucket=1440 (daily rollups)', () => {
  it('returns one row per completed day', async () => {
    const r = await query.snapshots({ bucket: 1440, order: 'asc' }, NOW)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.sog).toBe(5) // last value of Jan 15
  })
})

describe('paging and validation', () => {
  it('orders desc by default and flags limit cuts', async () => {
    const r = await query.snapshots({ bucket: 60, limit: 2 }, NOW)
    expect(r.rows.map((x) => x.sog)).toEqual([6, 5])
    expect(r.clamped).toBe(true)
    const page2 = await query.snapshots({ bucket: 60, limit: 2, offset: 2 }, NOW)
    expect(page2.rows.map((x) => x.sog)).toEqual([4])
    expect(page2.clamped).toBe(false)
  })

  it('rejects unknown bucket sizes', async () => {
    await expect(query.snapshots({ bucket: 15 as never }, NOW)).rejects.toThrow(QueryError)
  })
})

describe('pathSeries (dynamic gauge history)', () => {
  it('serves today raw points for one gauge', async () => {
    const r = await query.pathSeries(RPM, { bucket: 1, order: 'asc' }, NOW)
    expect(r.path).toBe(RPM)
    expect(r.points.map((p) => p.last)).toEqual([20, 30, 25, 26]) // the window, raw
    // A raw point is a single sample: min = max = avg = last.
    expect(r.points[3]).toMatchObject({ ts: NOW - 60_000, min: 26, max: 26, avg: 26, last: 26 })
  })

  it('serves hourly rollup points for one gauge, carrying the aggregate', async () => {
    const r = await query.pathSeries(RPM, { bucket: 60, order: 'asc' }, NOW)
    // 3 closed hours: yesterday 12 (20), yesterday 13 (30), today 09 (25)
    expect(r.points.map((p) => p.last)).toEqual([20, 30, 25])
    expect(r.points[0]).toMatchObject({ ts: YESTERDAY_NOON, min: 20, max: 20, avg: 20 })
  })

  it('serves the daily rollup point for one gauge', async () => {
    const r = await query.pathSeries(RPM, { bucket: 1440, order: 'asc' }, NOW)
    // Jan 15 day rollup: min 20, max 30, last 30
    expect(r.points).toHaveLength(1)
    expect(r.points[0]).toMatchObject({ min: 20, max: 30, last: 30 })
  })

  it('returns no points for a gauge the boat never reported', async () => {
    const r = await query.pathSeries('propulsion.starboard.revolutions', { bucket: 60, order: 'asc' }, NOW)
    expect(r.points).toEqual([])
  })
})

describe('pathSeries (core bridge gauge history)', () => {
  // Wind and barometer are core Snapshot fields, not dynamic path_values. The shore asks
  // for them by their plain SK path; the series is read from the fixed field / rollup metric.
  it('graphs true wind from the core field, raw over the window', async () => {
    const r = await query.pathSeries('environment.wind.speedTrue', { bucket: 1, order: 'asc' }, NOW)
    expect(r.path).toBe('environment.wind.speedTrue')
    expect(r.points.map((p) => p.last)).toEqual([5, 7, 6, 8])
    expect(r.points[2]).toMatchObject({ ts: TODAY_START + 9 * 3_600_000, min: 6, max: 6, avg: 6, last: 6 })
  })

  it('graphs the barometer from hourly rollups, carrying its aggregate', async () => {
    const r = await query.pathSeries('environment.outside.pressure', { bucket: 60, order: 'asc' }, NOW)
    // 3 closed hours: yesterday 12 (101300), yesterday 13 (101000), today 09 (101200)
    expect(r.points.map((p) => p.last)).toEqual([101300, 101000, 101200])
    expect(r.points[0]).toMatchObject({ min: 101300, max: 101300, avg: 101300 })
  })

  it('graphs the barometer from the daily rollup, min/max spanning the day', async () => {
    const r = await query.pathSeries('environment.outside.pressure', { bucket: 1440, order: 'asc' }, NOW)
    // Jan 15: 101300 then 101000 -> min 101000, max 101300, last 101000
    expect(r.points).toHaveLength(1)
    expect(r.points[0]).toMatchObject({ min: 101000, max: 101300, last: 101000 })
  })
})

/**
 * Minutes reach back a week, not to midnight.
 *
 * The raw record was readable for the current UTC day and no further, so a boat holding a
 * month of minutes on her own disk answered "nothing" for yesterday at that resolution - the
 * data was never deleted, only unreachable. The window now runs a week back, and the answer
 * says where it starts so nobody has to assume it.
 */
describe('bucket=1 window', () => {
  const THREE_DAYS_AGO_NOON = Date.UTC(2026, 0, 13, 12, 0, 0)

  it('serves minutes from earlier days, not only today', async () => {
    await store.append(snap(THREE_DAYS_AGO_NOON, 3))
    await store.flush()

    const r = await query.snapshots({ bucket: 1, from: THREE_DAYS_AGO_NOON, order: 'asc' }, NOW)
    expect(r.rows.map((x) => x.sog)).toEqual([3, 4, 5, 6, 7])
    expect(r.clamped).toBe(false)
  })

  it('clamps a window reaching past the week and says where the minutes start', async () => {
    const monthAgo = NOW - 30 * 86_400_000
    await store.append(snap(monthAgo, 1)) // the disk reaches further back than the window does
    await store.flush()

    const r = await query.snapshots({ bucket: 1, from: monthAgo, order: 'asc' }, NOW)
    expect(r.rows.map((x) => x.sog)).toEqual([4, 5, 6, 7]) // the month-old row stays out
    expect(r.clamped).toBe(true)
    expect(r.minutesFrom).toBe(NOW - 7 * 86_400_000)
  })

  /**
   * The cap is a promise the disk has to keep. A boat whose oldest raw file is younger than
   * the window cannot serve the whole week, and saying she can puts a hole in the page that
   * reads as lost data rather than as a boat that was switched off.
   */
  it('names the oldest hour on disk when it is younger than the window', async () => {
    const r = await query.snapshots({ bucket: 1, order: 'asc' }, NOW)
    expect(r.minutesFrom).toBe(Date.UTC(2026, 0, 15, 12, 0, 0))
  })

  it('carries one gauge back through the same window', async () => {
    await store.append(snap(THREE_DAYS_AGO_NOON, 3, { [RPM]: 11 }))
    await store.flush()

    const r = await query.pathSeries(RPM, { bucket: 1, from: THREE_DAYS_AGO_NOON, order: 'asc' }, NOW)
    expect(r.points.map((p) => p.last)).toEqual([11, 20, 30, 25, 26])
    expect(r.minutesFrom).toBe(THREE_DAYS_AGO_NOON)
  })
})
