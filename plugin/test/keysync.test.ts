import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoatKeyStore } from '../src/keystore'
import { KeySync } from '../src/keysync'
import type { RemoteLink } from '../src/remotelink'

/**
 * What the boat says about herself to the shore, and - mostly - what she does when the
 * answer is not the one she wanted. The publishing itself is one POST; the value is in
 * the refusals, because each of them is a way for a vessel to end up believing she is
 * reachable when nobody can read a word she sends.
 */

const REMOTE: RemoteLink = {
  boatId: 'boat-1',
  boatToken: 'tok-secret',
  pairedEmail: 'o***@example.com',
  pairedAt: '2026-07-22T04:00:00.000Z'
}

/**
 * Short and real, not faked. This sync writes a key pair to disk before it sends anything,
 * and file I/O does not finish because a fake clock was wound forward: the first draft of
 * this file asserted on a request that had not been made yet and tore its own temp
 * directory down mid-write. So the timers are real and the interval is a few milliseconds.
 */
const INTERVAL = 10

/** Waits for what the sync does on its own schedule, rather than guessing how long it takes. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the sync')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** Long enough for several intervals to pass, when the point is that nothing more happens. */
const quietly = () => new Promise((resolve) => setTimeout(resolve, INTERVAL * 12))

let dir: string
/** Every sync a test starts, stopped with it: real timers outlive the test that made them. */
const running: Array<{ stop: () => void }> = []

function relayAnswers(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; token: string | null; body: Record<string, unknown> }> = []
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      calls.push({
        url: String(url),
        token: headers?.authorization ?? null,
        body: JSON.parse(String(init.body ?? 'null'))
      })
      const answer = answers[Math.min(i++, answers.length - 1)]
      if (answer instanceof Error) throw answer
      return answer
    })
  )
  return calls
}

const answered = (payload: unknown, status = 200) => () =>
  new Response(JSON.stringify(payload), { status })

function keysync(over: Partial<ConstructorParameters<typeof KeySync>[0]> = {}) {
  const keys = new BoatKeyStore(dir)
  keys.load()
  const sync = new KeySync({
    relayUrl: 'https://relay.example',
    getRemote: () => REMOTE,
    keys,
    debug: () => {},
    intervalMs: INTERVAL,
    ...over
  })
  running.push(sync)
  return { keys, sync }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-keysync-'))
})

afterEach(async () => {
  // A sync left running is a sync that goes on knocking through the NEXT test, against its
  // fetch stub and into its call log. That is how this file first read three requests where
  // it had made one, and it is the whole reason the timers here are real.
  while (running.length) running.pop()?.stop()
  vi.unstubAllGlobals()
  // The keystore writes on a chain of its own that no test can await. Deleting the
  // directory out from under a write in flight fails the rename and surfaces as an
  // unhandled rejection - a fixture tearing down its own subject.
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a boat publishing her own public halves', () => {
  it('sends both halves under her token and records that they landed', async () => {
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' })())
    const { sync, keys } = keysync()

    sync.start()
    await until(() => calls.length > 0)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://relay.example/keys')
    expect(calls[0].token).toBe('Bearer tok-secret')
    // What is sent is what she keeps, and only the public halves of it.
    expect(calls[0].body).toEqual(keys.publicKeys())
    expect(JSON.stringify(calls[0].body)).not.toContain('priv')
    expect(sync.status()).toEqual({ state: 'published', lastError: null })
  })

  it('makes her keys only once she is paired', async () => {
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' })())
    const { sync, keys } = keysync({ getRemote: () => undefined })

    sync.start()
    await quietly()

    // An unpaired vessel has nobody to talk to, and a key pair made for nobody is a
    // credential created for no reason. Nothing is generated and nothing is sent.
    expect(calls).toHaveLength(0)
    expect(keys.publicKeys()).toBeUndefined()
    expect(fs.existsSync(path.join(dir, 'keys.json'))).toBe(false)
    expect(sync.status().state).toBe('idle')
  })

  it('says nothing twice: a published boat stops asking', async () => {
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' })())
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 0)
    await quietly()

    expect(calls).toHaveLength(1)
  })

  it('keeps knocking while the relay is unreachable, backing off as it goes', async () => {
    const calls = relayAnswers(new Error('offline'))
    const { sync } = keysync()

    sync.start()
    // One at the first interval, one at the second, then the gaps widen: the boat that
    // was offline when this mattered is exactly the boat that comes back later.
    await until(() => calls.length > 1)

    expect(calls.length).toBeGreaterThan(1)
    expect(sync.status()).toEqual({
      state: 'failing',
      lastError: 'Cannot reach Siparu. Is the boat online?'
    })
  })

  it('stops for good when the shore already holds different keys', async () => {
    // The vessel's row ashore was published by another copy of her, or her own keys.json
    // was lost and rebuilt. Devices recognise her by what is ashore, so asking again cannot
    // help: the cure is an unlink and a fresh pairing, and the message says so.
    const calls = relayAnswers(answered({ devices: [], keys: 'mismatch' })())
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 0)
    await quietly()

    expect(calls).toHaveLength(1)
    expect(sync.status()).toEqual({
      state: 'mismatch',
      lastError: 'Siparu already holds different keys for this boat. Unlink her and pair again.'
    })
  })

  it('does not believe an answer that confirms nothing', async () => {
    // An older relay that knows nothing about keys answers the device list and no verdict.
    // Reading that as success would leave a boat certain she is published while the shore
    // holds nothing, and she would seal to screens that can never verify her.
    const calls = relayAnswers(answered({ devices: [] })())
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 1)

    expect(sync.status()).toMatchObject({ state: 'failing' })
  })

  it('names an unlinked boat rather than retrying her forever in silence', async () => {
    const calls = relayAnswers(answered({ error: 'unknown_token' }, 401)())
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 0)

    expect(calls).toHaveLength(1)
    expect(sync.status().lastError).toBe(
      'Siparu no longer recognises this boat. Pair her again.'
    )
  })

  it('sends the same keys on a later run, because publishing is write-once ashore', async () => {
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' })())

    const first = keysync()
    first.sync.start()
    await until(() => calls.length > 0)
    first.sync.stop()

    // A restart. The keys are read back off the disk rather than made again: rolling them
    // would cut off every device that already knows her.
    const second = keysync()
    second.sync.start()
    await until(() => calls.length > 1)

    expect(calls).toHaveLength(2)
    expect(calls[1].body).toEqual(calls[0].body)
  })

  it('a stopped sync does not send after its request comes back', async () => {
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
    await until(() => sent().length > 0)
    sync.stop()
    release(new Response(JSON.stringify({ devices: [], keys: 'ok' }), { status: 200 }))
    await quietly()

    // Signal K restarts plugins on every config save, so a request landing in a dead
    // instance is routine. It must not schedule anything on a token that may be stale.
    expect(sent()).toHaveLength(1)
  })
})
