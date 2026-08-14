import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnchorStore } from '../src/anchor'

/**
 * The boat's record of the first device of this pairing.
 *
 * The same discipline as the latch, with one difference that decides every answer
 * here: a missing file means she never pinned and pass-through is honest, while a
 * file she cannot make sense of means she DID pin and has lost the root - and a
 * pinned boat that loosens because a sector tore has handed the carrier a way to
 * ask for the old, trusting behaviour back. Missing loosens; broken silences.
 *
 * And one distinction the latch does not need: WHICH pairing, not only whose. A
 * re-pairing keeps the boat id on purpose, so the id alone cannot separate the old
 * life from the new - and an anchor that survived a re-pairing would keep the old
 * first device as the root of a pairing it was never witnessed in.
 */

let dir: string
let store: AnchorStore
const file = () => path.join(dir, 'anchor.json')
const BOAT = 'boat-0001'
const PAIRED_AT = '2026-08-01T10:00:00.000Z'
const ANCHOR = { kid: 'phone-of-record-1', pub: 'A'.repeat(43) }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-anchor-'))
  store = new AnchorStore(dir)
})

afterEach(async () => {
  await store.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the anchor on disk', () => {
  it('reads back what was written', async () => {
    await store.set(BOAT, PAIRED_AT, ANCHOR)
    expect(store.load(BOAT, PAIRED_AT)).toEqual(ANCHOR)
  })

  it('answers null for a boat that never pinned', () => {
    expect(store.load(BOAT, PAIRED_AT)).toBeNull()
  })

  it('does not carry one pairing anchor into the next', async () => {
    await store.set(BOAT, PAIRED_AT, ANCHOR)
    expect(store.load('boat-0002', PAIRED_AT)).toBeNull()
  })

  it('does not survive a re-pairing of the same boat', async () => {
    // The stated cure for a stolen first device is to pair her again aboard. A
    // re-pair keeps the boat id, so if the id were the whole test, the thief's key
    // would quietly stay the root of the new pairing and the cure would be a ritual.
    await store.set(BOAT, PAIRED_AT, ANCHOR)
    expect(store.load(BOAT, '2026-08-14T02:00:00.000Z')).toBeNull()
  })

  it('answers null while the boat is not paired at all', async () => {
    await store.set(BOAT, PAIRED_AT, ANCHOR)
    expect(store.load(undefined, undefined)).toBeNull()
  })

  it('answers broken for a file it cannot parse', async () => {
    await store.set(BOAT, PAIRED_AT, ANCHOR)
    fs.writeFileSync(file(), '{ torn mid-')
    expect(store.load(BOAT, PAIRED_AT)).toBe('broken')
  })

  it('answers broken for a shape a newer build must have written', async () => {
    fs.writeFileSync(file(), JSON.stringify({ v: 99, boat: BOAT }))
    expect(store.load(BOAT, PAIRED_AT)).toBe('broken')
  })

  it('answers broken for a pub that is not a key, not "different key" per screen', async () => {
    // A torn write can leave a string that parses and is not a key. Read as a working
    // anchor, that root can vouch for NOBODY, and every honest screen would be
    // refused with a reason blaming its own key - a misdiagnosis printed once per
    // device. The broken state already owns the honest words for this.
    fs.writeFileSync(
      file(),
      JSON.stringify({ v: 1, boat: BOAT, paired_at: PAIRED_AT, kid: ANCHOR.kid, pub: 'not-a-key' })
    )
    expect(store.load(BOAT, PAIRED_AT)).toBe('broken')
  })

  it('answers broken for a file it is refused permission to read', async () => {
    // EISDIR on every platform: the path exists and cannot be read as a file. Reading
    // "cannot read" as "never pinned" would hand whoever can wedge the read a way to
    // unpin her; the latch makes the same call in the same direction.
    fs.mkdirSync(file())
    expect(store.load(BOAT, PAIRED_AT)).toBe('broken')
  })

  it('forgets on clear, which is an unpairing aboard', async () => {
    await store.set(BOAT, PAIRED_AT, ANCHOR)
    await store.clear()
    expect(fs.existsSync(file())).toBe(false)
    expect(store.load(BOAT, PAIRED_AT)).toBeNull()
  })

  it('leaves no half-written file behind', async () => {
    await store.set(BOAT, PAIRED_AT, ANCHOR)
    expect(fs.existsSync(`${file()}.tmp`)).toBe(false)
  })

  it('lets a stop finish even when its write failed', async () => {
    // stop() awaits flush() beside the latch's and the keystore's. A rejected chain
    // here would take the rest of that shutdown with it.
    const doomed = new AnchorStore(path.join(dir, 'no-such-directory'))
    void doomed.set(BOAT, PAIRED_AT, ANCHOR).catch(() => undefined)
    await expect(doomed.flush()).resolves.toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')(
    'is written where only this account can read or change it',
    async () => {
      await store.set(BOAT, PAIRED_AT, ANCHOR)
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'applies that mode even over a temporary file left by a crash',
    async () => {
      // writeFile applies a mode only when it creates the file.
      fs.writeFileSync(`${file()}.tmp`, 'left behind', { mode: 0o644 })
      await store.set(BOAT, PAIRED_AT, ANCHOR)
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    }
  )
})
