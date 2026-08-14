/**
 * The first device of this pairing, as the boat herself witnessed it.
 *
 * Everything else on the device list arrives over a carrier and is believed only on
 * the strength of an approval chain (approval.ts). This file is where that chain is
 * rooted: the kid and public half of the device that was on the other side of the
 * pairing, written at the moment somebody standing at this boat's screen approved
 * it. It is the one key the shore never gets to substitute after the fact.
 *
 * Kept in the data directory beside the keys and the latch, 0600, write-then-rename,
 * and for the same reason: no route serves this directory, and what is in it decides
 * who may read her.
 *
 * The load answers three things and the difference matters more than usual. Null is
 * "never pinned": a boat paired before approvals shipped, honest in pass-through and
 * says so in her status. 'broken' is "pinned once and the record is gone bad": she
 * refuses everybody rather than loosening, because a torn sector must never be the
 * carrier's way of asking for the trusting old behaviour back. And the anchor itself
 * is a working root. A file naming another boat reads as null, not broken: the
 * pairing it belonged to has been replaced, and the new one has simply not pinned yet.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { DeviceAnchor } from './approval'

interface FileShape {
  v: number
  /** Whose pairing this root belongs to. A boat re-paired elsewhere starts unpinned. */
  boat: string
  /**
   * WHICH pairing, not only whose. A re-pairing keeps the boat id on purpose
   * (pairing.ts refuses an approval that returns a different one), so the id alone
   * cannot tell two pairings apart - and an anchor that survived a re-pairing would
   * quietly keep the OLD first device as the root of the new life. The stated cure
   * for a stolen first device is to pair her again aboard; this field is what makes
   * that cure real rather than assumed.
   */
  paired_at: string
  kid: string
  pub: string
}

const FILE_VERSION = 1

/** The shape the wire holds a device key to, held here too: 32 bytes, spelled base64url. */
const PUB_SHAPE = /^[A-Za-z0-9_-]{43}$/

export class AnchorStore {
  private readonly file: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'anchor.json')
  }

  load(boatId: string | undefined, pairedAt: string | undefined): DeviceAnchor | null | 'broken' {
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (e) {
      // Not there at all: she never pinned. Anything else - permissions, an I/O
      // error - is a record she cannot rule out having written, and reads as broken.
      return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'broken'
    }
    let raw: Partial<FileShape>
    try {
      raw = JSON.parse(text) as Partial<FileShape>
    } catch {
      return 'broken'
    }
    // The pub is held to the wire's own shape here rather than trusted as "we wrote
    // it": a torn write can leave a string that parses and is not a key, and a root
    // that can vouch for nobody is not a working anchor with an odd spelling - it is
    // the broken state, whose message names the cure. Without this check the boat
    // would refuse every screen while diagnosing each refusal as somebody else's key.
    if (
      raw.v !== FILE_VERSION ||
      typeof raw.boat !== 'string' ||
      typeof raw.paired_at !== 'string' ||
      typeof raw.kid !== 'string' ||
      raw.kid.length === 0 ||
      typeof raw.pub !== 'string' ||
      !PUB_SHAPE.test(raw.pub)
    ) {
      return 'broken'
    }
    if (!boatId || raw.boat !== boatId) return null
    // Same boat, different pairing: a re-pair keeps the id, so the timestamp is what
    // separates the lives. The old root belonged to the old one.
    if (!pairedAt || raw.paired_at !== pairedAt) return null
    return { kid: raw.kid, pub: raw.pub }
  }

  /** Witnessed at pairing approval, the one write this file ever gets per pairing. */
  set(boatId: string, pairedAt: string, anchor: DeviceAnchor): Promise<void> {
    return this.write(async () => {
      const tmp = `${this.file}.tmp`
      const shape: FileShape = {
        v: FILE_VERSION,
        boat: boatId,
        paired_at: pairedAt,
        kid: anchor.kid,
        pub: anchor.pub
      }
      await fs.promises.writeFile(tmp, JSON.stringify(shape, null, 2), { mode: 0o600 })
      // writeFile applies a mode only when it creates the file, and a crash can leave
      // the temporary one behind.
      await fs.promises.chmod(tmp, 0o600)
      await fs.promises.rename(tmp, this.file)
    })
  }

  /** She was unpaired. The next pairing roots its own trust. */
  clear(): Promise<void> {
    return this.write(() => fs.promises.rm(this.file, { force: true }))
  }

  /** Wait for a queued write, the way the latch and the keystore do. */
  flush(): Promise<void> {
    return this.writeChain.catch(() => undefined)
  }

  private write(run: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }
}
