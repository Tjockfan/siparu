/**
 * Signal K path map and in-memory live state.
 *
 * Two field-proven rules shape this layer (see product diagnosis rules):
 *
 * 1. Concept subscriptions, not path subscriptions: "depth" is whichever of
 *    belowTransducer / belowKeel / belowSurface is present, in that priority
 *    order; true wind speed is speedTrue with speedOverGround as fallback.
 *    Installations disagree on paths; users never configure this.
 *
 * 2. Automatic source selection: the same path can arrive from several
 *    $sources (e.g. two GPS units) and values would flip-flop otherwise.
 *    Among fresh sources the highest-rate one wins, ties go to the freshest;
 *    when the active source goes stale the next one takes over. No user
 *    setting for this either.
 */
import { MetricField, Snapshot } from './contract'
import { INTERNAL, KN_TO_MS, Options } from './config'

/** Paths mapped 1:1 onto a snapshot field. */
const DIRECT_PATHS: Record<string, MetricField> = {
  'navigation.speedOverGround': 'sog',
  'navigation.courseOverGroundTrue': 'cog',
  'navigation.headingMagnetic': 'heading_mag',
  'navigation.headingTrue': 'heading_true',
  'navigation.rateOfTurn': 'rate_of_turn',
  'navigation.magneticVariation': 'magnetic_variation',
  'navigation.magneticDeviation': 'magnetic_deviation',
  'navigation.state': 'nav_state',
  'environment.wind.speedApparent': 'wind_speed_apparent',
  'environment.wind.angleApparent': 'wind_angle_apparent',
  'environment.wind.directionTrue': 'wind_direction_true',
  'environment.outside.temperature': 'air_temp_k',
  'environment.outside.pressure': 'air_pressure_pa',
  'environment.water.temperature': 'water_temp_k',
  'navigation.gnss.satellites': 'gps_satellites',
  'sensors.ais.class': 'ais_class'
}

const POSITION_PATH = 'navigation.position'

/** Concept -> candidate paths in priority order (first fresh wins). */
const TWS_PATHS = ['environment.wind.speedTrue', 'environment.wind.speedOverGround'] as const
const DEPTH_PATHS = [
  'environment.depth.belowTransducer',
  'environment.depth.belowKeel',
  'environment.depth.belowSurface'
] as const

export const SUBSCRIBED_PATHS: string[] = [
  POSITION_PATH,
  ...TWS_PATHS,
  ...DEPTH_PATHS,
  ...Object.keys(DIRECT_PATHS)
]

/**
 * Dynamic path families beyond the fixed core: engine, tank and generator
 * data a boat may expose. Subscribed by wildcard and carried on the live
 * frame under their plain SK path name (contract LiveResult.paths). The core
 * navigation/wind/depth paths keep their own hand-tuned handling; these ride
 * the same source-resolution machinery but are never mixed into a Snapshot.
 */
export const DYNAMIC_PREFIXES = ['propulsion.', 'tanks.', 'electrical.generators.'] as const

/** Core paths get bespoke handling; anything else in state is a dynamic path. */
const CORE_PATH_SET: ReadonlySet<string> = new Set(SUBSCRIBED_PATHS)

/**
 * The same discipline the relay applies to what a boat sends (its telemetry
 * sanitiser), applied where the data first lands. A compromised or misbehaving
 * bus member can emit arbitrary strings and invent paths; without these caps a
 * multi-megabyte string rides the uplink before the relay can truncate it, and
 * the path map grows without bound.
 */
const TEXT_MAX = 32
const MAX_DYNAMIC_PATHS = 64
const PATH_MAX_LEN = 128
// Dotted, alpha-led at the top, with digits, hyphens and underscores allowed in the
// segments below it: instance identifiers a gateway assigns are not always camelCase
// (electrical.generators.genset-1, tanks.fresh_water.0). The bound that matters is
// length and slot count, not grammar - narrowing the charset only drops legitimate
// gauges silently. Kept in step with the relay's telemetry sanitiser.
const PATH_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/

function isDynamicPath(path: string): boolean {
  return (
    !CORE_PATH_SET.has(path) &&
    path.length <= PATH_MAX_LEN &&
    PATH_RE.test(path) &&
    DYNAMIC_PREFIXES.some((p) => path.startsWith(p))
  )
}

const STRING_FIELDS: ReadonlySet<MetricField> = new Set(['nav_state', 'ais_class'])
const TWS_SET: ReadonlySet<string> = new Set(TWS_PATHS)

type StoredValue = number | string | { lat: number; lon: number }

interface SourceEntry {
  value: StoredValue
  ts: number
  /** Smoothed inter-sample interval; null until a second sample arrives. */
  emaIntervalMs: number | null
}

export interface Diagnosis {
  code: 'ok' | 'instruments-off' | 'energy-only' | 'no-data'
  message: string
  since_ts: number | null
}

export class MetricsState {
  /** path -> $source -> latest entry */
  private paths = new Map<string, Map<string, SourceEntry>>()
  private gustAccum: number | null = null
  lastDeltaTs: number | null = null

  constructor(private opts: Options) {}

  /**
   * Feed one path value (from a delta or the startup prime).
   * Returns true when the value was accepted.
   */
  ingest(path: string, value: unknown, ts: number, source?: string): boolean {
    let stored: StoredValue

    if (path === POSITION_PATH) {
      const v = value as { latitude?: unknown; longitude?: unknown } | null
      if (!v || typeof v.latitude !== 'number' || typeof v.longitude !== 'number') return false
      stored = { lat: v.latitude, lon: v.longitude }
    } else {
      const field = DIRECT_PATHS[path]
      const isConceptPath = TWS_SET.has(path) || (DEPTH_PATHS as readonly string[]).includes(path)
      const dynamic = !field && !isConceptPath && isDynamicPath(path)
      if (!field && !isConceptPath && !dynamic) return false
      if (field && STRING_FIELDS.has(field)) {
        if (typeof value !== 'string') return false
        stored = value.slice(0, TEXT_MAX)
      } else if (dynamic) {
        // A dynamic gauge value is a number (rpm, temperature, level) or a
        // short string (engine/generator state). Objects, booleans and the
        // like are not gauge readings and are dropped.
        if (typeof value === 'number' && Number.isFinite(value)) stored = value
        else if (typeof value === 'string') stored = value.slice(0, TEXT_MAX)
        else return false
        // A path never seen before claims a slot; a full table takes no new ones.
        if (!this.paths.has(path) && this.dynamicPathCount() >= MAX_DYNAMIC_PATHS) return false
      } else {
        if (typeof value !== 'number' || !Number.isFinite(value)) return false
        stored = value
      }
      // SOG sanity: AIS targets' SOG can leak into self via source-priority
      // issues (seen live at 132 kn); reject instead of recording garbage.
      if (field === 'sog') {
        const sog = stored as number
        if (sog < 0 || sog > this.opts.maxSogKnots * KN_TO_MS) return false
      }
    }

    let bySource = this.paths.get(path)
    if (!bySource) {
      bySource = new Map()
      this.paths.set(path, bySource)
    }
    const key = source ?? ''
    const prev = bySource.get(key)
    let emaIntervalMs = prev?.emaIntervalMs ?? null
    if (prev && ts > prev.ts) {
      const interval = ts - prev.ts
      emaIntervalMs = emaIntervalMs === null ? interval : 0.7 * emaIntervalMs + 0.3 * interval
    }
    bySource.set(key, { value: stored, ts, emaIntervalMs })
    this.lastDeltaTs = ts

    // Gust max-hold: remember the highest true wind speed seen since the
    // last snapshot flush - but only samples from the currently winning
    // TWS path+source, so a stale second anemometer can't inflate gusts.
    if (TWS_SET.has(path)) {
      const active = this.resolveConcept(TWS_PATHS, ts)
      if (active && active.path === path && active.source === key) {
        const tws = stored as number
        this.gustAccum = this.gustAccum === null ? tws : Math.max(this.gustAccum, tws)
      }
    }
    return true
  }

  /**
   * Winning source for a path: among fresh sources the highest rate wins,
   * ties go to the freshest sample; with no fresh source, last-known wins.
   */
  private resolveSource(path: string, now: number): { source: string; entry: SourceEntry } | null {
    const bySource = this.paths.get(path)
    if (!bySource || bySource.size === 0) return null
    let best: { source: string; entry: SourceEntry } | null = null
    let bestFresh = false
    for (const [source, entry] of bySource) {
      const fresh = now - entry.ts <= INTERNAL.staleMs
      if (best === null) {
        best = { source, entry }
        bestFresh = fresh
        continue
      }
      if (fresh !== bestFresh) {
        if (fresh) {
          best = { source, entry }
          bestFresh = true
        }
        continue
      }
      if (fresh) {
        const a = entry.emaIntervalMs ?? Infinity
        const b = best.entry.emaIntervalMs ?? Infinity
        if (a < b || (a === b && entry.ts > best.entry.ts)) best = { source, entry }
      } else if (entry.ts > best.entry.ts) {
        best = { source, entry }
      }
    }
    return best
  }

  /** First candidate path with a fresh source wins; else last-known by priority. */
  private resolveConcept(
    candidates: readonly string[],
    now: number
  ): { path: string; source: string; entry: SourceEntry } | null {
    let lastKnown: { path: string; source: string; entry: SourceEntry } | null = null
    for (const path of candidates) {
      const r = this.resolveSource(path, now)
      if (!r) continue
      if (now - r.entry.ts <= INTERNAL.staleMs) return { path, ...r }
      if (!lastKnown) lastKnown = { path, ...r }
    }
    return lastKnown
  }

  /**
   * Whether an entry may stand for a measurement taken at `now`. With no
   * horizon (the live path) it always may: showing the last known value is
   * the point, and the reader ages it separately.
   */
  private measuredAt(entry: SourceEntry, now: number, maxAgeMs?: number): boolean {
    return maxAgeMs === undefined || now - entry.ts <= maxAgeMs
  }

  private numeric(path: string, now: number, maxAgeMs?: number): number | null {
    const r = this.resolveSource(path, now)
    if (!r || !this.measuredAt(r.entry, now, maxAgeMs)) return null
    return typeof r.entry.value === 'number' ? r.entry.value : null
  }

  private str(path: string, now: number, maxAgeMs?: number): string | null {
    const r = this.resolveSource(path, now)
    if (!r || !this.measuredAt(r.entry, now, maxAgeMs)) return null
    return typeof r.entry.value === 'string' ? r.entry.value : null
  }

  private conceptNumeric(candidates: readonly string[], now: number, maxAgeMs?: number): number | null {
    const r = this.resolveConcept(candidates, now)
    if (!r || !this.measuredAt(r.entry, now, maxAgeMs)) return null
    return typeof r.entry.value === 'number' ? r.entry.value : null
  }

  /**
   * Current state in wire shape. `flushGust: true` (snapshot writes) returns
   * and resets the gust window; false (live reads) peeks without resetting.
   *
   * `freshnessMs` gates every field on the age of its own winning source, and
   * belongs to the recording path: a row's `ts` asserts that its values were
   * measured then, so a value older than the horizon is written as null rather
   * than fabricated. Omit it when reading live - there, last-known-wins is
   * correct and each field carries its own age instead (fieldAges).
   *
   * The gust is exempt by construction: it is a max-hold over the window that
   * just closed, so a wind sensor that stops simply contributes nothing to the
   * next one.
   */
  snapshot(now: number, flushGust: boolean, freshnessMs?: number): Snapshot {
    const gust = this.gustAccum
    if (flushGust) this.gustAccum = null

    const pos = this.resolveSource(POSITION_PATH, now)
    const posVal =
      pos && typeof pos.entry.value === 'object' && this.measuredAt(pos.entry, now, freshnessMs)
        ? pos.entry.value
        : null

    return {
      ts: now,
      lat: posVal?.lat ?? null,
      lon: posVal?.lon ?? null,
      sog: this.numeric('navigation.speedOverGround', now, freshnessMs),
      cog: this.numeric('navigation.courseOverGroundTrue', now, freshnessMs),
      heading_mag: this.numeric('navigation.headingMagnetic', now, freshnessMs),
      heading_true: this.numeric('navigation.headingTrue', now, freshnessMs),
      rate_of_turn: this.numeric('navigation.rateOfTurn', now, freshnessMs),
      magnetic_variation: this.numeric('navigation.magneticVariation', now, freshnessMs),
      magnetic_deviation: this.numeric('navigation.magneticDeviation', now, freshnessMs),
      nav_state: this.str('navigation.state', now, freshnessMs),
      wind_speed_apparent: this.numeric('environment.wind.speedApparent', now, freshnessMs),
      wind_angle_apparent: this.numeric('environment.wind.angleApparent', now, freshnessMs),
      wind_speed_true: this.conceptNumeric(TWS_PATHS, now, freshnessMs),
      wind_gust: gust,
      wind_direction_true: this.numeric('environment.wind.directionTrue', now, freshnessMs),
      air_temp_k: this.numeric('environment.outside.temperature', now, freshnessMs),
      air_pressure_pa: this.numeric('environment.outside.pressure', now, freshnessMs),
      depth: this.conceptNumeric(DEPTH_PATHS, now, freshnessMs),
      water_temp_k: this.numeric('environment.water.temperature', now, freshnessMs),
      gps_satellites: this.numeric('navigation.gnss.satellites', now, freshnessMs),
      ais_class: this.str('sensors.ais.class', now, freshnessMs)
    }
  }

  /**
   * Live values of the dynamic (non-core) paths, keyed by SK path name, each
   * resolved through the same winning-source logic as the core fields. Only
   * number/string values surface; a path with no fresh usable value is absent.
   */
  private dynamicPathCount(): number {
    let n = 0
    for (const path of this.paths.keys()) if (isDynamicPath(path)) n++
    return n
  }

  dynamicPaths(now: number): Record<string, number | string> {
    const out: Record<string, number | string> = {}
    for (const path of this.paths.keys()) {
      if (!isDynamicPath(path)) continue
      const r = this.resolveSource(path, now)
      if (r && (typeof r.entry.value === 'number' || typeof r.entry.value === 'string')) {
        out[path] = r.entry.value
      }
    }
    return out
  }

  /**
   * Age in seconds of each dynamic path's on-screen value: how long ago the
   * winning source last spoke. The key set matches dynamicPaths exactly - a
   * path with no usable value has no age. This is what lets the shore fade a
   * single frozen gauge on its own: the boat-wide data_age_s stays near zero
   * as long as any subscribed path (a live GPS) is still moving, so it cannot
   * see one instrument going quiet while the boat sails on.
   */
  dynamicPathAges(now: number): Record<string, number> {
    const out: Record<string, number> = {}
    for (const path of this.paths.keys()) {
      if (!isDynamicPath(path)) continue
      const r = this.resolveSource(path, now)
      if (r && (typeof r.entry.value === 'number' || typeof r.entry.value === 'string')) {
        out[path] = Math.round((now - r.entry.ts) / 1000)
      }
    }
    return out
  }

  /**
   * Age in seconds of each core snapshot field on screen: how long ago the
   * source behind that field last spoke. Keyed by snapshot field name, and
   * present only for fields that have a value at all.
   *
   * The counterpart of dynamicPathAges, and it exists for the same reason: a
   * reader showing a last-known value needs to know how old it is, per field.
   * data_age_s cannot answer that - it stays near zero while any subscribed
   * path keeps moving, so a boat sailing on a live GPS reports a healthy age
   * while her depth sounder has been dead for hours. `wind_gust` is absent by
   * construction: it is a max-hold over the window, not a reading with a source.
   */
  coreFieldAges(now: number): Partial<Record<MetricField, number>> {
    const out: Partial<Record<MetricField, number>> = {}
    const age = (entry: SourceEntry): number => Math.round((now - entry.ts) / 1000)

    const pos = this.resolveSource(POSITION_PATH, now)
    if (pos && typeof pos.entry.value === 'object') {
      out.lat = age(pos.entry)
      out.lon = age(pos.entry)
    }
    for (const [path, field] of Object.entries(DIRECT_PATHS)) {
      const r = this.resolveSource(path, now)
      if (r) out[field] = age(r.entry)
    }
    const tws = this.resolveConcept(TWS_PATHS, now)
    if (tws) out.wind_speed_true = age(tws.entry)
    const depth = this.resolveConcept(DEPTH_PATHS, now)
    if (depth) out.depth = age(depth.entry)
    return out
  }

  /**
   * Numeric-only dynamic path values, for the history snapshot. String gauges
   * (engine state) are dropped: history exists to be graphed and rolled up, and
   * min/max/avg have no meaning for "started". Live display keeps strings
   * (dynamicPaths); history does not.
   *
   * `freshnessMs` gates each gauge on its own source's age, as snapshot() does:
   * these ride the same recorded row under the same `ts`, so an engine that
   * stopped reporting must leave a gap in its graph rather than a flat line at
   * whatever it last said.
   */
  numericDynamicPaths(now: number, freshnessMs?: number): Record<string, number> {
    const out: Record<string, number> = {}
    for (const path of this.paths.keys()) {
      if (!isDynamicPath(path)) continue
      const r = this.resolveSource(path, now)
      if (r && typeof r.entry.value === 'number' && this.measuredAt(r.entry, now, freshnessMs)) {
        out[path] = r.entry.value
      }
    }
    return out
  }

  /** Per-path freshness + winning source, for /health micro-diagnosis. */
  pathAges(now: number): Record<string, { last_seen_ts: number; active_source: string | null; sources: number }> {
    const out: Record<string, { last_seen_ts: number; active_source: string | null; sources: number }> = {}
    for (const [path, bySource] of this.paths) {
      let last = 0
      for (const entry of bySource.values()) last = Math.max(last, entry.ts)
      const active = this.resolveSource(path, now)
      out[path] = {
        last_seen_ts: last,
        active_source: active ? active.source || null : null,
        sources: bySource.size
      }
    }
    return out
  }

  /**
   * Signature diagnosis instead of an empty dashboard: "no data at all",
   * "power data but no navigation data" (N2K bridge/cable/profile) and
   * "instruments have gone quiet" (normal at anchor) are distinct problems
   * and must read as such.
   */
  diagnose(now: number, hasElectricalData: boolean): Diagnosis {
    if (this.lastDeltaTs === null) {
      if (hasElectricalData) {
        return {
          code: 'energy-only',
          message:
            'Power data is present but no navigation data has arrived. Check the NMEA2000 connection (cable, CAN-bus profile).',
          since_ts: null
        }
      }
      return {
        code: 'no-data',
        message: 'No data received from Signal K yet. Check that your data sources are connected.',
        since_ts: null
      }
    }
    if (now - this.lastDeltaTs > INTERNAL.degradedAfterMs) {
      return {
        code: 'instruments-off',
        message: 'Instruments have been silent for a while - normal if the boat is shut down.',
        since_ts: this.lastDeltaTs
      }
    }
    return { code: 'ok', message: 'Receiving data.', since_ts: null }
  }
}
