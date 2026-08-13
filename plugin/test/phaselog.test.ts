/**
 * Live-path equivalence for the activity band: a restart that replays the raw
 * files must reconstruct exactly the phases the per-snapshot feed built, streaks
 * and open phase included. Separate file, separate store from the voyages: the
 * point of the whole design is that phases move no voyage.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/config'
import { Snapshot } from '../src/contract'
import { Store } from '../src/store'
import { VoyageRow } from '../src/voyage'
import { PhaseLog } from '../src/phaselog'

const MIN = 60_000
const asSnapshot = (r: VoyageRow): Snapshot => ({ ...r }) as Snapshot

/** under way 0..20, at anchor 21..60, under way 61..90 (minutes). */
function bandRows(): VoyageRow[] {
  const t0 = Date.UTC(2026, 5, 1, 8, 0, 0)
  const rows: VoyageRow[] = []
  const push = (m: number, sog: number, nav: string, lat: number, lon: number) =>
    rows.push({ ts: t0 + m * MIN, lat, lon, sog, nav_state: nav, path_values: undefined })
  for (let m = 0; m <= 20; m++) push(m, 3, 'under way using engine', 43.0, 7.0)
  for (let m = 21; m <= 60; m++) push(m, 0, 'at anchor', 43.5, 7.5)
  for (let m = 61; m <= 90; m++) push(m, 3, 'under way using engine', 43.6, 7.6)
  return rows
}

let dir: string
let store: Store

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-phaselog-'))
  store = new Store(dir, 100 * 1024 * 1024, () => undefined)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function feedAll(pl: PhaseLog, rows: VoyageRow[]): Promise<void> {
  for (const r of rows) {
    await store.append(asSnapshot(r))
    await pl.feed(asSnapshot(r))
  }
  await pl.flush()
}

describe('PhaseLog', () => {
  it('records the underway/anchored/underway band, newest first', async () => {
    const rows = bandRows()
    await store.init(rows[0]!.ts)
    const pl = new PhaseLog(store, DEFAULTS, () => undefined)
    await pl.init(rows[0]!.ts)
    await feedAll(pl, rows)

    const oldestFirst = pl.list(100).map((p) => p.kind).reverse()
    expect(oldestFirst).toEqual(['underway', 'anchored', 'underway'])
    expect(pl.current()?.kind).toBe('underway')
    expect(pl.current()?.end_ts).toBeNull()
  })

  it('startup replay from disk equals the live feed', async () => {
    const rows = bandRows()
    await store.init(rows[0]!.ts)
    const live = new PhaseLog(store, DEFAULTS, () => undefined)
    await live.init(rows[0]!.ts)
    await feedAll(live, rows)
    const liveList = live.list(100)

    const restarted = new PhaseLog(store, DEFAULTS, () => undefined)
    await restarted.init(rows[rows.length - 1]!.ts + MIN)
    expect(restarted.list(100)).toEqual(liveList)
  })

  it('replay rebuilds a pending candidate across a mid-phase restart', async () => {
    // She is under way, then stops - but the plugin restarts while the stop is
    // still a pending candidate (6 min held, under the 10 min minimum). Replay
    // must reconstruct that candidate so the eventual phase is back-dated to
    // where she actually stopped, not to the restart.
    const t0 = Date.UTC(2026, 5, 1, 8, 0, 0)
    const mk = (m: number, sog: number, nav: string): VoyageRow => ({
      ts: t0 + m * MIN,
      lat: 43,
      lon: 7,
      sog,
      nav_state: nav,
      path_values: undefined
    })
    const rows: VoyageRow[] = []
    for (let m = 0; m <= 5; m++) rows.push(mk(m, 3, 'under way using engine'))
    for (let m = 6; m <= 20; m++) rows.push(mk(m, 0, 'at anchor')) // stops at 6, confirms at 16

    await store.init(rows[0]!.ts)
    // Feed only through minute 12: candidate stopped has held 6 min, not a phase yet.
    const before = new PhaseLog(store, DEFAULTS, () => undefined)
    await before.init(rows[0]!.ts)
    await feedAll(before, rows.filter((r) => r.ts <= t0 + 12 * MIN))
    expect(before.current()?.kind).toBe('underway') // still under way, candidate pending

    // Restart from disk, then feed the rest. Without replay of the pending
    // candidate, the stop would restart its clock here and never confirm by t=20.
    const after = new PhaseLog(store, DEFAULTS, () => undefined)
    await after.init(t0 + 12 * MIN + MIN)
    await feedAll(after, rows.filter((r) => r.ts > t0 + 12 * MIN))

    const closed = after.list(100).filter((p) => p.end_ts !== null)
    expect(closed.map((p) => p.kind)).toEqual(['underway'])
    expect(closed[0]!.end_ts).toBe(t0 + 6 * MIN) // back-dated across the restart
    expect(after.current()?.kind).toBe('anchored')
  })

  it('persists and restores an open phase with no closed ones', async () => {
    const t0 = Date.UTC(2026, 5, 1, 8, 0, 0)
    const rows: VoyageRow[] = []
    for (let m = 0; m <= 30; m++) {
      rows.push({ ts: t0 + m * MIN, lat: 43, lon: 7, sog: 0, nav_state: 'moored', path_values: undefined })
    }
    await store.init(rows[0]!.ts)
    const pl = new PhaseLog(store, DEFAULTS, () => undefined)
    await pl.init(rows[0]!.ts)
    await feedAll(pl, rows)

    const restarted = new PhaseLog(store, DEFAULTS, () => undefined)
    await restarted.init(rows[rows.length - 1]!.ts + MIN)
    expect(restarted.current()?.kind).toBe('moored')
    expect(restarted.list(100)).toEqual(pl.list(100))
  })
})
