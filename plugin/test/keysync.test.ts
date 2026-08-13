import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SealingLatch } from '../src/latch'
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
/** Every keystore a case built, so teardown can wait for its writes rather than guess. */
const stores: BoatKeyStore[] = []
/** Every latch a case built, waited on for the same reason: the poll awaits neither. */
const latches: SealingLatch[] = []

/**
 * Each answer is a FACTORY, not a Response: a Response body may be read once, so replaying
 * the same object turns the second poll into a parse failure and every assertion after it
 * into a lie about what the code did.
 */
function relayAnswers(...answers: Array<(() => Response) | Error>) {
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
      return answer()
    })
  )
  return calls
}

const answered = (payload: unknown, status = 200) => () =>
  new Response(JSON.stringify(payload), { status })

function keysync(over: Partial<ConstructorParameters<typeof KeySync>[0]> = {}) {
  const keys = new BoatKeyStore(dir)
  stores.push(keys)
  keys.load()
  // The same directory each time, so a second sync in a case is the same boat after a
  // restart rather than a different vessel.
  const latch = new SealingLatch(dir)
  latches.push(latch)
  const sync = new KeySync({
    relayUrl: 'https://relay.example',
    getRemote: () => REMOTE,
    keys,
    latch,
    debug: () => {},
    intervalMs: INTERVAL,
    ...over
  })
  running.push(sync)
  return { keys, sync, latch }
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
  // The keystore writes on a chain of its own, started by a poll that does not await
  // it. Deleting the directory out from under a write in flight fails the rename and
  // surfaces as an unhandled rejection - a fixture tearing down its own subject, and
  // one that takes the whole run with it after every test has passed. This used to
  // sleep 20ms and hope; on a slow Windows runner it did not, so it waits on the
  // chain itself, which is what the plugin's own stop() does.
  while (stores.length) await stores.pop()?.flush()
  while (latches.length) await latches.pop()?.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a boat publishing her own public halves', () => {
  it('sends both halves under her token and records that they landed', async () => {
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' }))
    const { sync, keys } = keysync()

    sync.start()
    await until(() => calls.length > 0)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://relay.example/keys')
    expect(calls[0].token).toBe('Bearer tok-secret')
    // What is sent is what she keeps, and only the public halves of it.
    expect(calls[0].body).toEqual(keys.publicKeys())
    expect(JSON.stringify(calls[0].body)).not.toContain('priv')
    expect(sync.status()).toEqual({
      state: 'published',
      lastError: null,
      devices: 0,
      sealing: false
    })
  })

  it('makes her keys only once she is paired', async () => {
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' }))
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

  it('asks at once on start, rather than after an interval of cleartext', async () => {
    // The window this closes: until the shore has answered she does not know she has screens
    // to seal to, so she reports in the clear. Signal K restarts a plugin on every config
    // save, so waiting out an interval first meant a boat that was sealing a moment ago
    // handing the carrier her position for as long as the interval lasts.
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' }))
    // An interval long enough that a poll arriving inside it can only have been immediate.
    const { sync } = keysync({ intervalMs: 60_000 })

    sync.start()
    // Generous against the wall clock, exact against the thing being tested: the
    // interval is a minute, so a poll inside five seconds can only have been the
    // immediate one. A tighter window was measuring how fast a Windows runner
    // generates two key pairs, which is not the claim.
    await until(() => calls.length > 0, 5_000)

    expect(calls).toHaveLength(1)
  })

  it('says her keys once and then only asks', async () => {
    // Publishing is write-once ashore, so there is nothing to gain by repeating it - but the
    // device list is a live answer, not a fact, so the poll itself never stops.
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' }))
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 1)

    expect(calls[0].body).toHaveProperty('identity')
    expect(calls[1].body).toEqual({})
  })

  it('learns which screens may read her, and forgets none of them on a bad poll', async () => {
    // A failed request must not empty the list: a boat that stopped sealing because a request
    // timed out would be a boat whose privacy depends on the weather.
    const device = { kid: 'kid-phone', pub: 'A'.repeat(43) }
    const calls = relayAnswers(
      answered({ devices: [device], keys: 'ok' }),
      new Error('offline')
    )
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 1)

    expect(sync.devices()).toEqual([device])
    expect(sync.status().devices).toBe(1)
  })

  it('drops a malformed device rather than the whole list', async () => {
    // This is fed straight into a key agreement, so it is checked by shape, not trusted.
    const good = { kid: 'kid-good', pub: 'A'.repeat(43) }
    const calls = relayAnswers(
      answered({
        devices: [good, { kid: 'kid-bad', pub: 'too short' }, { pub: 'B'.repeat(43) }, 42],
        keys: 'ok'
      })
    )
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 0)
    await until(() => sync.devices().length > 0)

    expect(sync.devices()).toEqual([good])
  })

  it('keeps knocking while the relay is unreachable, backing off as it goes', async () => {
    const calls = relayAnswers(new Error('offline'))
    const { sync } = keysync()

    sync.start()
    // One at the first interval, one at the second, then the gaps widen: the boat that
    // was offline when this mattered is exactly the boat that comes back later.
    await until(() => calls.length > 1)

    expect(calls.length).toBeGreaterThan(1)
    expect(sync.status()).toMatchObject({
      state: 'failing',
      lastError: 'Cannot reach Siparu. Is the boat online?'
    })
  })

  it('stops offering her keys when the shore already holds different ones', async () => {
    // The vessel's row ashore was published by another copy of her, or her own keys.json was
    // lost and rebuilt. Devices recognise her by what is ashore, so offering hers again cannot
    // help: the cure is an unlink and a fresh pairing, and the message says so. The poll goes
    // on regardless, because the device list is still worth having.
    const calls = relayAnswers(answered({ devices: [], keys: 'mismatch' }))
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 1)

    expect(calls[1].body).toEqual({})
    expect(sync.status()).toMatchObject({
      state: 'mismatch',
      lastError: 'Siparu already holds different keys for this boat. Unlink her and pair again.'
    })
  })

  it('does not believe an answer that confirms nothing', async () => {
    // An older relay that knows nothing about keys answers the device list and no verdict.
    // Reading that as success would leave a boat certain she is published while the shore
    // holds nothing, and she would seal to screens that can never verify her.
    const calls = relayAnswers(answered({ devices: [] }))
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 1)

    expect(sync.status()).toMatchObject({ state: 'failing' })
  })

  it('names an unlinked boat rather than retrying her forever in silence', async () => {
    const calls = relayAnswers(answered({ error: 'unknown_token' }, 401))
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 0)

    expect(calls).toHaveLength(1)
    expect(sync.status().lastError).toBe(
      'Siparu no longer recognises this boat. Pair her again.'
    )
  })

  it('sends the same keys on a later run, because publishing is write-once ashore', async () => {
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' }))

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

  it('keeps no file for a boat nobody has authorised', async () => {
    // Nothing has been promised, so there is nothing to write down, and the poll runs for
    // the life of the vessel: a write per round would be several hundred thousand needless
    // ones a year onto the card a Venus install boots from.
    const calls = relayAnswers(answered({ devices: [], keys: 'ok' }))
    const { sync, latch } = keysync()

    sync.start()
    await until(() => calls.length > 2)
    await latch.flush()

    expect(fs.existsSync(path.join(dir, 'latch.json'))).toBe(false)
    expect(sync.sealing()).toBe(false)
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


/**
 * Having been told, once, that somebody is watching.
 *
 * The device list is the shore's answer and it changes with every poll. Whether anybody has
 * EVER been authorised is the boat's own memory, and the shore cannot take it back - because
 * an empty list is what a compromised relay, a deleted row and a renamed field all look like,
 * and the sealing code reads an empty list as permission to report in the clear unless this
 * says otherwise.
 */
describe('a boat remembering that she seals', () => {
  const PHONE = { kid: 'kid-phone', pub: 'A'.repeat(43) }

  /** A latch on a disk that refuses, so a failed write can be told from a skipped one. */
  function refusingLatch() {
    const attempts: string[] = []
    return {
      attempts,
      load: () => false,
      set: async (boat: string) => {
        attempts.push(boat)
        throw new Error('no space left on device')
      },
      clear: async () => undefined
    }
  }

  it('does not unremember it when the shore answers with nobody', async () => {
    const calls = relayAnswers(
      answered({ devices: [PHONE], keys: 'ok' }),
      answered({ devices: [], keys: 'ok' })
    )
    const { sync } = keysync()

    sync.start()
    await until(() => sync.devices().length > 0)
    await until(() => calls.length > 1 && sync.devices().length === 0)

    // The list is the shore's to empty. The promise is not.
    expect(sync.devices()).toEqual([])
    expect(sync.sealing()).toBe(true)
  })

  it('counts a list of nothing but unusable keys as somebody authorised', async () => {
    // The shapes are checked before these reach a key agreement, so this list thins to
    // nothing - and a boat that read that as "nobody is watching" would answer five hostile
    // keys with her position in the clear. What is owed here is silence.
    const calls = relayAnswers(
      answered({ devices: [{ kid: 'kid-bad', pub: 'too short' }], keys: 'ok' })
    )
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 0)
    await until(() => sync.sealing())

    expect(sync.devices()).toEqual([])
    expect(sync.sealing()).toBe(true)
  })

  it('does not let an array that names no screen promise anything', async () => {
    // This cannot be undone from ashore, so it takes an entry that at least claims to be a
    // device. A build sending nulls would otherwise silence a vessel for good.
    const calls = relayAnswers(answered({ devices: [null, 0, 'kid-phone'], keys: 'ok' }))
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 1)

    expect(sync.sealing()).toBe(false)
  })

  it('does not empty a working list over an answer that says nothing about devices', async () => {
    // A relay build that renames the field, or a mismatch reply assembled without it. Read as
    // "no devices" it would take a sealing boat off the air entirely, and the cause would be
    // invisible: the socket stays up and the shore keeps answering 200.
    const calls = relayAnswers(
      answered({ devices: [PHONE], keys: 'ok' }),
      answered({ keys: 'ok' })
    )
    const { sync } = keysync()

    sync.start()
    await until(() => sync.devices().length > 0)
    await until(() => calls.length > 1)
    await quietly()

    expect(sync.devices()).toEqual([PHONE])
    // And she took the answer as the good answer it was. Keeping the list by way of throwing
    // on it would look the same from here and would be a boat backing off her own key poll.
    expect(sync.status()).toMatchObject({ state: 'published', lastError: null, sealing: true })
  })

  it('takes at most the screens the sealing code can use', async () => {
    // The list arrives from ashore and nothing about it is this boat's to trust. Frames are
    // sealed to the first five; a twenty-thousand row answer must cost her five entries, not
    // a resident copy of somebody else's mistake.
    const many = Array.from({ length: 40 }, (_, i) => ({ kid: `kid-${i}`, pub: 'A'.repeat(43) }))
    const calls = relayAnswers(answered({ devices: many, keys: 'ok' }))
    const { sync } = keysync()

    sync.start()
    await until(() => calls.length > 0)
    await until(() => sync.devices().length > 0)

    expect(sync.devices()).toHaveLength(5)
    expect(sync.devices()[0]).toEqual(many[0])
  })

  it('knows on her next start that she was sealing', async () => {
    // Signal K restarts a plugin on every config save. Before this, each of those restarts
    // was a boat that had been sealing a moment earlier reporting her position in the clear
    // until the shore answered. Now she starts silent instead, and the shore fills in the
    // screens a moment later.
    const calls = relayAnswers(answered({ devices: [PHONE], keys: 'ok' }))
    const first = keysync()

    first.sync.start()
    await until(() => first.sync.sealing())
    await first.latch.flush()
    first.sync.stop()

    const second = keysync()
    second.sync.start()

    // Measured before anything is awaited: this is the world the first frame after a start
    // sees. No screens yet, and cleartext already off.
    expect(second.sync.sealing()).toBe(true)
    expect(second.sync.devices()).toEqual([])
  })

  it('keeps trying to write it down until it lands', async () => {
    // A full SD card is the ordinary way this fails, and a boat that took a failed write for
    // a finished one would come back from her next restart in the clear.
    const calls = relayAnswers(answered({ devices: [PHONE], keys: 'ok' }))
    const latch = refusingLatch()
    const { sync } = keysync({ latch })

    sync.start()
    await until(() => calls.length > 2)

    expect(latch.attempts.length).toBeGreaterThan(1)
    // And she is sealing regardless: the disk failing is not the shore's permission.
    expect(sync.sealing()).toBe(true)
  })

  it('writes it down once when the disk takes it', async () => {
    const written: string[] = []
    const calls = relayAnswers(answered({ devices: [PHONE], keys: 'ok' }))
    const { sync } = keysync({
      latch: {
        load: () => false,
        set: async (boat: string) => {
          written.push(boat)
        },
        clear: async () => undefined
      }
    })

    sync.start()
    await until(() => calls.length > 3)

    expect(written).toEqual(['boat-1'])
  })

  it('forgets it when she is unpaired aboard', async () => {
    // The one instruction that can only have come from somebody with the boat in front of
    // them. A new pairing is a new account: the screens the last one authorised are not hers,
    // and neither is the promise she was under.
    const calls = relayAnswers(answered({ devices: [PHONE], keys: 'ok' }))
    // A long interval, because what is measured here is what the unpairing forgot - not what
    // the next poll goes on to learn. reset() deliberately leaves the timer running: the same
    // call serves a fresh pairing, and that account's screens have to be fetched. With the
    // file's ten-millisecond interval that poll lands inside the await below on a machine slow
    // enough, puts a device list back, and the test reads it as an unpairing that did not
    // hold. It failed exactly there under QEMU on the armv7 runner - the Cerbo GX target -
    // while every desktop stayed green.
    const { sync, latch } = keysync({ intervalMs: 60_000 })

    sync.start()
    await until(() => sync.sealing())

    sync.reset()
    await latch.flush()

    expect(sync.sealing()).toBe(false)
    expect(sync.devices()).toEqual([])
    expect(fs.existsSync(path.join(dir, 'latch.json'))).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('does not let a poll in flight put the old account back after an unpairing', async () => {
    // The window is real: the request was asked with a token that belonged to the account she
    // has just left. Applied, it hands the previous owner's screens to a boat that now belongs
    // to somebody else, and re-arms a promise made to them - which then blocks the new owner's
    // frames until he authorises a screen, with nothing on any surface saying why.
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
    sync.reset()
    release(new Response(JSON.stringify({ devices: [PHONE], keys: 'ok' }), { status: 200 }))
    await quietly()

    expect(sync.devices()).toEqual([])
    expect(sync.sealing()).toBe(false)
  })
})
