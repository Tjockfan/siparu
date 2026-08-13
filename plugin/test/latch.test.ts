import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SealingLatch } from '../src/latch'

/**
 * The boat's memory of having been told that somebody is watching.
 *
 * Every case here is about a file that is not what was written: a torn power cut mid-rename,
 * an older build's shape, a pairing that has been replaced since. The rule the answers follow
 * is not "believe the file" but "which mistake is survivable": reporting in the clear when
 * she should have sealed cannot be taken back, and going quiet when she could have reported
 * can.
 */

let dir: string
let latch: SealingLatch
const file = () => path.join(dir, 'latch.json')
const BOAT = 'boat-0001'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-latch-'))
  latch = new SealingLatch(dir)
})

afterEach(async () => {
  await latch.flush()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('remembering that she seals', () => {
  it('reads back what was written', async () => {
    await latch.set(BOAT)
    expect(latch.load(BOAT)).toBe(true)
  })

  it('says no for a boat that has never sealed', () => {
    expect(latch.load(BOAT)).toBe(false)
  })

  // Windows has no Unix permission bits, so mode is meaningless there; the CI matrix
  // includes it and would otherwise fail on a check that does not apply. The mode is still
  // asked for on every platform - the same skip guards the keystore and the pairing file.
  it.skipIf(process.platform === 'win32')(
    'is written where only this account can read or change it',
    async () => {
      // What is in it is not a secret. What it decides is whether a vessel reports in the
      // clear, which is not a decision any other account on the box should be able to make.
      await latch.set(BOAT)
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'applies that mode even over a temporary file left by a crash',
    async () => {
      // writeFile applies a mode only when it creates the file.
      fs.writeFileSync(`${file()}.tmp`, 'left behind', { mode: 0o644 })
      await latch.set(BOAT)
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600)
    }
  )

  it('leaves no half-written file behind', async () => {
    await latch.set(BOAT)
    expect(fs.existsSync(`${file()}.tmp`)).toBe(false)
  })

  it('does not carry a promise made by a pairing she has left', async () => {
    // A new pairing is a new account, with its own screens and its own devices. Carrying the
    // old promise into it would leave a boat refusing to report to an owner who has
    // authorised nobody yet, with nothing on screen saying why.
    await latch.set('boat-old')
    expect(latch.load('boat-new')).toBe(false)
  })

  it('does not carry it into a boat that is not paired at all', async () => {
    await latch.set(BOAT)
    expect(latch.load(undefined)).toBe(false)
  })

  it('assumes she was sealing when the file cannot be read', () => {
    // She wrote it, so she had sealed. Reading a torn sector as "never sealed" would make a
    // bad disk the shore's way of asking for cleartext.
    fs.writeFileSync(file(), '{"v":1,"boat":"boat-00')
    expect(latch.load(BOAT)).toBe(true)
  })

  it('assumes the same for a shape it has not learned', () => {
    // A later build's file, read by an earlier one after a downgrade.
    fs.writeFileSync(file(), JSON.stringify({ v: 2, boat: BOAT, sealing: true }))
    expect(latch.load(BOAT)).toBe(true)
  })

  it('takes a file that names her and says she was not sealing at its word', () => {
    fs.writeFileSync(file(), JSON.stringify({ v: 1, boat: BOAT, sealing: false }))
    expect(latch.load(BOAT)).toBe(false)
  })

  it('forgets when she is unpaired', async () => {
    await latch.set(BOAT)
    await latch.clear()

    expect(fs.existsSync(file())).toBe(false)
    expect(latch.load(BOAT)).toBe(false)
  })

  it('has nothing to forget without complaining about it', async () => {
    await expect(latch.clear()).resolves.toBeUndefined()
  })

  it('lets a stop finish even when its write failed', async () => {
    // stop() awaits this before flushing a voyage and a rule list somebody is depending on.
    // A rejected chain here used to take the rest of that shutdown with it.
    const doomed = new SealingLatch(path.join(dir, 'no-such-directory'))
    void doomed.set(BOAT).catch(() => undefined)
    await expect(doomed.flush()).resolves.toBeUndefined()
  })
})
