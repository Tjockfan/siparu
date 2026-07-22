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

/**
 * The history RPC, carried on the live socket in both directions.
 *
 * This is the one thing the shore may say to a boat, and it is not a command: it asks her
 * to read her own recorded history and send it back. Nothing here reaches Signal K, emits a
 * delta or steers anything - the boat answers from her own NDJSON store, exactly as the
 * local read-only REST /snapshots does. Everything else the shore might send is ignored,
 * because a boat takes no command and so there is nothing else to hear.
 *
 * `id` pairs a reply with its request so several may be in flight at once (a chart and an
 * export, say), and so the relay can route each answer back to the screen that asked.
 */
export interface HistoryRequest {
  type: 'history'
  id: string
  /** The dynamic gauge to graph, by its plain SK path name. */
  path: string
  query: SnapshotsQuery
}

/**
 * The boat's answer to one HistoryRequest. Either the series or a reason it could not be
 * built (a bad bucket, say); never both. Carries the same `id` the request did.
 */
export type HistoryResponse =
  | { type: 'history'; id: string; result: PathSeriesResult }
  | { type: 'history'; id: string; error: { code: string; message: string } }

/**
 * The snapshots RPC, the sibling of HistoryRequest carried on the same live socket. Where
 * HistoryRequest asks for one gauge's series shaped for a graph, this asks for whole snapshot
 * rows over a window - the logbook read, the same the local /snapshots REST serves. It carries
 * no `path`: the answer is rows, not a single series. Like its sibling it is a read of the
 * boat's own store and reaches nothing near Signal K.
 */
export interface SnapshotsRequest {
  type: 'snapshots'
  id: string
  query: SnapshotsQuery
}

/** The boat's answer to one SnapshotsRequest. The rows or a reason, never both. */
export type SnapshotsResponse =
  | { type: 'snapshots'; id: string; result: SnapshotsResult }
  | { type: 'snapshots'; id: string; error: { code: string; message: string } }

/**
 * The voyages RPC, a third sibling on the same live socket. Where history asks for one gauge's
 * series and snapshots for whole rows over a window, this asks for the boat's recent voyages -
 * the list the local /voyages REST serves. It carries no query, only how many of the newest to
 * return; like its siblings it is a read of the boat's own store and reaches nothing near
 * Signal K. The boat clamps the count, so a request cannot ask for more than she will give.
 */
export interface VoyagesRequest {
  type: 'voyages'
  id: string
  /** How many of the newest voyages to return. Clamped boat-side to the REST bounds. */
  limit: number
}

/** The boat's answer to one VoyagesRequest. The voyages or a reason, never both. */
export type VoyagesResponse =
  | { type: 'voyages'; id: string; result: VoyageListResult }
  | { type: 'voyages'; id: string; error: { code: string; message: string } }

/**
 * The track RPC, a fourth sibling on the same live socket. Where voyages asks for the list, this
 * asks for one voyage's recorded path - the fixes the local /voyages/:id/track REST serves,
 * drawn as a line on a chart ashore. It carries the voyage's id and nothing else; like its
 * siblings it is a read of the boat's own store and reaches nothing near Signal K. The boat
 * decimates a long track before she sends it, so a request cannot pull an unbounded stream over
 * the wire (a day under way at 1 Hz is tens of thousands of fixes).
 */
export interface TrackRequest {
  type: 'track'
  id: string
  /** Which voyage to draw, by its Voyage.id. */
  voyageId: number
}

/** The boat's answer to one TrackRequest. The path or a reason, never both. */
export type TrackResponse =
  | { type: 'track'; id: string; result: TrackResult }
  | { type: 'track'; id: string; error: { code: string; message: string } }

/**
 * The phases RPC, a fifth sibling on the same live socket. Where voyages asks for the passages,
 * this asks for the activity band beneath them - the phases the local /phases REST serves, newest
 * first. It carries no query, only how many of the newest to return; like its siblings it is a
 * read of the boat's own store and reaches nothing near Signal K. The boat clamps the count, so a
 * request cannot ask for more than she will give.
 */
export interface PhasesRequest {
  type: 'phases'
  id: string
  /** How many of the newest phases to return. Clamped boat-side to the REST bounds. */
  limit: number
}

/** The boat's answer to one PhasesRequest. The phases or a reason, never both. */
export type PhasesResponse =
  | { type: 'phases'; id: string; result: PhaseListResult }
  | { type: 'phases'; id: string; error: { code: string; message: string } }

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
  /**
   * Age in seconds of each core field's value, keyed by snapshot field name.
   * The same service `path_ages` performs for the dynamic gauges: these values
   * are last-known-wins, so a reader that wants to say how fresh one is has to
   * be told per field. Add the frame's own age to it before judging: this is
   * measured on the boat, and the frame takes time to arrive.
   *
   * Fields with no value at all are absent, as is `wind_gust` (a window max,
   * not a reading). Optional: a boat running an older plugin sends none, and a
   * reader must fall back rather than treat missing as fresh.
   */
  field_ages?: Partial<Record<MetricField, number>>
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

/** The activity a boat is in during one phase, from her speed and nav state. */
export type PhaseKind = 'underway' | 'anchored' | 'moored' | 'stopped'

/**
 * One activity phase: a continuous stretch the boat spent under way, at anchor,
 * on a mooring, or simply stopped. This is the raw band beneath the voyages -
 * a single voyage can hold an anchored phase in the middle of it - and it is
 * derived alongside the voyage engine, never from it, so it moves no recorded
 * voyage. `stopped` is the honest answer when she is stationary but her nav
 * state does not say whether she is anchored or moored.
 */
export interface Phase {
  kind: PhaseKind
  start_ts: number
  /** Null while this is the current phase. */
  end_ts: number | null
  start_lat: number | null
  start_lon: number | null
  end_lat: number | null
  end_lon: number | null
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
  /**
   * Litres burned over the voyage, integrated from the engines' own reported
   * `propulsion.*.fuel.rate`. Null on a boat whose engines report no fuel rate:
   * fuel is measured off the bus, never estimated from rpm or a boat model, so
   * where the sensor is silent there is no honest number to show.
   */
  fuel_used_l: number | null
  start_port: string | null
  end_port: string | null
  status: 'open' | 'closed'
}

/** The boat's answer to one VoyagesRequest: her recent voyages, newest first. */
export interface VoyageListResult {
  voyages: Voyage[]
}

/** The boat's answer to one PhasesRequest: her recent activity phases, newest first. */
export interface PhaseListResult {
  phases: Phase[]
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

/**
 * The boat's answer to one TrackRequest: one voyage's path, oldest fix first.
 * `decimated` is true when the boat thinned a long track before sending it, so a reader can say
 * the line is a faithful shape but not every recorded fix.
 */
export interface TrackResult {
  track: TrackPoint[]
  decimated: boolean
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

/**
 * The sealed frame, and the key material around it.
 *
 * These shapes belong here rather than beside the sealing code because they are
 * the only part of the encryption three separate programs have to agree on: the
 * plugin that seals, the relay that verifies and forwards, and the client that
 * opens. The algorithms are an implementation detail of each; the bytes on the
 * wire are not.
 *
 * The full protocol, including what the relay can and cannot see, is specified
 * separately. What matters at this boundary: the relay carries the frame and
 * verifies its signature, and cannot read the body.
 */

/** One content key, encrypted to one device. */
export interface WrappedKey {
  /**
   * The device this wrap is for. Opaque and random: it travels in the clear on
   * every frame, so a readable id would hand the carrier a device inventory.
   */
  kid: string
  /** The content key, sealed to that device. base64url. */
  wrap: string
}

/**
 * One telemetry frame, sealed to the boat's authorised devices and signed by
 * her identity key.
 *
 * Only `boat` and `ts` are legible in transit, and both are inside the
 * signature: rewriting a departure time is the attack the proof layer exists to
 * defeat. `body` holds the report, encrypted once under a content key that is
 * then wrapped separately to each device in `keys`.
 *
 * Extension fields are permitted, must be strings, and are covered by the
 * signature. `alert` is the first of them.
 */
export interface SealedFrame {
  /** Format version. Sixteen bits on the wire. */
  v: number
  boat: string
  /** Epoch ms, UTC, as the boat recorded it. Signed. */
  ts: number
  /** Ephemeral X25519 public key, this frame only. base64url. */
  eph: string
  /** Body nonce. base64url. */
  nonce: string
  /** The report, encrypted. base64url of ciphertext followed by tag. */
  body: string
  keys: WrappedKey[]
  /** Ed25519 over the ciphertext, the cleartext metadata and any extensions. base64url. */
  sig: string
  [extension: string]: unknown
}

/**
 * How loud an alert is, and the only thing about it that travels in the clear.
 *
 * The carrier has to know a notification is due, so severity cannot be sealed.
 * What kind of alert it is stays encrypted: fuel, fire and shore power are
 * indistinguishable from outside. It rides in the `alert` extension field, and
 * so is signed, which is what stops a carrier downgrading an alarm to normal
 * and swallowing the notification.
 */
export type AlertLevel = 'normal' | 'warning' | 'alarm'

/** The public halves a device needs in order to reach one boat. base64url, raw. */
export interface BoatPublicKeys {
  /** Ed25519. Verifies her frames. */
  identity: string
  /** X25519. Receives what a device seals to her. */
  inbox: string
}

/** One authorised device, as the boat is told about it. */
export interface DevicePublicKey {
  kid: string
  /** Raw 32-byte X25519 public key, base64url. */
  pub: string
}
