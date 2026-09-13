/**
 * Raw history store: one NDJSON file per UTC hour under <dataDir>/raw/.
 *
 * Disk discipline (Cerbo GX "#46 data partition full" is a real failure
 * mode): a hard byte cap prunes the oldest raw files first; materialized
 * rollups live elsewhere and are never pruned.
 *
 * Writes are serialized through a promise chain so an hour-close (rollup
 * build + prune) never interleaves with an append.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Snapshot } from './contract'
import { hourKey } from './time'

export type Logger = (msg: string) => void

export class Store {
  readonly rawDir: string
  readonly rollupDir: string
  private chain: Promise<void> = Promise.resolve()
  private currentHourKey: string | null = null
  /**
   * Usage is tracked incrementally (scan once at init, adjust on append and
   * prune) so /health and cap checks cost zero IO. At the 500 MB default cap
   * there can be ~27k raw files - per-request stat sweeps would hammer a
   * Cerbo's eMMC.
   */
  private knownKeys = new Set<string>()
  private bytes = 0
  /**
   * Whether the disk is taking what she writes. A card remounted read-only after an error,
   * a full data partition, an I/O fault: every one of these made append() resolve as if the
   * row were on disk, and the plugin went on saying "Recording" for months over a hole. The
   * last verdict is kept here so that the status line, /health and the hour close can each
   * read it; the counter is for the person who opens /health afterwards and wants to know
   * whether it was one bad write or all of them.
   */
  private lastWriteOk = true
  private writeFailures = 0
  private lastWriteError: string | null = null
  /** Called with the closed hour key after the writer moves to a new hour. */
  onHourClosed: ((closedHour: string) => Promise<void>) | null = null

  constructor(
    dataDir: string,
    private capBytes: number,
    private log: Logger
  ) {
    this.rawDir = path.join(dataDir, 'raw')
    this.rollupDir = path.join(dataDir, 'rollup')
  }

  async init(now: number): Promise<void> {
    await fs.mkdir(this.rawDir, { recursive: true })
    await fs.mkdir(this.rollupDir, { recursive: true })
    this.currentHourKey = hourKey(now)
    const names = await fs.readdir(this.rawDir).catch(() => [] as string[])
    this.knownKeys = new Set(
      names.filter((n) => n.endsWith('.ndjson')).map((n) => n.slice(0, -'.ndjson'.length))
    )
    this.bytes = 0
    for (const key of this.knownKeys) {
      const st = await fs.stat(this.rawPath(key)).catch(() => null)
      if (st) this.bytes += st.size
    }
  }

  /** Serialize an async job onto the write chain. Errors are logged, not thrown. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(job).catch((err) => this.log(`store error: ${err}`))
    return this.chain
  }

  rawPath(hour: string): string {
    return path.join(this.rawDir, `${hour}.ndjson`)
  }

  /**
   * Append one row. Resolves true when the row reached the disk and false when it did not;
   * the failure is remembered (see writes()) and never thrown, because the caller's next
   * row is still worth trying. The hour-close hook runs either way: the hour did close, and
   * the hook is where the disk cap is enforced, which on a full card is the one thing that
   * can make the next append succeed.
   */
  append(snap: Snapshot): Promise<boolean> {
    let written = false
    return this.enqueue(async () => {
      const key = hourKey(snap.ts)
      const closed = this.currentHourKey && key !== this.currentHourKey ? this.currentHourKey : null
      this.currentHourKey = key
      const line = JSON.stringify(snap) + '\n'
      try {
        await fs.appendFile(this.rawPath(key), line, 'utf8')
        this.knownKeys.add(key)
        this.bytes += Buffer.byteLength(line)
        written = true
        this.lastWriteOk = true
      } catch (err) {
        this.writeFailures++
        this.lastWriteOk = false
        this.lastWriteError = describeError(err)
        this.log(`store error: raw append failed: ${this.lastWriteError}`)
      }
      if (closed && this.onHourClosed) await this.onHourClosed(closed)
    }).then(() => written)
  }

  /** The disk's answer to the last write, and how often it has said no. */
  writes(): { ok: boolean; failures: number; last_error: string | null } {
    return { ok: this.lastWriteOk, failures: this.writeFailures, last_error: this.lastWriteError }
  }

  /** Hour keys of raw files, ascending. Served from the in-memory index. */
  async listRawKeys(): Promise<string[]> {
    return [...this.knownKeys].sort()
  }

  /** Parse a raw hour file; corrupt lines (torn write on power loss) are skipped. */
  async readRaw(hour: string): Promise<Snapshot[]> {
    let text: string
    try {
      text = await fs.readFile(this.rawPath(hour), 'utf8')
    } catch {
      return []
    }
    return parseNdjson<Snapshot>(text).filter((s) => typeof s.ts === 'number')
  }

  async rawUsage(): Promise<{ bytes: number; files: number; oldest: string | null }> {
    const keys = [...this.knownKeys].sort()
    return { bytes: this.bytes, files: keys.length, oldest: keys[0] ?? null }
  }

  /**
   * Delete oldest raw files until under the cap. Never touches the open
   * hour (skipped, not treated as a stop point - a GPS clock jumping
   * backwards can leave "future" files after the open one).
   */
  async enforceCap(): Promise<number> {
    if (this.bytes <= this.capBytes) return 0
    const keys = [...this.knownKeys].sort()
    let deleted = 0
    for (const key of keys) {
      if (this.bytes <= this.capBytes) break
      if (key === this.currentHourKey) continue
      const st = await fs.stat(this.rawPath(key)).catch(() => null)
      await fs.unlink(this.rawPath(key)).catch(() => undefined)
      this.bytes -= st?.size ?? 0
      this.knownKeys.delete(key)
      deleted++
    }
    if (deleted > 0) this.log(`storage cap: pruned ${deleted} oldest raw hour file(s)`)
    return deleted
  }

  /** Wait until previously enqueued writes have settled (used by stop() and tests). */
  flush(): Promise<void> {
    return this.enqueue(async () => undefined)
  }
}

/** The error as a person reads it in /health: the code first (EROFS, ENOSPC), then the message. */
function describeError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null
  const code = typeof e?.code === 'string' ? e.code : null
  const message = e instanceof Error ? e.message : String(err)
  return code && !message.startsWith(code) ? `${code}: ${message}` : message
}

export function parseNdjson<T>(text: string): T[] {
  const out: T[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // torn/corrupt line - skip
    }
  }
  return out
}
