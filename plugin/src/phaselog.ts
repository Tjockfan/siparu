/**
 * Phase persistence: the activity band, stored beside the voyages.
 *
 * A sibling of voyagelog.ts and deliberately separate from it. The voyage
 * engine's golden fixture must not move, so phases keep their own state
 * machine, their own file (phases.json), and never reach into the voyage code.
 * The design is the same though: every appended snapshot feeds the one
 * PhaseStateMachine, and a restart replays from the open phase's start so the
 * streaks and any pending transition reconstruct exactly as the live feed built
 * them. Written atomically (tmp + rename) and only on a structural change - a
 * phase opening or closing - never on the moving end of the open phase, which
 * replay recomputes anyway.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Phase, Snapshot } from './contract'
import { Options } from './config'
import { Logger, Store } from './store'
import { hourKey } from './time'
import { VoyageRow } from './voyage'
import { OpenPhase, PhaseStateMachine } from './phases'

interface PersistedPhases {
  /** Closed phases, oldest first. */
  phases: Phase[]
  /** The phase in progress, or null. */
  open: OpenPhase | null
}

export class PhaseLog {
  private closed: Phase[] = []
  private machine: PhaseStateMachine
  private chain: Promise<void> = Promise.resolve()
  private filePath: string
  private persistedRev = ''

  constructor(
    private store: Store,
    private opts: Options,
    private log: Logger
  ) {
    this.filePath = path.join(store.rollupDir, 'phases.json')
    this.machine = new PhaseStateMachine(opts.voyage, null)
  }

  /** Serialize a job onto the chain (the mutex voyagelog uses too). */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job)
    this.chain = run.then(
      () => undefined,
      (err) => this.log(`phase error: ${err}`)
    )
    return run
  }

  async init(now: number): Promise<void> {
    return this.enqueue(async () => {
      let open: OpenPhase | null = null
      try {
        const raw = await fs.readFile(this.filePath, 'utf8')
        const parsed = JSON.parse(raw) as PersistedPhases
        if (Array.isArray(parsed.phases)) this.closed = parsed.phases
        open = parsed.open ?? null
      } catch {
        // first run or unreadable file - the band rebuilds from disk below
      }
      this.machine = new PhaseStateMachine(this.opts.voyage, open)
      this.persistedRev = this.revision()
      // Replay from the open phase's start, or the last closed end, or the
      // oldest retained row. Streaks reconstruct; a transition that had not yet
      // held long enough when the plugin stopped is re-evaluated here.
      const from = open ? open.start.ts : this.lastClosedEnd()
      for (const r of await this.readRows(from, now)) this.absorb(r)
      await this.persistIfChanged()
    })
  }

  /** Feed one appended snapshot; may close a phase and open the next. */
  feed(snap: Snapshot): Promise<void> {
    return this.enqueue(async () => {
      this.absorb({
        ts: snap.ts,
        lat: snap.lat,
        lon: snap.lon,
        sog: snap.sog,
        nav_state: snap.nav_state,
        path_values: snap.path_values
      })
      await this.persistIfChanged()
    })
  }

  /** Newest first, the open phase included. */
  list(limit: number): Phase[] {
    const out = [...this.closed]
    const open = this.machine.current()
    if (open) out.push(open)
    // Clamped by the callers (rest.ts, and the socket handler), as with vl.list.
    return out.sort((a, b) => b.start_ts - a.start_ts).slice(0, limit)
  }

  current(): Phase | null {
    return this.machine.current()
  }

  private absorb(row: VoyageRow): void {
    const closed = this.machine.feed(row)
    if (closed) this.closed.push(closed)
  }

  private lastClosedEnd(): number {
    let last = 0
    for (const p of this.closed) if (p.end_ts !== null && p.end_ts > last) last = p.end_ts
    return last
  }

  private async readRows(fromTs: number, toTs: number): Promise<VoyageRow[]> {
    const fromKey = hourKey(fromTs)
    const toKey = hourKey(toTs)
    const keys = (await this.store.listRawKeys()).filter((k) => k >= fromKey && k <= toKey)
    const out: VoyageRow[] = []
    for (const key of keys) {
      for (const r of await this.store.readRaw(key)) {
        if (r.ts >= fromTs && r.ts <= toTs) {
          out.push({ ts: r.ts, lat: r.lat, lon: r.lon, sog: r.sog, nav_state: r.nav_state, path_values: r.path_values })
        }
      }
    }
    return out
  }

  /** Structural fingerprint: changes when a phase opens or closes, not on the
   *  open phase's moving end. */
  private revision(): string {
    const open = this.machine.current()
    return `${this.closed.length}:${open?.kind ?? ''}:${open?.start_ts ?? ''}`
  }

  private async persistIfChanged(): Promise<void> {
    const rev = this.revision()
    if (rev === this.persistedRev) return
    await this.persist()
    this.persistedRev = rev
  }

  private async persist(): Promise<void> {
    const open = this.machine.current()
    const body: PersistedPhases = {
      phases: this.closed,
      open: open
        ? { kind: open.kind, start: { ts: open.start_ts, lat: open.start_lat, lon: open.start_lon } }
        : null
    }
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(body), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  /** Wait until queued work settles (stop() and tests). */
  flush(): Promise<void> {
    return this.enqueue(async () => undefined)
  }
}
