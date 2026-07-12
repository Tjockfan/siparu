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
import { ReconcileState, VoyageRow, reconcile } from './voyage'

const MS_TO_KN = 1.94384
const round2 = (x: number) => Math.round(x * 100) / 100

interface PersistedState {
  nextId: number
  voyages: Voyage[]
}

export class VoyageLog {
  private state: ReconcileState = { voyages: [], nextId: 1 }
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
        nav_state: snap.nav_state
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
          out.push({ ts: r.ts, lat: r.lat, lon: r.lon, sog: r.sog, nav_state: r.nav_state })
        }
      }
    }
    return out
  }

  private async runReconcile(now: number): Promise<void> {
    await reconcile(
      this.state,
      this.window,
      this.opts.voyage,
      this.opts.ports,
      async (fromTs, toTs) => {
        // Integration ranges are usually inside the in-memory window; merge
        // re-integration can reach back before it and falls through to disk.
        const first = this.window[0]
        if (first && fromTs >= first.ts) {
          return this.window.filter((r) => r.ts >= fromTs && r.ts <= toTs)
        }
        return this.readRows(fromTs, toTs)
      },
      now
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
    const body: PersistedState = { nextId: this.state.nextId, voyages: this.state.voyages }
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(body), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  /** Wait until queued work settles (stop() and tests). */
  flush(): Promise<void> {
    return this.enqueue(async () => undefined)
  }
}
