import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SealingLatch } from '../src/latch'
import { BoatKeyStore } from '../src/keystore'
import { KeySync, PROMPTED_FLOOR_MS } from '../src/keysync'
import type { RemoteLink } from '../src/remotelink'

/**
 * Asking again because somebody ashore is watching.
 *
 * The gap this closes is a real one and it was found on a real phone: a device authorised on
 * the account cannot open a single frame until this vessel next reads the list, and she reads
 * it every five minutes. For those minutes the screen shows nothing while the boat behind it
 * reports every couple of seconds - which is why the app used to say she was not reporting.
 *
 * The interval here is deliberately long. A file that let the ordinary poll fire during the
 * case could not tell an ask that a prompt caused from one the timer was going to make anyway,
 * and would have passed with the prompt deleted.
 */

const REMOTE: RemoteLink = {
  boatId: 'boat-1',
  boatToken: 'tok-secret',
  pairedEmail: 'o***@example.com',
  pairedAt: '2026-08-02T04:00:00.000Z'
}

/** Far longer than any case runs, so the only ask after the first is one a test asked for. */
const NEVER_AGAIN = 60_000

/** Past the floor, without waiting out half a minute of real time. */
const LATER = 60_000

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the sync')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** Long enough that an ask which was going to happen would have happened. */
const quietly = () => new Promise((resolve) => setTimeout(resolve, 60))

let dir: string
const running: Array<{ stop: () => void }> = []
const stores: BoatKeyStore[] = []
const latches: SealingLatch[] = []

/** A fresh Response per call: a body may be read once, and these polls are repeated. */
function relayAnswers(payload: unknown) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify(payload), { status: 200 })
    })
  )
  return calls
}

function keysync(over: Partial<ConstructorParameters<typeof KeySync>[0]> = {}) {
  const keys = new BoatKeyStore(dir)
  stores.push(keys)
  keys.load()
  const latch = new SealingLatch(dir)
  latches.push(latch)
  const sync = new KeySync({
    relayUrl: 'https://relay.example',
    getRemote: () => REMOTE,
    keys,
    latch,
    debug: () => {},
    intervalMs: NEVER_AGAIN,
    ...over
  })
  running.push(sync)
  return { sync, keys, latch }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-prompt-'))
})

afterEach(async () => {
  while (running.length) running.pop()?.stop()
  vi.unstubAllGlobals()
  while (stores.length) await stores.pop()?.flush()
  while (latches.length) await latches.pop()?.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a boat told that a screen ashore has opened', () => {
  it('asks the shore again rather than waiting out the poll', async () => {
    const calls = relayAnswers({ devices: [], keys: 'ok' })
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length === 1)

    sync.prompt(Date.now() + LATER)
    await until(() => calls.length === 2)

    expect(calls[1]).toBe('https://relay.example/keys')
  })

  it('holds one that comes too soon down to the floor, rather than asking again at once', async () => {
    // The floor, and the reason for it: opening a socket costs whoever opens it nothing, and
    // an ask costs her a request over a link that is metered satellite for most of the fleet.
    // Without this a screen reconnecting in a loop is a boat asking in a loop.
    const calls = relayAnswers({ devices: [], keys: 'ok' })
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length === 1)

    sync.prompt()
    sync.prompt()
    sync.prompt()
    await quietly()

    expect(calls).toHaveLength(1)
  })

  it('asks when the floor is up, rather than dropping what it refused', async () => {
    // The second of two screens authorised in the same minute. Dropped, it falls back on the
    // five minute poll and shows nothing while the first one works - which is this whole gap
    // arriving by another road, and it is what the live measurement caught.
    const calls = relayAnswers({ devices: [], keys: 'ok' })
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length === 1)

    // As if the floor had all but run out: what is under test is that the prompt survives it.
    sync.prompt(Date.now() + PROMPTED_FLOOR_MS - 40)
    expect(calls).toHaveLength(1)

    await until(() => calls.length === 2)
  })

  it('leaves a boat that cannot reach the shore on her own backoff', async () => {
    // A screen reconnecting cannot fix a relay that is not answering. Asking on its schedule
    // rather than on hers is how a boat with no uplink knocks all night.
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        throw new Error('ECONNREFUSED')
      })
    )
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length === 1)

    sync.prompt(Date.now() + LATER)
    await quietly()

    expect(calls).toHaveLength(1)
  })

  it('does not stack a second ask on top of one already in the air', async () => {
    // Two requests where one would do, on a link where the first has not come back yet. The
    // answer in flight is newer than the prompt, so the prompt has nothing to add.
    let release: (r: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          })
      )
    )
    const { sync } = keysync()
    const sent = () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls

    sync.start()
    await until(() => sent().length === 1)

    sync.prompt(Date.now() + LATER)
    sync.prompt(Date.now() + LATER * 2)
    await quietly()

    expect(sent()).toHaveLength(1)
    release(new Response(JSON.stringify({ devices: [], keys: 'ok' }), { status: 200 }))
  })

  it('leaves the poll running underneath, so a prompt moves an ask rather than replacing it', async () => {
    // A prompt that cancelled the timer and did not start it again would look identical in
    // every case above and leave the vessel asking only when somebody happened to be watching -
    // which is to say, never noticing a screen her owner removed.
    const calls = relayAnswers({ devices: [], keys: 'ok' })
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length === 1)

    sync.prompt(Date.now() + LATER)
    await until(() => calls.length === 2)
    sync.prompt(Date.now() + LATER * 2)
    await until(() => calls.length === 3)

    expect(sync.status().state).toBe('published')
  })

  it('says nothing to the shore when she is not paired', async () => {
    const calls = relayAnswers({ devices: [], keys: 'ok' })
    const { sync } = keysync({ getRemote: () => undefined })

    sync.start()
    sync.prompt(Date.now() + LATER)
    await quietly()

    expect(calls).toHaveLength(0)
  })

  it('is refused after she has been stopped', async () => {
    // Signal K stops a plugin on every config save, and a socket's last messages arrive after
    // it. An ask here would be made on a token that may already have been replaced.
    const calls = relayAnswers({ devices: [], keys: 'ok' })
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length === 1)
    sync.stop()

    sync.prompt(Date.now() + LATER)
    await quietly()

    expect(calls).toHaveLength(1)
  })
})
