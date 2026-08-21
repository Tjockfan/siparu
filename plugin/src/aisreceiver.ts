/**
 * The one thing a boat remembers about her AIS: that a target was once in the model.
 *
 * The map's AIS switch is a control rather than a readout - it is what somebody alone at
 * sea reaches for to ask whether anybody is out there - so it cannot be hidden whenever
 * the count is zero. It must still be absent on a vessel with no receiver, because a boat
 * that reports nothing gets no box anywhere else in this product.
 *
 * Those two boats look identical in the Signal K model: an empty vessels dictionary. The
 * only thing that separates them is history, and history does not survive a restart on
 * its own, which is why it is written down. A receiver proven once is proven for good; a
 * boat whose AIS was later unshipped keeps an idle switch, which is the cheap mistake.
 *
 * Kept beside the keys and the latch, write-then-rename. Nothing in it is private - it is
 * one boolean about the boat's own hardware - so it carries no special mode, the way the
 * voyage log does not.
 */
import * as fs from 'fs'
import * as path from 'path'

interface FileShape {
  v: number
  /** When she first saw another vessel. Kept for the diagnosis surface, not for logic. */
  first_seen_ts: number
}

const FILE_VERSION = 1

export interface AisReceiverStatus {
  /** Whether a target has ever been in her model. The evidence a receiver is aboard. */
  receiver_seen: boolean
  /** Null on a boat that has seen none, and on one whose record cannot be read. */
  first_seen_ts: number | null
}

export class AisReceiverMemory {
  private readonly file: string
  private seen = false
  private written = false
  private firstSeenTs: number | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'ais.json')
  }

  /**
   * Read at start, once.
   *
   * A file that will not parse is read as "seen, hour unknown". She wrote it, so a target
   * had been there; treating a torn sector as "no receiver" would take the switch away
   * from a boat that has one, and no reader can tell that apart from an honest empty
   * horizon. The other way round costs an idle switch.
   */
  load(): void {
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    this.seen = true
    this.written = true
    try {
      const raw = JSON.parse(text) as Partial<FileShape>
      if (raw.v === FILE_VERSION && typeof raw.first_seen_ts === 'number') {
        this.firstSeenTs = raw.first_seen_ts
      }
    } catch {
      /* seen, hour unknown */
    }
  }

  /**
   * A target is in the model. Written the first time and never again: this is called from
   * the snapshot tick, and a write a minute for the life of the vessel would wear the card
   * the server boots from.
   *
   * A write that did not land leaves the retry to the next tick. These machines boot from
   * SD cards that fill up, and a boat that took a failed write for a finished one would
   * come back from her next restart without a switch she had earned.
   */
  note(now: number): void {
    if (this.written) return
    this.written = true
    if (!this.seen) {
      this.seen = true
      this.firstSeenTs = now
    }
    const shape: FileShape = { v: FILE_VERSION, first_seen_ts: this.firstSeenTs ?? now }
    this.write(async () => {
      const tmp = `${this.file}.tmp`
      await fs.promises.writeFile(tmp, JSON.stringify(shape, null, 2), 'utf8')
      await fs.promises.rename(tmp, this.file)
    })
  }

  status(): AisReceiverStatus {
    return { receiver_seen: this.seen, first_seen_ts: this.firstSeenTs }
  }

  /** Wait for a queued write, the way the latch does: the tick behind it awaits nothing. */
  flush(): Promise<void> {
    return this.writeChain.catch(() => undefined)
  }

  private write(run: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(run, run).catch(() => {
      this.written = false
    })
  }
}
