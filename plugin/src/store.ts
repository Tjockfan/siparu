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

  append(snap: Snapshot): Promise<void> {
    return this.enqueue(async () => {
      const key = hourKey(snap.ts)
      const closed = this.currentHourKey && key !== this.currentHourKey ? this.currentHourKey : null
      this.currentHourKey = key
      const line = JSON.stringify(snap) + '\n'
      await fs.appendFile(this.rawPath(key), line, 'utf8')
      this.knownKeys.add(key)
      this.bytes += Buffer.byteLength(line)
      if (closed && this.onHourClosed) await this.onHourClosed(closed)
    })
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
