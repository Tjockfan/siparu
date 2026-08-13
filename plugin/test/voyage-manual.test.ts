/**
 * Voyages an owner edited by hand, and the automatic pass that must leave them alone.
 *
 * The engine reconciles on every appended snapshot, so a decision made in the webapp
 * competes with one made by the thresholds a second later. These tests pin who wins.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/config'
import { Snapshot, Voyage } from '../src/contract'
import { Store } from '../src/store'
import { VoyageRow, mergeContiguousVoyages } from '../src/voyage'
import { VoyageLog } from '../src/voyagelog'

/** Two legs that the automatic pass would join: 5 minutes apart, no hop, the second short. */
function joinable(): Voyage[] {
  const t0 = Date.UTC(2026, 6, 24, 8, 0)
  const leg = (id: number, startMin: number, endMin: number, distance: number): Voyage => ({
    id,
    start_ts: t0 + startMin * 60_000,
    end_ts: t0 + endMin * 60_000,
    start_lat: 43.5,
    start_lon: 7.0,
    end_lat: 43.5,
    end_lon: 7.0,
    distance_nm: distance,
    hours_underway: (endMin - startMin) / 60,
    avg_sog_kn: 5,
    max_sog_kn: 7,
    fuel_used_l: null,
    start_port: null,
    end_port: null,
    status: 'closed'
  })
  return [leg(1, 0, 60, 12), leg(2, 65, 75, 0.4)]
}

const noop = async () => undefined

describe('the automatic merge pass and a hand-made decision', () => {
  it('joins two legs that meet the thresholds, which is the behaviour being protected', () => {
    // Reads as a precondition rather than a test of its own: every case below is
    // this same pair, and if it stopped merging on its own the exemptions would
    // all pass while proving nothing.
    return mergeContiguousVoyages(joinable(), DEFAULTS.voyage, noop).then((out) => {
      expect(out).toHaveLength(1)
      expect(out[0]!.id).toBe(1)
      expect(out[0]!.end_ts).toBe(joinable()[1]!.end_ts)
    })
  })

  it('leaves the pair alone when the owner has set the second one himself', async () => {
    // Two voyages he put back apart sit at a gap of zero and a hop of zero, which
    // is the strongest case the automatic test knows. Without this they would be
    // rejoined on the next snapshot, and he would watch his edit undo itself.
    const out = await mergeContiguousVoyages(joinable(), DEFAULTS.voyage, noop, new Set([2]))
    expect(out.map((v) => v.id)).toEqual([1, 2])
  })

  it('leaves it alone when the mark is on the first one, because a merge changes both', async () => {
    const out = await mergeContiguousVoyages(joinable(), DEFAULTS.voyage, noop, new Set([1]))
    expect(out.map((v) => v.id)).toEqual([1, 2])
  })

  it('still merges an unmarked pair on a boat that has marked something else', async () => {
    // The exemption is per voyage, not a switch that turns the pass off.
    const out = await mergeContiguousVoyages(joinable(), DEFAULTS.voyage, noop, new Set([99]))
    expect(out).toHaveLength(1)
  })
})

/**
 * Three legs on one afternoon, built minute by minute so the state machine opens and
 * closes them itself rather than being handed voyages that never came off a boat.
 *
 * The gaps are chosen: A to B is an hour, past the 45 minutes the automatic pass
 * will bridge, so those two stay separate until somebody says otherwise. B to C is
 * ten minutes and C is a few hundred metres, which is exactly what the pass is for.
 * That makes C the trap: once A has swallowed B by hand, the grown voyage ends ten
 * minutes before C starts, and without a mark the boat would help itself to C on the
 * next snapshot.
 */
function leg(rows: VoyageRow[], from: number, minutes: number, moving: boolean, lat: number): number {
  for (let i = 0; i < minutes; i++) {
    rows.push({
      ts: from + i * 60_000,
      lat: moving ? lat + i * 0.002 : lat,
      lon: 7.0,
      sog: moving ? 2.6 : 0,
      nav_state: moving ? 'under way using engine' : 'moored',
      path_values: {}
    })
  }
  return from + minutes * 60_000
}

function afternoon(): VoyageRow[] {
  const rows: VoyageRow[] = []
  let t = Date.UTC(2026, 6, 24, 8, 0)
  t = leg(rows, t, 60, true, 43.5) // A: an hour under way
  t = leg(rows, t, 60, false, 43.62) // lying still for an hour: too long to bridge
  t = leg(rows, t, 20, true, 43.62) // B
  t = leg(rows, t, 10, false, 43.66) // a ten minute stop: the pass would bridge this
  t = leg(rows, t, 6, true, 43.66) // C, under the mile the pass calls a manoeuvre
  leg(rows, t, 10, false, 43.672) // and still again, so C closes
  return rows
}

/** The last row before C gets under way, with B closed behind it. */
const BEFORE_C = Date.UTC(2026, 6, 24, 10, 28)

const asSnapshot = (r: VoyageRow): Snapshot => ({ ...r }) as Snapshot

describe('editing a voyage by hand, on the boat', () => {
  let dir: string
  let store: Store
  let vlog: VoyageLog
  let rows: VoyageRow[]
  let now: number

  /** Feed the afternoon in, minute by minute, exactly as the plugin does. */
  async function sail(upTo?: number): Promise<void> {
    for (const r of rows.slice(0, upTo)) {
      await store.append(asSnapshot(r))
      await vlog.feed(asSnapshot(r))
    }
    await vlog.flush()
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-manual-'))
    store = new Store(dir, 100 * 1024 * 1024, () => undefined)
    rows = afternoon()
    now = (rows[rows.length - 1] as VoyageRow).ts + 60_000
    await store.init((rows[0] as VoyageRow).ts)
    vlog = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog.init((rows[0] as VoyageRow).ts)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('leaves the hour-long stop unbridged on its own, which is what makes the edit worth having', async () => {
    await sail()
    const list = vlog.list(50)
    // B and C came in as one, which is the pass working. A stayed separate.
    expect(list).toHaveLength(2)
    expect(list.every((v) => v.status === 'closed')).toBe(true)
  })

  it('folds a voyage into the one before it and re-integrates the whole span', async () => {
    await sail()
    const [second, first] = [vlog.list(50)[0]!, vlog.list(50)[1]!]
    const before = { start: first.start_ts, distance: first.distance_nm, hours: first.hours_underway }

    const res = await vlog.mergeWithPrevious(second.id, now)
    expect(res).toEqual({ ok: true, id: first.id })

    const merged = vlog.list(50);
    expect(merged).toHaveLength(1)
    const m = merged[0]!
    expect(m.id).toBe(first.id)
    // Named by where it began, ending where the later one did.
    expect(m.start_ts).toBe(before.start)
    expect(m.end_ts).toBe(second.end_ts)
    expect(m.distance_nm).toBeGreaterThan(before.distance)
    // The hour lying still between the legs is in the span and adds no time under
    // way: this is re-integrated, not added up.
    expect(m.hours_underway).toBeLessThan(before.hours + second.hours_underway + 0.02)
  })

  it('does not let the grown voyage help itself to what comes next', async () => {
    // THE TRAP. Merge before the last leg exists, then sail it. The merged voyage
    // now ends ten minutes before C starts, at no distance at all, and C is short:
    // every threshold the automatic pass has says join them. The mark is the only
    // thing that says no, and without it the owner watches his passage grow a leg
    // he did not put there.
    const beforeC = rows.findIndex((r) => r.ts >= BEFORE_C)
    await sail(beforeC)
    const list = vlog.list(50)
    expect(list.length).toBeGreaterThanOrEqual(2)
    await vlog.mergeWithPrevious(list[0]!.id, now)
    expect(vlog.list(50)).toHaveLength(1)
    const mergedEnd = vlog.list(50)[0]!.end_ts

    for (const r of rows.slice(beforeC)) {
      await store.append(asSnapshot(r))
      await vlog.feed(asSnapshot(r))
    }
    await vlog.flush()

    const after = vlog.list(50)
    expect(after).toHaveLength(2)
    expect(after.find((v) => v.end_ts === mergedEnd)).toBeDefined()
  })

  it('puts a merged voyage back, first part keeping its number', async () => {
    await sail()
    const [second, first] = [vlog.list(50)[0]!, vlog.list(50)[1]!]
    const originals = [first, second].map((v) => ({ start: v.start_ts, end: v.end_ts, d: v.distance_nm }))

    await vlog.mergeWithPrevious(second.id, now)
    expect(vlog.edits().merged).toEqual([first.id])

    const undone = await vlog.undoMerge(first.id, now)
    expect(undone).toEqual({ ok: true, id: first.id })

    const back = vlog.list(50).sort((a, b) => a.start_ts - b.start_ts)
    expect(back).toHaveLength(2)
    expect(back[0]!.id).toBe(first.id)
    expect(back.map((v) => ({ start: v.start_ts, end: v.end_ts, d: v.distance_nm }))).toEqual(originals)
    // Nothing left to undo, and both halves stay marked so the pass keeps its hands off.
    expect(vlog.edits().merged).toEqual([])
  })

  it('survives a restart with the marks intact', async () => {
    await sail()
    const [second, first] = [vlog.list(50)[0]!, vlog.list(50)[1]!]
    await vlog.mergeWithPrevious(second.id, now)

    const reopened = new VoyageLog(store, DEFAULTS, () => undefined)
    await reopened.init(now)
    expect(reopened.list(50)).toHaveLength(1)
    expect(reopened.edits().merged).toEqual([first.id])
    // And the edit is still reversible after the boat has been switched off.
    expect(await reopened.undoMerge(first.id, now)).toEqual({ ok: true, id: first.id })
    expect(reopened.list(50)).toHaveLength(2)
  })

  it('refuses what it cannot do, and says which', async () => {
    await sail()
    const list = vlog.list(50).sort((a, b) => a.start_ts - b.start_ts)
    expect(await vlog.mergeWithPrevious(9999, now)).toEqual({ ok: false, error: 'not_found' })
    // The earliest voyage has nothing before it.
    expect(await vlog.mergeWithPrevious(list[0]!.id, now)).toEqual({ ok: false, error: 'no_previous' })
    expect(await vlog.undoMerge(list[0]!.id, now)).toEqual({ ok: false, error: 'nothing_to_undo' })
  })

  it('will not merge a voyage that is still being written', async () => {
    // Fed only up to the middle of the last leg, so it is open: its end does not
    // exist yet, and the state machine is still deciding where it goes.
    await sail(rows.length - 10)
    const open = vlog.current()
    expect(open).not.toBeNull()
    expect(await vlog.mergeWithPrevious(open!.id, now)).toEqual({ ok: false, error: 'voyage_open' })
  })

  it('reads a voyages.json written before hand edits existed', async () => {
    // Every boat upgrading into this has one. No marks, so nothing is exempt.
    await sail()
    const file = path.join(store.rollupDir, 'voyages.json')
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    delete parsed.manual
    await fs.writeFile(file, JSON.stringify(parsed))

    const reopened = new VoyageLog(store, DEFAULTS, () => undefined)
    await reopened.init(now)
    expect(reopened.edits().merged).toEqual([])
    expect(reopened.list(50)).toHaveLength(2)
  })
})
