import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestDeps } from '../src/rest'
import type { SealerDeps } from '../src/sealer'

/**
 * The wiring in index.ts, which nothing else watches.
 *
 * Everything the sealer decides is proved next door, against a device list handed to it by a
 * test. What none of that can see is whether the plugin hands it the REAL list, or the real
 * latch: `latched: () => false` compiles, ships, and turns every case in sealer.test.ts into
 * a statement about a boat that does not exist. The one field the compiler catches is a
 * missing one.
 *
 * So this starts the actual plugin against a fake server and a fake shore, takes the
 * dependencies it built for the sealer, and asks them what they answer as the shore's answer
 * changes. It measures the seam rather than the parts.
 */

let captured: SealerDeps | null = null
/** The dependencies the plugin hands the REST layer, so /health can be asked for real. */
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

vi.mock('../src/sealer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sealer')>()
  class Watched extends actual.Sealer {
    constructor(deps: SealerDeps) {
      super(deps)
      captured = deps
    }
  }
  return { ...actual, Sealer: Watched }
})

interface Plugin {
  start(config: object, restart?: (c: object) => void): void
  stop(): void | Promise<void>
}

async function loadFactory() {
  const mod = (await import('../src/index')) as unknown as { default: (app: unknown) => Plugin }
  return mod.default
}

function fakeApp(dataDir: string) {
  return {
    getDataDirPath: () => dataDir,
    getSelfPath: () => undefined,
    getPath: () => ({}),
    selfContext: 'vessels.self',
    selfId: 'urn:mrn:imo:mmsi:000000000',
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

/** The committed strings each key must print as, so this file computes none of them itself. */
const vectors = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'dev', 'e2e-vectors', 'fingerprint-vectors.json'), 'utf8')
) as { cases: { public: string; fingerprint: string }[] }

/** The shore's answer to the key poll, swapped between assertions. */
let devices: unknown[] = []
let polls = 0

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the plugin')
    await new Promise((r) => setTimeout(r, 5))
  }
}

let dir: string
let plugin: Plugin | null = null

beforeEach(async () => {
  captured = null
  rest = null
  devices = []
  polls = 0
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-wiring-'))
  // She has to be paired for the key poll to run at all, and the token is never used: the
  // fetch below answers whatever it is asked.
  await fs.mkdir(path.join(dir, 'x'), { recursive: true })
  await fs.writeFile(
    path.join(dir, 'remote.json'),
    JSON.stringify({
      remote: {
        boatId: 'boat-wiring',
        boatToken: 'tok',
        pairedEmail: null,
        pairedAt: '2026-07-30T00:00:00.000Z'
      }
    }),
    { mode: 0o600 }
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/keys')) {
        polls++
        return new Response(JSON.stringify({ keys: 'ok', devices }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
  )
})

afterEach(async () => {
  await plugin?.stop()
  plugin = null
  vi.unstubAllGlobals()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('what the plugin actually hands the sealer', () => {
  /**
   * One run of the plugin, from start to stop, with the shore saying a given thing.
   *
   * A restart per step rather than a wait per step, because the key poll runs on the interval
   * the product ships with - five minutes - and asks once immediately. A restart is also what
   * really happens here: Signal K restarts a plugin on every config save.
   */
  async function runOnce(): Promise<SealerDeps> {
    const factory = await loadFactory()
    captured = null
    polls = 0
    plugin = factory(fakeApp(dir))
    plugin.start({ relayUrl: 'http://relay.invalid', snapshotSeconds: 60 })
    await until(() => captured !== null && polls > 0)
    const deps = captured
    if (!deps) throw new Error('the plugin built no sealer')
    return deps
  }

  it('gives it the live device list and the live latch, not a constant', async () => {
    const phone = { kid: 'kid-phone', pub: 'A'.repeat(43) }

    // A boat nobody has authorised: no screens, and nothing she can seal to.
    let deps = await runOnce()
    expect(deps.devices()).toEqual([])
    expect(deps.latched()).toBe(false)
    // The boat she signs as is the one she is paired to, not a placeholder.
    expect(deps.boatId()).toBe('boat-wiring')
    await plugin?.stop()

    // The shore names a screen. Both answers move, and they come from different places: one
    // is the list off the wire, the other is the promise that list sets.
    devices = [phone]
    deps = await runOnce()
    await until(() => deps.devices().length > 0)
    expect(deps.devices()).toEqual([phone])
    expect(deps.latched()).toBe(true)
    await plugin?.stop()

    // And the shore takes it back. The list empties and her memory of having been told does
    // not, which is what lets her say WHICH silence this is: screens she had, now gone.
    devices = []
    deps = await runOnce()
    expect(deps.devices()).toEqual([])
    expect(deps.latched()).toBe(true)

    // And she says so where a person can read it. A boat sealing to nobody sends nothing,
    // which looks from ashore exactly like one whose link is down - so the answer to "why
    // has she gone quiet" has to exist somewhere other than a debug log.
    const health = await rest?.health()
    expect(health?.sealing).toEqual({
      devices: 0,
      mode: expect.any(String),
      reason: health?.sealing.mode === 'blocked' ? expect.any(String) : null,
      screens: []
    })
  })

  /**
   * The fingerprints on the boat's own screen come from the list she is really sealing to.
   *
   * The comparison an owner makes aboard is only worth making if this screen reads the same
   * bytes the sealer does. A fingerprint computed from anything else - a copy of the list, a
   * cached row, the key she published for herself - would agree with his phone on a boat that
   * was under attack, which is the one case it exists for.
   *
   * The expected strings are the committed vectors rather than a call to the shipping
   * function, so this cannot pass by computing the same wrong answer twice.
   */
  it('names the screens she seals to, by the fingerprint of the key she got', async () => {
    const [phone, tablet] = vectors.cases
    devices = [
      { kid: 'kid-phone', pub: phone.public },
      { kid: 'kid-tablet', pub: tablet.public }
    ]
    const deps = await runOnce()
    await until(() => deps.devices().length === 2)

    const health = await rest?.health()
    expect(health?.sealing.screens).toEqual([phone.fingerprint, tablet.fingerprint])
    expect(health?.sealing.devices).toBe(2)
  })

  /**
   * A row the shore sent that will not decode is left out rather than shown.
   *
   * She goes on sealing to the keys that are usable, and the count and the list disagree by
   * one. That disagreement is the honest report: an owner comparing his phone against this
   * list is asking which keys can read her, and a placeholder for a key that cannot would be
   * a line he has to rule out.
   */
  it('leaves out a key it cannot read, and keeps the rest', async () => {
    const [phone] = vectors.cases
    devices = [
      { kid: 'kid-phone', pub: phone.public },
      // The shape the shore's reader lets through: the right alphabet, the right length.
      { kid: 'kid-broken', pub: `${'A'.repeat(42)}=` }
    ]
    const deps = await runOnce()
    await until(() => deps.devices().length > 0)

    const health = await rest?.health()
    expect(health?.sealing.screens).toEqual([phone.fingerprint])
  })
})
