/**
 * Voyage engine core: a persistence-window state machine that opens a voyage
 * after sustained movement, closes it after sustained stillness, integrates
 * distance/time metrics over the raw snapshots, and merges spurious short
 * legs (tender pick-up manoeuvres) into the preceding voyage.
 *
 * This is a behavior-equal port of a battle-tested reference implementation;
 * plugin/test/fixtures/ pins its output on ten days of real vessel data.
 * Changing ANY threshold or ordering here silently rewrites people's voyage
 * history - the golden test must stay green, no exceptions.
 *
 * Everything in this file is pure and synchronous; persistence and the live
 * feed live in voyagelog.ts.
 */
import { Snapshot, Voyage } from './contract'
import { PortEntry, VoyageOptions } from './config'
import { haversineNm } from './rollup'

/** The subset of a snapshot the engine consumes. */
export type VoyageRow = Pick<Snapshot, 'ts' | 'lat' | 'lon' | 'sog' | 'nav_state' | 'path_values'>

/** Cubic metres per second into litres. */
const M3_TO_L = 1000

/**
 * The combined instantaneous fuel burn a snapshot reports, summed across every
 * engine (`propulsion.<instance>.fuel.rate`, SI m3/s), or null when the boat
 * reports none. Twin engines are added because a trip's fuel is the boat's, not
 * one shaft's; the null is load-bearing - it is the difference between "burned
 * nothing" and "cannot know", and only the second suppresses the figure.
 *
 * `allow`, when given, restricts the sum to exactly those paths. Summing every
 * engine is wrong for a boat where more than one source reports the same one
 * (two fuel-rate paths for one engine double the figure), and only the owner
 * knows which is real. It is only ever passed non-empty; empty means "every
 * engine", the default that keeps existing voyage history unchanged.
 */
function engineFuelRate(pv: Snapshot['path_values'], allow?: ReadonlySet<string>): number | null {
  if (!pv) return null
  let sum = 0
  let seen = false
  for (const path in pv) {
    if (path.startsWith('propulsion.') && path.endsWith('.fuel.rate')) {
      if (allow && !allow.has(path)) continue
      const v = pv[path]
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v
        seen = true
      }
    }
  }
  return seen ? sum : null
}

const MS_TO_KN = 1.94384
/** Counted as actually moving for hours_underway (0.3 kn, in m/s). */
const LIVE_SOG_MS = 0.3 / MS_TO_KN
/** Gap above which integration and streaks stop trusting the segment. */
const MAX_GAP_MS = 10 * 60 * 1000
/** SOG readings at/above this (kn) are ignored as garbage inside the engine. */
const SOG_SANITY_KN = 80.0
/** A single integration leg longer than this (NM) is a teleport, not a leg. */
const MAX_LEG_NM = 10.0

const round2 = (x: number) => Math.round(x * 100) / 100
const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * True if nav_state EXPLICITLY declares active passage ("under way ...").
 * Deliberately does NOT match "motoring": on many boats that is the default
 * engine-on state and persists at SOG 0 (idling at the dock), which would
 * open phantom voyages. Real movement is caught by the SOG threshold.
 */
export function isMovingState(s: string | null): boolean {
  return !!s && s.toLowerCase().includes('way')
}

export function isStationaryState(s: string | null): boolean {
  if (!s) return false
  const l = s.toLowerCase()
  return l.includes('moored') || l.includes('anchor')
}

export interface VoyageMetrics {
  distance_nm: number
  hours_underway: number
  avg_sog_kn: number | null
  max_sog_kn: number | null
  fuel_used_l: number | null
  end_lat: number | null
  end_lon: number | null
}

/** Walk snapshots in chronological order and integrate distance / time / fuel. */
export function integrateMetrics(snaps: VoyageRow[], fuelRatePaths?: readonly string[]): VoyageMetrics {
  const fuelAllow = fuelRatePaths && fuelRatePaths.length > 0 ? new Set(fuelRatePaths) : undefined
  let distanceNm = 0
  let secondsUnderway = 0
  let maxSogKn = 0
  let fuelM3 = 0
  let sawFuel = false
  let lastLat: number | null = null
  let lastLon: number | null = null
  let lastTs: number | null = null
  let lastFuelRate: number | null = null
  let endLat: number | null = null
  let endLon: number | null = null

  for (const s of snaps) {
    const ts = s.ts
    const sog = s.sog
    const lat = s.lat
    const lon = s.lon
    const fuelRate = engineFuelRate(s.path_values, fuelAllow)
    if (fuelRate !== null) sawFuel = true

    if (typeof sog === 'number') {
      const sogKn = sog * MS_TO_KN
      if (sogKn >= 0 && sogKn < 100 && sogKn > maxSogKn) maxSogKn = sogKn
    }

    if (lastTs !== null) {
      const dtMs = ts - lastTs
      if (dtMs > 0 && dtMs <= MAX_GAP_MS) {
        if (typeof sog === 'number' && sog > LIVE_SOG_MS) secondsUnderway += dtMs / 1000

        if (lat !== null && lon !== null && lastLat !== null && lastLon !== null) {
          const leg = haversineNm(lastLat, lastLon, lat, lon)
          if (leg >= 0 && leg < MAX_LEG_NM) distanceNm += leg
        }

        // Trapezoidal over the burn rate, and only across a segment the engine
        // reports at both ends: a half-known segment is left out, never halved.
        // Not gated on movement - an engine idling at anchor still burns.
        if (lastFuelRate !== null && fuelRate !== null) {
          fuelM3 += ((lastFuelRate + fuelRate) / 2) * (dtMs / 1000)
        }
      }
    }

    lastTs = ts
    lastFuelRate = fuelRate
    if (lat !== null && lon !== null) {
      lastLat = lat
      lastLon = lon
      endLat = lat
      endLon = lon
    }
  }

  const hoursUnderway = secondsUnderway / 3600
  const avg = hoursUnderway > 0.005 ? distanceNm / hoursUnderway : null
  return {
    distance_nm: round3(distanceNm),
    hours_underway: round3(hoursUnderway),
    avg_sog_kn: avg !== null ? round2(avg) : null,
    max_sog_kn: maxSogKn > 0 ? round2(maxSogKn) : null,
    fuel_used_l: sawFuel ? round3(fuelM3 * M3_TO_L) : null,
    end_lat: endLat,
    end_lon: endLon
  }
}

/**
 * The open/close state machine. Feed rows in chronological order; it reports
 * boundary events. dt-based streaks reset across gaps (> MAX_GAP_MS), an
 * explicit "under way" nav_state opens instantly, and voyage starts are
 * back-dated by the accumulated streak so the first leg isn't lost.
 */
export class VoyageStateMachine {
  private movingStreakMs = 0
  private stationaryStreakMs = 0
  private lastTs: number | null = null

  constructor(
    private opts: VoyageOptions,
    /** True when a voyage is currently open (restored across restarts). */
    public open: boolean
  ) {}

  /** Returns an event when this row opens or closes a voyage. */
  feed(row: VoyageRow): { type: 'open'; startTs: number } | { type: 'close' } | null {
    const ts = row.ts
    const sogKn = typeof row.sog === 'number' ? row.sog * MS_TO_KN : null
    const sogValid = sogKn !== null && sogKn < SOG_SANITY_KN ? sogKn : null

    const moving = isMovingState(row.nav_state) || (sogValid !== null && sogValid > this.opts.openKnots)
    // Close on sustained low SOG, or on moored/anchored nav_state when SOG is
    // absent (some installations stop publishing SOG at rest). The open
    // threshold (>x) and close threshold (<=x) split exactly - no flip-flop.
    const stationary =
      (sogValid !== null && sogValid <= this.opts.openKnots) ||
      (isStationaryState(row.nav_state) && sogValid === null)

    const dtMs = this.lastTs !== null ? ts - this.lastTs : 0
    if (dtMs < 0 || dtMs > MAX_GAP_MS) {
      this.movingStreakMs = 0
      this.stationaryStreakMs = 0
      this.lastTs = ts
      return null
    }
    this.lastTs = ts

    if (!this.open) {
      this.movingStreakMs = moving ? this.movingStreakMs + dtMs : 0
      const triggerNow = isMovingState(row.nav_state)
      if (triggerNow || this.movingStreakMs >= this.opts.openMinutes * 60_000) {
        const startTs = this.movingStreakMs > 0 ? ts - this.movingStreakMs : ts
        this.open = true
        this.movingStreakMs = 0
        this.stationaryStreakMs = 0
        return { type: 'open', startTs }
      }
    } else {
      this.stationaryStreakMs = stationary ? this.stationaryStreakMs + dtMs : 0
      if (this.stationaryStreakMs >= this.opts.closeMinutes * 60_000) {
        this.open = false
        this.movingStreakMs = 0
        this.stationaryStreakMs = 0
        return { type: 'close' }
      }
    }
    return null
  }
}

/**
 * Merge pass: a short leg right after a short stop, starting where the
 * previous voyage ended, is a manoeuvre (tender separation before docking),
 * not a real voyage - fold it into the predecessor. Chain-merging: the
 * grown predecessor may swallow the next leg too. Closed voyages only.
 */
export async function mergeContiguousVoyages(
  voyages: Voyage[],
  opts: VoyageOptions,
  reintegrate: (v: Voyage) => Promise<void>
): Promise<Voyage[]> {
  const closed = voyages.filter((v) => v.status === 'closed').sort((a, b) => a.start_ts - b.start_ts)
  const rest = voyages.filter((v) => v.status !== 'closed')
  let idx = 1
  while (idx < closed.length) {
    const p = closed[idx - 1] as Voyage
    const v = closed[idx] as Voyage
    const gap = p.end_ts !== null ? v.start_ts - p.end_ts : null
    const hop =
      p.end_lat !== null && p.end_lon !== null && v.start_lat !== null && v.start_lon !== null
        ? haversineNm(p.end_lat, p.end_lon, v.start_lat, v.start_lon)
        : null
    if (
      gap !== null &&
      gap >= 0 &&
      gap <= opts.mergeMaxGapMinutes * 60_000 &&
      hop !== null &&
      hop <= opts.mergeMaxHopNm &&
      v.distance_nm <= opts.mergeShortNm
    ) {
      // Extend p to v's end; the real arrival port is v's (p's old end_port
      // was the separation point - stale).
      p.end_ts = v.end_ts
      p.end_lat = v.end_lat
      p.end_lon = v.end_lon
      p.end_port = v.end_port
      await reintegrate(p) // the stop contributes ~0: SOG ~0 there
      closed.splice(idx, 1)
      // idx stays - p may swallow the next leg too (chain)
    } else {
      idx++
    }
  }
  return [...closed, ...rest]
}

export interface ReconcileState {
  voyages: Voyage[]
  nextId: number
}

/**
 * Batch reconcile over a chronological row window. `rows` must start at the
 * open voyage's start_ts (so its metrics re-aggregate) or after the last
 * closed voyage's end. Mutates and returns `state`. The golden fixture test
 * runs exactly this path; the live engine feeds the same state machine
 * incrementally and reuses integrate/merge, so the two cannot drift.
 */
export async function reconcile(
  state: ReconcileState,
  rows: VoyageRow[],
  opts: VoyageOptions,
  ports: PortEntry[],
  readRange: (fromTs: number, toTs: number) => Promise<VoyageRow[]>,
  now?: number,
  fuelRatePaths?: readonly string[]
): Promise<ReconcileState> {
  let openVoyage = state.voyages.find((v) => v.status === 'open') ?? null
  const sm = new VoyageStateMachine(opts, openVoyage !== null)

  for (const row of rows) {
    const event = sm.feed(row)
    if (!event) continue
    if (event.type === 'open' && !openVoyage) {
      openVoyage = {
        id: state.nextId++,
        start_ts: event.startTs,
        end_ts: null,
        start_lat: row.lat,
        start_lon: row.lon,
        end_lat: null,
        end_lon: null,
        distance_nm: 0,
        hours_underway: 0,
        avg_sog_kn: null,
        max_sog_kn: null,
        fuel_used_l: null,
        start_port: nearestPort(row.lat, row.lon, ports),
        end_port: null,
        status: 'open'
      }
      state.voyages.push(openVoyage)
    } else if (event.type === 'close' && openVoyage) {
      openVoyage.end_ts = row.ts
      openVoyage.end_lat = row.lat
      openVoyage.end_lon = row.lon
      openVoyage.status = 'closed'
      await applyMetrics(openVoyage, readRange, now, fuelRatePaths)
      openVoyage.end_port = nearestPort(openVoyage.end_lat, openVoyage.end_lon, ports)
      openVoyage = null
    }
  }

  if (openVoyage) await applyMetrics(openVoyage, readRange, now, fuelRatePaths)

  state.voyages = await mergeContiguousVoyages(state.voyages, opts, async (v) => {
    await applyMetrics(v, readRange, now, fuelRatePaths)
    v.end_port = nearestPort(v.end_lat, v.end_lon, ports)
  })
  state.voyages.sort((a, b) => a.start_ts - b.start_ts)
  return state
}

/**
 * Re-integrate a voyage's metrics over its full [start, end] range.
 * end_lat/end_lon always become the last fix inside the range (a closing
 * row without a fix falls back to the last known position).
 */
export async function applyMetrics(
  v: Voyage,
  readRange: (fromTs: number, toTs: number) => Promise<VoyageRow[]>,
  now?: number,
  fuelRatePaths?: readonly string[]
): Promise<void> {
  const endTs = v.end_ts ?? now ?? Date.now()
  const m = integrateMetrics(await readRange(v.start_ts, endTs), fuelRatePaths)
  v.distance_nm = m.distance_nm
  v.hours_underway = m.hours_underway
  v.avg_sog_kn = m.avg_sog_kn
  v.max_sog_kn = m.max_sog_kn
  v.fuel_used_l = m.fuel_used_l
  v.end_lat = m.end_lat
  v.end_lon = m.end_lon
}

/** Closest configured port within its radius; null keeps the coordinate fallback. */
export function nearestPort(lat: number | null, lon: number | null, ports: PortEntry[]): string | null {
  if (lat === null || lon === null) return null
  let best: string | null = null
  let bestD = Infinity
  for (const p of ports) {
    const d = haversineNm(lat, lon, p.latitude, p.longitude)
    if (d <= p.radiusNm && d < bestD) {
      bestD = d
      best = p.name
    }
  }
  return best
}
