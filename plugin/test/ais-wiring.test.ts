import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestDeps } from '../src/rest'

/**
 * Whether the plugin actually asks the model about AIS, and remembers the answer.
 *
 * The parts are proved next door: ais-receiver.test.ts knows what counts as a sighting and
 * what the file does with one. None of that can see whether index.ts ever calls either of
 * them - a memory that is built and never noted compiles, ships, and leaves every boat
 * looking like one with no receiver, which is exactly the switch this work exists to draw.
 *
 * So this starts the real plugin against a fake server whose model can be changed between
 * runs, and asks /health what it says about her AIS.
 */

interface Plugin {
  start(config: object, restart?: (c: object) => void): void
  stop(): void | Promise<void>
}

let rest: RestDeps | null = null

vi.mock('../src/rest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rest')>()
  return {
    ...actual,
    setRestDeps: (deps: RestDeps | null) => {
      if (deps) rest = deps
      actual.setRestDeps(deps)
    }
  }
})

/** The vessels dictionary the fake server hands out, swapped between runs. */
let model: Record<string, unknown> = {}

function fakeApp(dataDir: string) {
  return {
    getDataDirPath: () => dataDir,
    getSelfPath: () => undefined,
    getPath: (p: string) => (p === 'vessels' ? model : undefined),
    selfContext: 'vessels.urn:mrn:signalk:uuid:self',
    selfId: 'urn:mrn:signalk:uuid:self',
    savePluginOptions: (_o: object, cb: (e?: unknown) => void) => cb(),
    setPluginStatus: () => undefined,
    setPluginError: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    streambundle: { getAvailablePaths: () => [] },
    subscriptionmanager: {
      subscribe: (_cmd: unknown, unsubscribes: Array<() => void>) => {
        unsubscribes.push(() => undefined)
      }
    }
  }
}

let dir: string
let plugin: Plugin | null = null

/** One run of the plugin, from start to the health answer. */
async function runOnce(): Promise<{ receiver_seen: boolean; first_seen_ts: number | null }> {
  const mod = (await import('../src/index')) as unknown as { default: (app: unknown) => Plugin }
  rest = null
  plugin = mod.default(fakeApp(dir))
  plugin.start({ snapshotSeconds: 60 })
  const deadline = Date.now() + 4000
  while (rest === null) {
    if (Date.now() > deadline) throw new Error('the plugin never registered its REST deps')
    await new Promise((r) => setTimeout(r, 5))
  }
  const health = (await rest.health()) as { ais: { receiver_seen: boolean; first_seen_ts: number | null } }
  return health.ais
}

beforeEach(async () => {
  rest = null
  model = {}
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-ais-wiring-'))
})

afterEach(async () => {
  await plugin?.stop()
  plugin = null
  await fs.rm(dir, { recursive: true, force: true })
})

describe('what the plugin says about her AIS', () => {
  it('reports no receiver on a boat that has never seen a target', async () => {
    model = { 'urn:mrn:signalk:uuid:self': { navigation: {} } }
    expect(await runOnce()).toEqual({ receiver_seen: false, first_seen_ts: null })
  })

  it('reports one the moment a target is in the model', async () => {
    model = {
      'urn:mrn:signalk:uuid:self': { navigation: {} },
      'urn:mrn:imo:mmsi:222222222': { navigation: {} }
    }
    const seen = await runOnce()
    expect(seen.receiver_seen).toBe(true)
    expect(seen.first_seen_ts).toBeGreaterThan(0)
  })

  it('still reports one after the horizon empties, which is why it is written down', async () => {
    // A boat alone at sea has an empty model and a receiver, and the chart must keep
    // offering the switch to her. Signal K forgets the traffic on restart; the boat does not.
    model = {
      'urn:mrn:signalk:uuid:self': { navigation: {} },
      'urn:mrn:imo:mmsi:222222222': { navigation: {} }
    }
    const first = await runOnce()
    expect(first.receiver_seen).toBe(true)
    await plugin?.stop()

    model = { 'urn:mrn:signalk:uuid:self': { navigation: {} } }
    expect(await runOnce()).toEqual(first)
  })
})
