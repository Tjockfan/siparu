/**
 * Activity phases: the raw band beneath the voyages.
 *
 * A boat is always in exactly one phase - under way, at anchor, on a mooring,
 * or stopped - and this machine reports the boundary when she moves from one to
 * the next. It is a sibling of the voyage state machine in voyage.ts and shares
 * its speed/nav-state reading, but it is entirely separate: it opens no voyage
 * and moves no voyage boundary, so the golden fixture stays green. The voyage
 * engine answers "which passages did she make"; this answers "what was she
 * doing", and a single voyage can contain an anchored phase in the middle of it
 * where she stopped for lunch.
 *
 * Pure and synchronous, like voyage.ts. Persistence lives in phaselog.ts.
 */
import { Phase, PhaseKind } from './contract'
import { VoyageOptions } from './config'
import { isMovingState, VoyageRow } from './voyage'

const MS_TO_KN = 1.94384
/** Gap above which the band is untrusted. Matches voyage.ts MAX_GAP_MS. */
const MAX_GAP_MS = 10 * 60 * 1000
/** Readings at or above this (kn) are garbage, ignored. Matches voyage.ts. */
const SOG_SANITY_KN = 80.0

/**
 * Classify one row into an activity kind. Real motion wins over a stale
 * anchored/moored nav_state: a boat reading "at anchor" while making way is
 * dragging or mislabelled, and her speed is the ground truth. When she is not
 * moving the nav_state names the kind; absent that, `stopped` is the honest
 * answer rather than a guess between anchor and mooring. A garbage SOG spike is
 * discarded rather than read as motion, the same guard the voyage engine uses.
 */
export function classifyPhase(row: VoyageRow, openKnots: number): PhaseKind {
  const raw = typeof row.sog === 'number' ? row.sog * MS_TO_KN : null
  const sogKn = raw !== null && raw < SOG_SANITY_KN ? raw : null
  if (isMovingState(row.nav_state) || (sogKn !== null && sogKn > openKnots)) return 'underway'
  const s = (row.nav_state ?? '').toLowerCase()
  if (s.includes('anchor')) return 'anchored'
  if (s.includes('moored')) return 'moored'
  return 'stopped'
}

interface Pt {
  ts: number
  lat: number | null
  lon: number | null
}

/** The open phase carried across a restart: its kind and where it began. */
export interface OpenPhase {
  kind: PhaseKind
  start: Pt
}

/**
 * Feed rows in chronological order; it returns the previous phase each time a
 * new one is confirmed. A change of kind must persist for phaseMinMinutes
 * before it counts, so a momentary blip does not split a phase in two, and the
 * confirmed phase is back-dated to where the change actually began. Streaks
 * reset across a data gap (> MAX_GAP_MS), as in the voyage engine.
 */
export class PhaseStateMachine {
  private curKind: PhaseKind | null = null
  private curStart: Pt | null = null
  private last: Pt | null = null
  private candKind: PhaseKind | null = null
  private candStart: Pt | null = null
  private candStreakMs = 0
  private lastTs: number | null = null

  constructor(
    private opts: VoyageOptions,
    restored?: OpenPhase | null
  ) {
    if (restored) {
      this.curKind = restored.kind
      this.curStart = restored.start
      this.last = restored.start
      this.lastTs = restored.start.ts
    }
  }

  /** The phase closed by this row, or null while the current one continues. */
  feed(row: VoyageRow): Phase | null {
    const raw = classifyPhase(row, this.opts.openKnots)
    const pt: Pt = { ts: row.ts, lat: row.lat, lon: row.lon }

    if (this.curKind === null) {
      this.curKind = raw
      this.curStart = pt
      this.last = pt
      this.lastTs = row.ts
      return null
    }

    const dt = this.lastTs !== null ? row.ts - this.lastTs : 0
    this.lastTs = row.ts
    this.last = pt

    // A gap breaks the streak but not the phase: what she did while off the air
    // is unknown, and the current phase simply resumes with the next row.
    if (dt < 0 || dt > MAX_GAP_MS) {
      this.candKind = null
      this.candStreakMs = 0
      return null
    }

    if (raw === this.curKind) {
      this.candKind = null
      this.candStreakMs = 0
      return null
    }

    // A different kind, on the clock: it must hold for phaseMinMinutes to
    // become a phase of its own. candStart is where it first appeared, which is
    // both the end of the old phase and the start of the new one.
    if (raw === this.candKind) {
      this.candStreakMs += dt
    } else {
      this.candKind = raw
      this.candStart = pt
      this.candStreakMs = 0
    }

    if (this.candStreakMs >= this.opts.phaseMinMinutes * 60_000) {
      const start = this.candStart as Pt
      const cur = this.curStart as Pt
      const closed: Phase = {
        kind: this.curKind,
        start_ts: cur.ts,
        end_ts: start.ts,
        start_lat: cur.lat,
        start_lon: cur.lon,
        end_lat: start.lat,
        end_lon: start.lon
      }
      this.curKind = this.candKind as PhaseKind
      this.curStart = start
      this.candKind = null
      this.candStreakMs = 0
      return closed
    }
    return null
  }

  /** The phase currently in progress, or null before the first row. */
  current(): Phase | null {
    if (this.curKind === null || this.curStart === null) return null
    const end = this.last ?? this.curStart
    return {
      kind: this.curKind,
      start_ts: this.curStart.ts,
      end_ts: null,
      start_lat: this.curStart.lat,
      start_lon: this.curStart.lon,
      end_lat: end.lat,
      end_lon: end.lon
    }
  }
}
