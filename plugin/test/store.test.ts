import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Snapshot } from '../src/contract'
import { Store, parseNdjson } from '../src/store'

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

function snap(ts: number, sog = 3): Snapshot {
  return { ts, sog, lat: 43.0, lon: 6.0 } as unknown as Snapshot
}

let dir: string
let store: Store

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-test-'))
  store = new Store(dir, 1024 * 1024, () => undefined)
  await store.init(T0)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('NDJSON writer', () => {
  it('appends to a file named after the UTC hour', async () => {
    await store.append(snap(T0))
    await store.append(snap(T0 + 60_000))
    await store.flush()
    const rows = await store.readRaw('2026-01-15T12')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.ts).toBe(T0)
  })

  it('fires onHourClosed exactly when the hour rolls over', async () => {
    const closed: string[] = []
    store.onHourClosed = async (h) => {
      closed.push(h)
    }
    await store.append(snap(T0))
    await store.append(snap(T0 + 3_600_000)) // 13:00
    await store.flush()
    expect(closed).toEqual(['2026-01-15T12'])
    expect(await store.listRawKeys()).toEqual(['2026-01-15T12', '2026-01-15T13'])
  })

  it('skips corrupt lines (torn write) when reading', async () => {
    await store.append(snap(T0))
    await store.flush()
    await fs.appendFile(store.rawPath('2026-01-15T12'), '{"ts": 123, "sog"\n')
    await store.append(snap(T0 + 60_000))
    await store.flush()
    const rows = await store.readRaw('2026-01-15T12')
    expect(rows).toHaveLength(2)
  })
})

describe('disk cap', () => {
  it('prunes oldest files first and never touches the open hour', async () => {
    // three hour files ~ equal size; cap small enough to keep only the newest
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < 50; i++) {
        await store.append(snap(T0 + h * 3_600_000 + i * 60_000))
      }
    }
    await store.flush()
    const usage = await store.rawUsage()
    const capForOne = Math.floor(usage.bytes / 3) + 100
    const tight = new Store(dir, capForOne, () => undefined)
    await tight.init(T0 + 2 * 3_600_000) // current hour = 14
    const deleted = await tight.enforceCap()
    expect(deleted).toBeGreaterThanOrEqual(1)
    const left = await tight.listRawKeys()
    expect(left).toContain('2026-01-15T14') // open hour survives even over cap
    expect(left[0]).not.toBe('2026-01-15T12') // oldest went first
  })
})

describe('disk cap with a backwards clock', () => {
  it('skips (not stops at) the open hour when newer files exist', async () => {
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < 20; i++) {
        await store.append(snap(T0 + h * 3_600_000 + i * 60_000))
      }
    }
    await store.flush()
    // clock jumped back: open hour is 13, but a "future" 14 file exists
    const tight = new Store(dir, 100, () => undefined)
    await tight.init(T0 + 3_600_000)
    await tight.enforceCap()
    expect(await tight.listRawKeys()).toEqual(['2026-01-15T13'])
  })
})

describe('a disk that refuses the row', () => {
  // A card remounted read-only, a full partition, an I/O fault: the append used to resolve as
  // if the row were on disk, and the plugin said "Recording" over a hole for months.
  it('answers false, remembers the refusal, and goes on trying', async () => {
    await store.append(snap(T0))
    await store.flush()
    // The next hour's file cannot be created because a directory already stands in its place.
    // The refusal comes from the path rather than from a permission bit on purpose: the armv7
    // CI job runs this suite as root inside a container, and root writes straight through a
    // read-only mode as if it were unset, so a chmod here proves nothing there.
    const blocked = store.rawPath('2026-01-15T13')
    await fs.mkdir(blocked)
    try {
      expect(await store.append(snap(T0 + 3_600_000))).toBe(false)
      const refused = store.writes()
      expect(refused.ok).toBe(false)
      expect(refused.failures).toBe(1)
      expect(refused.last_error).toContain('EISDIR')
    } finally {
      await fs.rmdir(blocked)
    }
    // The disk comes back: the next row lands, the verdict follows it, the count stays.
    expect(await store.append(snap(T0 + 3_660_000))).toBe(true)
    expect(store.writes()).toEqual({ ok: true, failures: 1, last_error: expect.stringContaining('EISDIR') })
    expect(await store.readRaw('2026-01-15T13')).toHaveLength(1)
  })

  it('still closes the hour when the append failed, so the cap can run on a full card', async () => {
    const closed: string[] = []
    store.onHourClosed = async (h) => {
      closed.push(h)
    }
    await store.append(snap(T0))
    await store.flush()
    const blocked = store.rawPath('2026-01-15T13')
    await fs.mkdir(blocked)
    try {
      expect(await store.append(snap(T0 + 3_600_000))).toBe(false)
    } finally {
      await fs.rmdir(blocked)
    }
    expect(closed).toEqual(['2026-01-15T12'])
  })
})

describe('parseNdjson', () => {
  it('ignores blank and broken lines', () => {
    const rows = parseNdjson<{ a: number }>('{"a":1}\n\nnot json\n{"a":2}\n')
    expect(rows).toEqual([{ a: 1 }, { a: 2 }])
  })
})
