/**
 * The one thing a boat remembers about her own privacy: that somebody is watching.
 *
 * The device list is the shore's answer and it changes with every poll. Whether anybody has
 * EVER been authorised is not the shore's to answer, and this is where that difference is
 * kept. Once it is set, an empty list means she says nothing; before it is set, an empty list
 * means what it always meant, that no screen is waiting and she reports as she always has.
 *
 * A flag and nothing else. An earlier draft kept the device list here too, so that a boat
 * could seal her first frame after a restart instead of waiting a round trip for the shore to
 * answer. That was a mistake worth writing down: a file of public keys that the sealing code
 * reads at start is a file that hands anybody who can write to this directory a screen of
 * their own, and the whole point of this directory is that what is in it decides who may read
 * her. The flag has no such power. The worst an attacker gains by setting it is a vessel that
 * refuses to report, and the worst he gains by clearing it is what he already had before this
 * file existed.
 *
 * The cost of not keeping the list is that the first frames after a start go nowhere while
 * she waits for the poll she fires immediately. Silence for a moment, rather than her
 * position in the clear, is the trade this whole file exists to make.
 *
 * Written 0600 and write-then-rename beside the keys, like every other file the plugin keeps
 * for itself.
 */
import * as fs from 'fs'
import * as path from 'path'

interface FileShape {
  v: number
  /** Whose promise this is. A boat paired to a new account is not bound by the old one's. */
  boat: string
  sealing: boolean
}

const FILE_VERSION = 1

/**
 * What the key poll needs of this file, which is not much.
 *
 * Named separately so a test can hand the poll a disk that refuses to be written to. That is
 * not a hypothetical: the machines this runs on boot from SD cards and fill up, and a boat
 * that treated a failed write as done would come back from her next restart in the clear.
 */
export interface SealingLatchStore {
  load(boatId: string | undefined): boolean
  set(boatId: string): Promise<void>
  clear(): Promise<void>
}

export class SealingLatch implements SealingLatchStore {
  private readonly file: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'latch.json')
  }

  /**
   * Whether this boat, as she is paired right now, has been told that somebody may read her.
   *
   * Three answers, and the difference between the last two is the point:
   *
   * No file: she has never sealed. Cleartext is honest, and this is every vessel on her
   * first day.
   *
   * A file naming another boat, or none: a pairing has been replaced since it was written.
   * The promise belonged to the account she has left, and it is not carried into the new one.
   *
   * A file she cannot read: she wrote it, so she had sealed. Assuming the opposite would make
   * a torn sector the shore's way of asking for cleartext - a bad sector is a reason to go
   * quiet and be looked at, never a reason to start broadcasting a position that was private
   * an hour ago.
   */
  load(boatId: string | undefined): boolean {
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch {
      return false
    }
    try {
      const raw = JSON.parse(text) as Partial<FileShape>
      if (raw.v !== FILE_VERSION || typeof raw.boat !== 'string') return true
      if (!boatId || raw.boat !== boatId) return false
      return raw.sealing === true
    } catch {
      return true
    }
  }

  /** She has been told. Written once; the poll asks again only if the write did not land. */
  set(boatId: string): Promise<void> {
    return this.write(async () => {
      const tmp = `${this.file}.tmp`
      const shape: FileShape = { v: FILE_VERSION, boat: boatId, sealing: true }
      await fs.promises.writeFile(tmp, JSON.stringify(shape, null, 2), { mode: 0o600 })
      // writeFile applies a mode only when it creates the file, and a crash can leave the
      // temporary one behind.
      await fs.promises.chmod(tmp, 0o600)
      await fs.promises.rename(tmp, this.file)
    })
  }

  /** She was unpaired. The promise was made to an account that is no longer hers. */
  clear(): Promise<void> {
    return this.write(() => fs.promises.rm(this.file, { force: true }))
  }

  /**
   * Wait for a queued write, the way the keystore does: the poll behind it awaits nothing.
   *
   * A write that failed has already been said out loud where it happened, and it must not
   * take down the stop() that is waiting here - the rest of that stop is flushing a voyage
   * and a rule list somebody is depending on.
   */
  flush(): Promise<void> {
    return this.writeChain.catch(() => undefined)
  }

  private write(run: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(run, run)
    return this.writeChain
  }
}
