/**
 * The gazetteer, and the voyage list it names.
 *
 * Three claims. The lookup answers the nearest place and only within its radius, across
 * the date line as well as beside it. A voyage whose ends no configured port named is named
 * from the gazetteer when it is read, and not written back, so the record stays a position.
 * And a configured port still wins where it reaches, because the owner's own word for a
 * place beats a gazetteer's.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULTS } from '../src/config'
import { Snapshot } from '../src/contract'
import { Gazetteer, PLACES_FILE, PlaceResolver } from '../src/places'
import { Store } from '../src/store'
import { VoyageRow } from '../src/voyage'
import { VoyageLog } from '../src/voyagelog'

/** A small coast: two towns and a cove a mile apart on the Skagerrak, and one far away. */
const COAST = JSON.stringify({
  places: [
    [58.34, 8.59, 'Grimstad'],
    [58.335, 8.6, 'Groos Bay', 1],
    [58.36, 8.62, 'Vik', 2],
    [58.25, 8.38, 'Lillesand'],
    [58.3, 8.5, 'Homborsund'],
    [58.2, 8.6, 'Open Cove', 1],
    [60.39, 5.32, 'Bergen'],
    [51.0, 179.99, 'West of the line'],
    [52.0, -179.99, 'East of the line'],
    [58.2, 8.3, 'Marked land', 0],
    ['not', 'a', 'row'],
    [91, 0, 'off the globe'],
    [58.2, 8.9, 'Unknown kind', 7]
  ]
})

describe('Gazetteer', () => {
  const g = Gazetteer.parse(COAST)

  it('drops rows that are not a position and a name, or carry a kind it does not know', () => {
    expect(g.size).toBe(10)
    expect(g.nearest(58.2, 8.3)).toBe('Marked land')
    expect(g.nearest(58.2, 8.9)).toBeNull()
  })

  it('names the town over the bay it stands on, and the bay where there is no town', () => {
    // Moored in Grimstad: the bay's mark is the nearer point, the town is the answer.
    expect(g.nearest(58.336, 8.6)).toBe('Grimstad')
    // Off the hamlet with the town a mile and a half beyond: the hamlet is named.
    expect(g.nearest(58.362, 8.622)).toBe('Vik')
    // Between the two, a shade nearer the hamlet: the town carries it on the handicap.
    expect(g.nearest(58.351, 8.606)).toBe('Grimstad')
    // Anchored out with nothing else near: the cove is named.
    expect(g.nearest(58.205, 8.6)).toBe('Open Cove')
    // Two and a half miles off the cove, the nearest town four and a half: both are in
    // range, and the cove wins on distance even with its handicap.
    expect(g.nearest(58.24, 8.58)).toBe('Open Cove')
  })

  it('answers the nearest place within the radius', () => {
    expect(g.nearest(58.33, 8.6)).toBe('Grimstad')
    expect(g.nearest(58.26, 8.4)).toBe('Lillesand')
    expect(g.nearest(58.295, 8.505)).toBe('Homborsund')
  })

  it('declines beyond the radius rather than naming the nearest far place', () => {
    // Open sea, 20 miles south of the coast: a coordinate is the honest answer there.
    expect(g.nearest(58.0, 8.5)).toBeNull()
    // Just inside and just outside five miles of Bergen, due north along the meridian.
    expect(g.nearest(60.39 + 4.9 / 60, 5.32)).toBe('Bergen')
    expect(g.nearest(60.39 + 5.1 / 60, 5.32)).toBeNull()
  })

  it('reaches across the date line', () => {
    // Each query stands on the far side of the line from the only place in its latitude.
    expect(g.nearest(51.0, -179.995)).toBe('West of the line')
    expect(g.nearest(52.0, 179.995)).toBe('East of the line')
  })

  it('reads nothing from a file that is not there, and says so', () => {
    const said: string[] = []
    expect(Gazetteer.fromFile('/nowhere/places.json', (m) => said.push(m))).toBeNull()
    expect(said[0]).toContain('/nowhere/places.json')
  })

  it('reads nothing from a file that is present but broken or empty, and says so', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-gaz-'))
    try {
      // A truncated install: the gzip header and then not the rest of it.
      const broken = path.join(dir, 'broken.json.gz')
      await fs.writeFile(broken, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from('not a gzip body')]))
      const said: string[] = []
      expect(Gazetteer.fromFile(broken, (m) => said.push(m))).toBeNull()
      expect(said[0]).toContain('not loaded')

      const empty = path.join(dir, 'empty.json.gz')
      await fs.writeFile(empty, gzipSync(JSON.stringify({ places: [] })))
      said.length = 0
      expect(Gazetteer.fromFile(empty, (m) => said.push(m))).toBeNull()
      expect(said[0]).toContain('no places')

      // Loaded lazily: nothing is read until a position is asked about, and a file that
      // fails is not read twice.
      said.length = 0
      const resolver = Gazetteer.lazy(broken, (m) => said.push(m))
      expect(said).toEqual([])
      expect(resolver(58.3, 8.6)).toBeNull()
      expect(resolver(58.3, 8.6)).toBeNull()
      expect(said).toHaveLength(1)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('ships with the package, and knows a harbour on each coast it claims to cover', () => {
    const g = Gazetteer.fromFile(PLACES_FILE)
    expect(g).not.toBeNull()
    expect(g!.size).toBeGreaterThan(200_000)
    // One Norwegian town, one Mediterranean harbour, one across the Atlantic.
    expect(g!.nearest(58.3405, 8.5934)).toBe('Grimstad')
    expect(g!.nearest(43.2951, 5.3741)).toBe('Old Port of Marseille')
    expect(g!.nearest(41.4802, -71.3127)).toBe('Newport On-Shore Marina')
  })
})

/** A dozen minutes under way, starting off one town and heading for the next. */
function passage(): VoyageRow[] {
  const t0 = Date.UTC(2026, 5, 1, 8, 0, 0)
  const rows: VoyageRow[] = []
  for (let i = 0; i < 12; i++) {
    rows.push({
      ts: t0 + i * 60_000,
      lat: 58.33 - i * 0.002,
      lon: 8.6 - i * 0.004,
      sog: 3.1,
      nav_state: 'under way using engine',
      path_values: {}
    })
  }
  return rows
}

/** The same passage carried on to the cove off Homborsund and brought to a stop there. */
function passageAndStop(): VoyageRow[] {
  const rows = passage()
  const last = rows[rows.length - 1]!
  for (let i = 1; i <= 8; i++) {
    rows.push({
      ts: last.ts + i * 60_000,
      lat: 58.302,
      lon: 8.51,
      sog: 0,
      nav_state: 'anchored',
      path_values: {}
    })
  }
  return rows
}

describe('VoyageLog with a gazetteer', () => {
  let dir: string
  let store: Store
  const resolver: PlaceResolver = Gazetteer.parse(COAST).resolver()

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-places-'))
    store = new Store(dir, 100 * 1024 * 1024, () => undefined)
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  async function feed(rows: VoyageRow[], vlog: VoyageLog): Promise<void> {
    for (const r of rows) {
      await store.append(r as Snapshot)
      await vlog.feed(r as Snapshot)
    }
    await vlog.flush()
  }

  it('names the start from the gazetteer when no configured port did, and leaves the record alone', async () => {
    const rows = passage()
    await store.init(rows[0]!.ts)
    const vlog = new VoyageLog(store, DEFAULTS, () => undefined, resolver)
    await vlog.init(rows[0]!.ts)
    await feed(rows, vlog)

    const [v] = vlog.list(1)
    expect(v?.status).toBe('open')
    expect(v?.start_port).toBe('Grimstad')
    expect(vlog.current()?.start_port).toBe('Grimstad')
    // Still going there: an open voyage's end is not named.
    expect(v?.end_port).toBeNull()

    const persisted = JSON.parse(await fs.readFile(path.join(store.rollupDir, 'voyages.json'), 'utf8'))
    expect(persisted.voyages[0].start_port).toBeNull()
  })

  it('names both ends once the voyage has closed', async () => {
    const rows = passageAndStop()
    await store.init(rows[0]!.ts)
    const vlog = new VoyageLog(store, DEFAULTS, () => undefined, resolver)
    await vlog.init(rows[0]!.ts)
    await feed(rows, vlog)
    const [v] = vlog.list(1)
    expect(v?.status).toBe('closed')
    expect(v?.start_port).toBe('Grimstad')
    expect(v?.end_port).toBe('Homborsund')
    expect(vlog.current()).toBeNull()
  })

  it('names an old passage after a port configured later, ahead of the gazetteer', async () => {
    const rows = passage()
    await store.init(rows[0]!.ts)
    const first = new VoyageLog(store, DEFAULTS, () => undefined, resolver)
    await first.init(rows[0]!.ts)
    await feed(rows, first)
    expect(first.list(1)[0]?.start_port).toBe('Grimstad')

    // The owner names the berth after the season. The record on disk still says null.
    const opts = { ...DEFAULTS, ports: [{ name: 'Home berth', latitude: 58.33, longitude: 8.6, radiusNm: 1 }] }
    const later = new VoyageLog(store, opts, () => undefined, resolver)
    await later.init(rows[rows.length - 1]!.ts + 60_000)
    expect(later.list(1)[0]?.start_port).toBe('Home berth')
  })

  it('lets a configured port win where it reaches', async () => {
    const rows = passage()
    await store.init(rows[0]!.ts)
    const opts = { ...DEFAULTS, ports: [{ name: 'Home berth', latitude: 58.33, longitude: 8.6, radiusNm: 1 }] }
    const vlog = new VoyageLog(store, opts, () => undefined, resolver)
    await vlog.init(rows[0]!.ts)
    await feed(rows, vlog)
    expect(vlog.list(1)[0]?.start_port).toBe('Home berth')
  })

  it('writes a position and nothing else without a gazetteer, as before', async () => {
    const rows = passage()
    await store.init(rows[0]!.ts)
    const vlog = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog.init(rows[0]!.ts)
    await feed(rows, vlog)
    const [v] = vlog.list(1)
    expect(v?.start_port).toBeNull()
    expect(v?.start_lat).toBeCloseTo(58.33, 3)
  })
})
