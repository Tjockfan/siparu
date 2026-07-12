/**
 * Live-path equivalence: the incremental VoyageLog (per-snapshot feed and
 * the startup replay) must produce the same voyages as the batch reconcile
 * the golden fixture pins.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/config'
import { Snapshot, Voyage } from '../src/contract'
import { Store } from '../src/store'
import { hourKey } from '../src/time'
import { ReconcileState, VoyageRow, reconcile } from '../src/voyage'
import { VoyageLog } from '../src/voyagelog'
import { loadFixtureRows } from './helpers'

function asSnapshot(r: VoyageRow): Snapshot {
  return { ...r } as Snapshot
}

async function batchReference(rows: VoyageRow[]): Promise<Voyage[]> {
  const state: ReconcileState = { voyages: [], nextId: 1 }
  await reconcile(state, rows, DEFAULTS.voyage, [], async (from, to) =>
    rows.filter((r) => r.ts >= from && r.ts <= to)
  )
  return state.voyages
}

function comparable(vs: Voyage[]) {
  return vs.map((v) => ({
    start_ts: v.start_ts,
    end_ts: v.end_ts,
    distance_nm: v.distance_nm,
    hours_underway: v.hours_underway,
    status: v.status
  }))
}

let dir: string
let store: Store

// First 3 fixture days: covers the two long passages + the short third leg.
function subset(): VoyageRow[] {
  const rows = loadFixtureRows()
  const cutoff = (rows[0] as VoyageRow).ts + 5 * 86_400_000
  return rows.filter((r) => r.ts < cutoff)
}

async function writeRawFiles(rows: VoyageRow[]): Promise<void> {
  const byHour = new Map<string, VoyageRow[]>()
  for (const r of rows) {
    const key = hourKey(r.ts)
    if (!byHour.has(key)) byHour.set(key, [])
    byHour.get(key)!.push(r)
  }
  for (const [key, hourRows] of byHour) {
    await fs.writeFile(store.rawPath(key), hourRows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-voyagelog-'))
  store = new Store(dir, 100 * 1024 * 1024, () => undefined)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('VoyageLog', () => {
  it('startup replay over raw files equals batch reconcile', async () => {
    const rows = subset()
    await store.init((rows[0] as VoyageRow).ts)
    await writeRawFiles(rows)
    // store's key index was built at init (empty dir) - rebuild it
    await store.init((rows[rows.length - 1] as VoyageRow).ts)

    const vlog = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog.init((rows[rows.length - 1] as VoyageRow).ts + 60_000)

    expect(comparable(vlog.list(100).reverse())).toEqual(comparable(await batchReference(rows)))
  })

  it('per-snapshot incremental feed equals batch reconcile', async () => {
    const rows = subset()
    await store.init((rows[0] as VoyageRow).ts)
    const vlog = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog.init((rows[0] as VoyageRow).ts)

    for (const r of rows) {
      await store.append(asSnapshot(r))
      await vlog.feed(asSnapshot(r))
    }
    await vlog.flush()

    expect(comparable(vlog.list(100).reverse())).toEqual(comparable(await batchReference(rows)))
  })

  it('persists voyages across restart and resumes cleanly', async () => {
    const rows = subset()
    await store.init((rows[0] as VoyageRow).ts)
    const half = Math.floor(rows.length / 2)

    const vlog1 = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog1.init((rows[0] as VoyageRow).ts)
    for (const r of rows.slice(0, half)) {
      await store.append(asSnapshot(r))
      await vlog1.feed(asSnapshot(r))
    }
    await vlog1.flush()

    // "restart": a fresh VoyageLog loads voyages.json and replays raw
    const vlog2 = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog2.init((rows[half - 1] as VoyageRow).ts)
    for (const r of rows.slice(half)) {
      await store.append(asSnapshot(r))
      await vlog2.feed(asSnapshot(r))
    }
    await vlog2.flush()

    expect(comparable(vlog2.list(100).reverse())).toEqual(comparable(await batchReference(rows)))
  })

  it('serves a track for a detected voyage', async () => {
    const rows = subset()
    await store.init((rows[0] as VoyageRow).ts)
    await writeRawFiles(rows)
    await store.init((rows[rows.length - 1] as VoyageRow).ts)
    const vlog = new VoyageLog(store, DEFAULTS, () => undefined)
    const now = (rows[rows.length - 1] as VoyageRow).ts + 60_000
    await vlog.init(now)

    const first = vlog.list(100).reverse()[0]!
    const track = await vlog.track(first.id, now)
    expect(track.length).toBeGreaterThan(50)
    expect(track[0]!.lat).not.toBeNull()
    expect(track.every((p) => p.ts >= first.start_ts && p.ts <= (first.end_ts ?? now))).toBe(true)
  })
})
