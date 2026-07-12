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

function snap(ts: number, sog: number): Snapshot {
  return { ts, sog, lat: 43.0, lon: 6.0, nav_state: 'motoring' } as unknown as Snapshot
}

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

  // yesterday: two hours of data; today: a morning hour + the open half hour
  await store.append(snap(YESTERDAY_NOON, 4))
  await store.append(snap(YESTERDAY_NOON + 3_600_000, 5))
  await store.append(snap(TODAY_START + 9 * 3_600_000, 6)) // 09:00 today
  await store.append(snap(NOW - 60_000, 7)) // 12:29 today
  await store.flush()
  await engine.catchUp(NOW)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('bucket=1 (raw, today only)', () => {
  it('serves today rows', async () => {
    const r = await query.snapshots({ bucket: 1, order: 'asc' }, NOW)
    expect(r.rows.map((x) => x.sog)).toEqual([6, 7])
    expect(r.clamped).toBe(false)
  })

  it('clamps a range reaching into history and flags it', async () => {
    const r = await query.snapshots({ bucket: 1, from: YESTERDAY_NOON, order: 'asc' }, NOW)
    expect(r.rows.map((x) => x.sog)).toEqual([6, 7]) // yesterday never leaves raw
    expect(r.clamped).toBe(true)
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
  it('flags a fully-historical range as clamped instead of silently empty', async () => {
    const r = await query.snapshots({ bucket: 1, from: YESTERDAY_NOON, to: YESTERDAY_NOON + 3_600_000 }, NOW)
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
