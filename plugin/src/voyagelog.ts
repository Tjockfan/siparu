/**
 * Voyage persistence and the live feed.
 *
 * Single code path by design: every appended snapshot re-runs the same batch
 * reconcile the golden fixture pins, over an in-memory row window that starts
 * at the last voyage boundary. Incremental and batch behavior therefore
 * cannot drift apart. The window is bounded (rows before the last boundary
 * are dropped) and reconcile over it costs milliseconds.
 *
 * voyages.json is written atomically (tmp + rename - boats lose power) and
 * only on structural change (open/close/merge), never on the per-minute
 * metric refresh of an open voyage: that state is recomputed by replay on
 * startup anyway, and eMMC wear is a real budget.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { RollupHour, Snapshot, TrackPoint, Voyage, VoyageStatsResult, VoyageWindowStats } from './contract'
import { Options } from './config'
import { RollupEngine } from './rollup'
import { Logger, Store } from './store'
import { hourKey, startOfUtcDay } from './time'
import { ReconcileState, VoyageRow, applyMetrics, nearestPort, reconcile } from './voyage'

const MS_TO_KN = 1.94384
const round2 = (x: number) => Math.round(x * 100) / 100

/**
 * A voyage whose boundaries the owner set himself, and the voyages it was made of.
 *
 * Kept here and not on `Voyage`, which is the wire type: nothing ashore needs to
 * know that a passage was edited, because what it asks for is the passage. Putting
 * the mark in the contract would put it in front of the relay, the portal and the
 * phone, all of which would then have a field to ignore.
 *
 * `parts` is what makes the edit reversible. Empty means there is nothing to put
 * back - either the voyage was only ever marked, or it has already been undone -
 * and the mark still stands, because "these are separate passages" is a decision
 * the automatic pass must go on respecting.
 */
interface ManualEdit {
  id: number
  parts: { start_ts: number; end_ts: number }[]
}

interface PersistedState {
  nextId: number
  voyages: Voyage[]
  manual?: ManualEdit[]
}

/** What a hand edit answers with: the voyage that now exists, or why nothing happened. */
export type EditResult = { ok: true; id: number } | { ok: false; error: string }

const failed = (error: string): EditResult => ({ ok: false, error })

export class VoyageLog {
  private state: ReconcileState = { voyages: [], nextId: 1 }
  private manual: ManualEdit[] = []
  /** Rows since the last voyage boundary, ascending; fed to every reconcile. */
  private window: VoyageRow[] = []
  private chain: Promise<void> = Promise.resolve()
  private persistedRevision = ''
  private filePath: string

  constructor(
    private store: Store,
    private opts: Options,
    private log: Logger
  ) {
    this.filePath = path.join(store.rollupDir, 'voyages.json')
  }

  /** Serialize a job onto the reconcile chain (the mutex of the Python original). */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job)
    this.chain = run.then(
      () => undefined,
      (err) => this.log(`voyage error: ${err}`)
    )
    return run
  }

  async init(now: number): Promise<void> {
    return this.enqueue(async () => {
      try {
        const raw = await fs.readFile(this.filePath, 'utf8')
        const parsed = JSON.parse(raw) as PersistedState
        if (Array.isArray(parsed.voyages) && typeof parsed.nextId === 'number') {
          this.state = { voyages: parsed.voyages, nextId: parsed.nextId }
          // Absent on a file written before hand edits existed, which is every
          // boat upgrading into this: no marks, so the pass behaves as it did.
          if (Array.isArray(parsed.manual)) this.manual = parsed.manual
        }
      } catch {
        // first run or unreadable file - start empty, history rebuilds below
      }
      this.persistedRevision = this.revision()
      // Replay everything since the last boundary so a restart mid-voyage
      // reconstructs streaks and open-voyage metrics.
      this.window = await this.readRows(this.scanStart(), now)
      await this.runReconcile(now)
    })
  }

  /** Feed one appended snapshot; triggers a reconcile over the window. */
  feed(snap: Snapshot): Promise<void> {
    return this.enqueue(async () => {
      this.window.push({
        ts: snap.ts,
        lat: snap.lat,
        lon: snap.lon,
        sog: snap.sog,
        nav_state: snap.nav_state,
        path_values: snap.path_values
      })
      await this.runReconcile(snap.ts)
    })
  }

  /** Newest first, like the reference API. */
  list(limit: number): Voyage[] {
    return [...this.state.voyages].sort((a, b) => b.start_ts - a.start_ts).slice(0, limit)
  }

  current(): Voyage | null {
    return this.state.voyages.find((v) => v.status === 'open') ?? null
  }

  async track(voyageId: number, now: number): Promise<TrackPoint[]> {
    const v = this.state.voyages.find((x) => x.id === voyageId)
    if (!v) return []
    const rows = await this.readRows(v.start_ts, v.end_ts ?? now)
    const out: TrackPoint[] = []
    for (const r of rows) {
      if (r.lat === null || r.lon === null) continue
      const kn = typeof r.sog === 'number' ? r.sog * MS_TO_KN : null
      out.push({
        ts: r.ts,
        lat: r.lat,
        lon: r.lon,
        sog: kn !== null && kn >= 0 && kn < 50 ? round2(kn) : null
      })
    }
    return out
  }

  /**
   * Stats cards. Voyage portions are prorated linearly over the window;
   * peak SOG is non-linear and comes from the data instead - today's raw
   * plus hourly rollup maxima (window edges snap to the hour there; the
   * error is bounded and the alternative is scanning pruned history).
   */
  async stats(rollups: RollupEngine, now: number): Promise<VoyageStatsResult> {
    const DAY = 86_400_000
    const todayStart = Math.floor(now / DAY) * DAY
    return {
      today: await this.windowStats(rollups, todayStart, now, now),
      yesterday: await this.windowStats(rollups, todayStart - DAY, todayStart, now),
      rolling_7d: await this.windowStats(rollups, now - 7 * DAY, now, now),
      season: await this.windowStats(rollups, this.seasonStartMs(now), now, now)
    }
  }

  /** Most recent occurrence of the configured MM-DD season start (UTC). */
  private seasonStartMs(now: number): number {
    const [mm, dd] = this.opts.seasonStart.split('-').map((x) => parseInt(x, 10))
    const d = new Date(now)
    let start = Date.UTC(d.getUTCFullYear(), (mm ?? 1) - 1, dd ?? 1)
    if (start > now) start = Date.UTC(d.getUTCFullYear() - 1, (mm ?? 1) - 1, dd ?? 1)
    return start
  }

  private async windowStats(
    rollups: RollupEngine,
    winStart: number,
    winEnd: number,
    now: number
  ): Promise<VoyageWindowStats> {
    let distance = 0
    let hours = 0
    for (const v of this.state.voyages) {
      const vStart = v.start_ts
      const vEnd = v.end_ts ?? winEnd
      const s = Math.max(vStart, winStart)
      const e = Math.min(vEnd, winEnd)
      if (e <= s) continue
      const frac = (e - s) / Math.max(1, vEnd - vStart)
      distance += v.distance_nm * frac
      hours += v.hours_underway * frac
    }

    let maxMs: number | null = null
    for (const h of await rollups.readHourly(winStart, winEnd)) {
      const m = (h as RollupHour).metrics.sog
      if (m && typeof m.max === 'number') maxMs = maxMs === null ? m.max : Math.max(maxMs, m.max)
    }
    const today = startOfUtcDay(now)
    if (winEnd > today) {
      for (const key of (await this.store.listRawKeys()).filter((k) => k >= hourKey(today))) {
        for (const r of await this.store.readRaw(key)) {
          if (r.ts < winStart || r.ts > winEnd || typeof r.sog !== 'number') continue
          maxMs = maxMs === null ? r.sog : Math.max(maxMs, r.sog)
        }
      }
    }
    let maxKn: number | null = null
    if (maxMs !== null) {
      const kn = maxMs * MS_TO_KN
      if (kn >= 0 && kn < 100) maxKn = kn
    }

    const avg = hours > 0.005 ? distance / hours : null
    return {
      distance_nm: round2(distance),
      hours_underway: round2(hours),
      avg_sog_kn: avg !== null ? round2(avg) : null,
      max_sog_kn: maxKn !== null ? round2(maxKn) : null
    }
  }

  /** Open voyage's start (re-aggregate it), else last closed end, else 0. */
  private scanStart(): number {
    const open = this.state.voyages.find((v) => v.status === 'open')
    if (open) return open.start_ts
    let last = 0
    for (const v of this.state.voyages) {
      if (v.status === 'closed' && v.end_ts !== null && v.end_ts > last) last = v.end_ts
    }
    return last
  }

  /** Raw rows in [fromTs, toTs] from whatever hour files are still on disk. */
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

  /**
   * The rows a re-integration reads. Integration ranges are usually inside the
   * in-memory window; a merge reaching back before it falls through to disk, and
   * a hand edit on last month's passage always does.
   */
  private range = async (fromTs: number, toTs: number): Promise<VoyageRow[]> => {
    const first = this.window[0]
    if (first && fromTs >= first.ts) {
      return this.window.filter((r) => r.ts >= fromTs && r.ts <= toTs)
    }
    return this.readRows(fromTs, toTs)
  }

  private async runReconcile(now: number): Promise<void> {
    await reconcile(
      this.state,
      this.window,
      this.opts.voyage,
      this.opts.ports,
      this.range,
      now,
      this.opts.fuelRatePaths,
      this.manualIds()
    )
    // Drop window rows that precede the new boundary.
    const start = this.scanStart()
    if (this.window.length > 0 && (this.window[0] as VoyageRow).ts < start) {
      this.window = this.window.filter((r) => r.ts >= start)
    }
    const rev = this.revision()
    if (rev !== this.persistedRevision) {
      await this.persist()
      this.persistedRevision = rev
    }
  }

  /** Structural fingerprint: changes on open/close/merge, not on metric refresh. */
  private revision(): string {
    return this.state.voyages.map((v) => `${v.id}:${v.status}:${v.end_ts ?? ''}`).join('|')
  }

  private async persist(): Promise<void> {
    const body: PersistedState = {
      nextId: this.state.nextId,
      voyages: this.state.voyages,
      manual: this.manual
    }
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(body), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  private manualIds(): ReadonlySet<number> {
    return new Set(this.manual.map((m) => m.id))
  }

  /** What the screen needs to draw the edit affordances: which voyages can be put back. */
  edits(): { merged: number[] } {
    return { merged: this.manual.filter((m) => m.parts.length > 1).map((m) => m.id) }
  }

  private partsOf(id: number): { start_ts: number; end_ts: number }[] | null {
    const m = this.manual.find((x) => x.id === id)
    return m && m.parts.length > 0 ? m.parts : null
  }

  /** A hand edit writes at once; the reconcile fingerprint would only catch it later. */
  private async persistEdit(): Promise<void> {
    await this.persist()
    this.persistedRevision = this.revision()
  }

  /**
   * Fold a voyage into the one before it, because the boat stopped long enough
   * for the engine to call one passage two.
   *
   * The earlier voyage is the one that survives and grows, which is what the
   * automatic pass does too: a passage is named by where it began. Metrics are
   * re-integrated over the whole span rather than added up, so the stop between
   * the legs is counted the way it would have been had the engine never split
   * them - lying at anchor for an hour adds an hour to neither distance nor time
   * under way, and adds whatever the engine burned to the fuel.
   *
   * Only closed voyages. An open one is still being written by the state machine,
   * and its end does not exist yet to merge to.
   */
  mergeWithPrevious(id: number, now: number): Promise<EditResult> {
    return this.enqueue(async () => {
      const v = this.state.voyages.find((x) => x.id === id)
      if (!v) return failed('not_found')
      if (v.status !== 'closed' || v.end_ts === null) return failed('voyage_open')

      let p: Voyage | null = null
      for (const c of this.state.voyages) {
        if (c.id === v.id || c.status !== 'closed' || c.end_ts === null) continue
        if (c.start_ts >= v.start_ts) continue
        if (!p || c.start_ts > p.start_ts) p = c
      }
      if (!p) return failed('no_previous')

      const pWas = { start_ts: p.start_ts, end_ts: p.end_ts as number }
      const vWas = { start_ts: v.start_ts, end_ts: v.end_ts }
      const pParts = this.partsOf(p.id) ?? [pWas]
      const vParts = this.partsOf(v.id) ?? [vWas]

      p.end_ts = v.end_ts
      p.end_lat = v.end_lat
      p.end_lon = v.end_lon
      await applyMetrics(p, this.range, now, this.opts.fuelRatePaths)
      p.end_port = nearestPort(p.end_lat, p.end_lon, this.opts.ports)

      this.state.voyages = this.state.voyages.filter((x) => x.id !== v.id)
      this.manual = this.manual.filter((m) => m.id !== p.id && m.id !== v.id)
      this.manual.push({ id: p.id, parts: [...pParts, ...vParts] })

      await this.persistEdit()
      return { ok: true, id: p.id }
    })
  }

  /**
   * Put a merged voyage back into the voyages it was made of.
   *
   * The parts are replayed from the raw store rather than restored from anything
   * remembered, so a part comes back with the figures the data supports today. The
   * first keeps the id, so a voyage a person has been looking at does not change
   * number under him.
   *
   * Every part stays marked, with nothing left to undo. He has said these are
   * separate passages, and the automatic pass would otherwise rejoin them on the
   * next snapshot: they sit at a gap of zero and a hop of zero, the strongest case
   * its thresholds know.
   */
  undoMerge(id: number, now: number): Promise<EditResult> {
    return this.enqueue(async () => {
      const parts = this.partsOf(id)
      if (!parts || parts.length < 2) return failed('nothing_to_undo')
      const v = this.state.voyages.find((x) => x.id === id)
      if (!v) return failed('not_found')

      const ordered = [...parts].sort((a, b) => a.start_ts - b.start_ts)
      const rebuilt: Voyage[] = []
      for (let i = 0; i < ordered.length; i++) {
        const part = ordered[i] as { start_ts: number; end_ts: number }
        const target: Voyage = i === 0 ? v : { ...v, id: this.state.nextId++ }
        target.start_ts = part.start_ts
        target.end_ts = part.end_ts
        target.status = 'closed'
        const rows = await this.range(part.start_ts, part.end_ts)
        const firstFix = rows.find((r) => r.lat !== null && r.lon !== null)
        target.start_lat = firstFix?.lat ?? null
        target.start_lon = firstFix?.lon ?? null
        target.start_port = nearestPort(target.start_lat, target.start_lon, this.opts.ports)
        await applyMetrics(target, this.range, now, this.opts.fuelRatePaths)
        target.end_port = nearestPort(target.end_lat, target.end_lon, this.opts.ports)
        rebuilt.push(target)
      }

      this.state.voyages = [...this.state.voyages.filter((x) => x.id !== id), ...rebuilt].sort(
        (a, b) => a.start_ts - b.start_ts
      )
      this.manual = this.manual.filter((m) => m.id !== id)
      for (const r of rebuilt) this.manual.push({ id: r.id, parts: [] })

      await this.persistEdit()
      return { ok: true, id: v.id }
    })
  }

  /** Wait until queued work settles (stop() and tests). */
  flush(): Promise<void> {
    return this.enqueue(async () => undefined)
  }
}
