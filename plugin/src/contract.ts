/**
 * Siparu wire contract.
 *
 * These shapes are served by the local read-only REST API today and MUST stay
 * platform-neutral: the Phase-2 relay history RPC transports the exact same
 * query/result shapes over WSS ({id, query} -> chunked result). Nothing
 * Cloudflare- or transport-specific may leak in here.
 *
 * Field names are snake_case on the wire; the webapp consumes them as-is.
 */

/** All units are SI as delivered by Signal K (m/s, radians, Kelvin, Pascal). */
export interface Snapshot {
  ts: number // epoch ms, UTC
  lat: number | null
  lon: number | null
  sog: number | null
  cog: number | null
  heading_mag: number | null
  heading_true: number | null
  rate_of_turn: number | null
  magnetic_variation: number | null
  magnetic_deviation: number | null
  nav_state: string | null
  wind_speed_apparent: number | null
  wind_angle_apparent: number | null
  wind_speed_true: number | null
  /** Max-hold peak of true wind speed seen between snapshots (m/s). */
  wind_gust: number | null
  wind_direction_true: number | null
  air_temp_k: number | null
  air_pressure_pa: number | null
  depth: number | null
  water_temp_k: number | null
  gps_satellites: number | null
  ais_class: string | null
  /**
   * Numeric dynamic gauge values (engine, tank, generator) captured at this
   * snapshot, keyed by plain SK path name. Absent on a boat that exposes none.
   * History only: written to NDJSON and rolled up so a gauge can be graphed
   * over time. The live frame carries its own `paths` (LiveResult), which also
   * includes string gauges; this is numbers alone, because history is graphed.
   */
  path_values?: Record<string, number>
}

export type MetricField = Exclude<keyof Snapshot, 'ts' | 'path_values'>

/** Per-metric aggregate inside a rollup line. Angular and string fields carry `last` only. */
export interface MetricAgg {
  min?: number
  max?: number
  avg?: number
  last: number | string | null
}

/** One closed UTC hour, materialized when the hour's raw file closes. */
export interface RollupHour {
  /** e.g. "2026-07-10T21" (UTC) */
  hour: string
  count: number
  first_ts: number
  last_ts: number
  /** Haversine over consecutive fixes; segments implying > guard speed are skipped. */
  distance_nm: number
  pos_first: { lat: number; lon: number } | null
  pos_last: { lat: number; lon: number } | null
  metrics: Partial<Record<MetricField, MetricAgg>>
  /**
   * Aggregates for the dynamic gauges (engine, tank, generator) seen in this
   * period, keyed by SK path name. Absent when the boat exposes none. Each is a
   * linear min/max/avg/last, the same shape a graph reads for the core metrics.
   */
  path_metrics?: Record<string, MetricAgg>
}

/** One closed UTC day, aggregated from its hourly rollups. */
export interface RollupDay {
  /** e.g. "2026-07-10" (UTC) */
  date: string
  count: number
  first_ts: number
  last_ts: number
  distance_nm: number
  pos_first: { lat: number; lon: number } | null
  pos_last: { lat: number; lon: number } | null
  metrics: Partial<Record<MetricField, MetricAgg>>
  /**
   * Aggregates for the dynamic gauges (engine, tank, generator) seen in this
   * period, keyed by SK path name. Absent when the boat exposes none. Each is a
   * linear min/max/avg/last, the same shape a graph reads for the core metrics.
   */
  path_metrics?: Record<string, MetricAgg>
}

/** Query shape shared by GET /snapshots and the Phase-2 history RPC. */
export interface SnapshotsQuery {
  from?: number // epoch ms inclusive
  to?: number // epoch ms inclusive
  /** 1 = raw rows (today UTC only - range is clamped), 60 / 360 / 1440 = from rollups. */
  bucket: 1 | 60 | 360 | 1440
  limit?: number // default 200, max 5000
  offset?: number
  order?: 'asc' | 'desc' // default desc
}

export interface SnapshotsResult {
  rows: Snapshot[]
  /** True when the range was narrowed (bucket=1 clamped to today, or limit hit). */
  clamped: boolean
}

/** One point in a single gauge's history. A raw sample has min = max = avg = last. */
export interface PathSeriesPoint {
  ts: number
  min: number
  max: number
  avg: number
  last: number
}

/** One dynamic gauge's history over a window, for a graph. */
export interface PathSeriesResult {
  path: string
  points: PathSeriesPoint[]
  /** True when the range was narrowed (bucket=1 clamped to today, or limit hit). */
  clamped: boolean
}

export interface LiveResult extends Snapshot {
  /** Seconds since the newest delta touched any subscribed path; null before first delta. */
  data_age_s: number | null
  /**
   * Live values of dynamic Signal K paths outside the fixed core - engine,
   * tank and generator readings a given boat happens to expose. Carried by
   * their plain SK path name. Present on the live frame only; not written to
   * history in this phase (the core Snapshot is what the NDJSON store holds).
   */
  paths?: Record<string, number | string>
  /**
   * Age in seconds of each dynamic path's value, keyed the same as `paths`.
   * Lets the shore fade a single frozen gauge on its own: the boat-wide
   * `data_age_s` stays near zero while any path (a live GPS) keeps moving, so
   * it cannot see one instrument going quiet while the boat sails on.
   */
  path_ages?: Record<string, number>
}

/** One dynamic path a boat currently exposes, offered to the dashboard picker. */
export interface InventoryEntry {
  path: string
  /** SK meta units (SI) when the model carries them, else null. */
  units: string | null
}

/**
 * The set of dynamic paths a boat exposes right now. Reported live; nothing
 * about it is retained ashore - when the boat goes offline it is simply gone.
 */
export interface InventoryResult {
  paths: InventoryEntry[]
}

export interface HealthResult {
  status: 'ok' | 'degraded'
  now: number
  started_at: number
  version: string
  boat_name: string | null
  last_delta_ts: number | null
  last_snapshot_ts: number | null
  snapshots_today: number
  /**
   * Signature diagnosis: distinguishes "no data at all", "power data but no
   * navigation data" and "instruments gone quiet (often normal)" so the UI
   * never shows an unexplained empty box.
   */
  diagnosis: { code: string; message: string; since_ts: number | null }
  /** Freshness + winning $source per subscribed Signal K path. */
  paths: Record<string, { last_seen_ts: number; active_source: string | null; sources: number }>
  storage: {
    raw_bytes: number
    cap_bytes: number
    raw_files: number
    oldest_raw: string | null
  }
  rollup: {
    last_hour: string | null
    hours_pending: number
  }
}

/**
 * A voyage: one continuous "underway" window, auto-detected from speed and
 * navigation state. Distances integrate haversine over consecutive fixes.
 */
export interface Voyage {
  id: number
  start_ts: number
  end_ts: number | null
  start_lat: number | null
  start_lon: number | null
  end_lat: number | null
  end_lon: number | null
  distance_nm: number
  hours_underway: number
  avg_sog_kn: number | null
  max_sog_kn: number | null
  start_port: string | null
  end_port: string | null
  status: 'open' | 'closed'
}

/** One aggregation window on the voyage stats card. */
export interface VoyageWindowStats {
  distance_nm: number
  hours_underway: number
  avg_sog_kn: number | null
  max_sog_kn: number | null
}

export interface VoyageStatsResult {
  today: VoyageWindowStats
  yesterday: VoyageWindowStats
  rolling_7d: VoyageWindowStats
  season: VoyageWindowStats
}

export interface TrackPoint {
  ts: number
  lat: number
  lon: number
  /** Knots, rounded; null when unavailable. */
  sog: number | null
}

/** One nearby AIS vessel, sanitized and distance-filtered server-side. */
export interface AisTarget {
  mmsi: string
  name: string | null
  lat: number
  lon: number
  sog_kn: number | null
  cog_deg: number | null
  heading_deg: number | null
  nav_state: string | null
  ais_class: string | null
  ship_type: string | null
  length_m: number | null
  distance_nm: number | null
  ts: number | null
}

export interface AisFeed {
  targets: AisTarget[]
  own: { lat: number; lon: number } | null
  count: number
  error?: string
}

export interface ApiError {
  error: { code: string; message: string }
}
