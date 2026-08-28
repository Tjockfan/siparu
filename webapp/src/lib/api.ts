/**
 * Plugin REST client. The webapp is served by the Signal K server itself, so
 * everything is same-origin under /plugins/siparu - no auth headers here;
 * if Signal K security is enabled its session cookie applies automatically.
 *
 * The surface intentionally mirrors what the screens consume. History queries
 * are transparently split, in two different places. `snapshots` takes the cheap
 * split: today raw, every earlier day from the hourly rollup mapped to
 * snapshot-shaped rows (gust = the hour's peak, everything else = the hour's
 * last value). `minutes` takes the deep one, for a reader who asked for every
 * minute: raw as far back as the boat still serves it, and the rollup only for
 * what lies before that. Screens never notice either.
 */

// The wire shapes come from the plugin that serves this app, rather than being
// restated here. They were restated, and they drifted: the plugin has sent
// `paths` and `path_ages` on every frame since it learned to read engines and
// tanks, and a copy of Snapshot that predated them meant this app typed them
// away and threw them out twice a second. A type-only import costs nothing at
// runtime (contract.ts declares no values, so the bundler drops the import) and
// makes the next such addition arrive here on its own.
import type { LiveResult, MetricField, RollupHour, Snapshot, SnapshotsResult } from '../../../plugin/src/contract'

export type { MetricField, Snapshot }

/** The live frame, exactly as the plugin's /live returns it. */
export type LiveSnapshot = LiveResult

export class ApiError extends Error {
  status: number
  detail: string
  /** The plugin's machine-readable reason ("security_off"), when the body carried one. */
  code?: string
  constructor(status: number, detail: string, code?: string) {
    super(`${status}: ${detail}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.code = code
  }
}

const BASE = '/plugins/siparu'

/** SK security 401 - the App listens for this and swaps the whole screen for the AuthGate. */
export const AUTH_REQUIRED_EVENT = 'sp:auth-required'

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  // 10s timeout: on flaky boat wi-fi a hung request must not pile up under
  // the poll ticks.
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(10_000), ...init })
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
    let detail = r.statusText
    let code: string | undefined
    try {
      // Two body shapes reach here: Signal K's own errors nest the message
      // ({error:{message}}), the plugin's routes answer flat ({error, message}) -
      // with error as the machine-readable reason a screen can act on.
      const body = (await r.json()) as {
        error?: string | { message?: string }
        message?: string
      }
      if (typeof body?.message === 'string' && body.message) detail = body.message
      else if (typeof body?.error === 'object' && body.error?.message) detail = body.error.message
      if (typeof body?.error === 'string') code = body.error
    } catch {
      /* not JSON */
    }
    throw new ApiError(r.status, detail, code)
  }
  return r.json() as Promise<T>
}

export function startOfUtcDay(ts: number): number {
  const d = new Date(ts)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

const num = (v: number | string | null | undefined): number | null =>
  typeof v === 'number' ? v : null
const str = (v: number | string | null | undefined): string | null =>
  typeof v === 'string' ? v : null

/** One snapshot-shaped row per rollup hour; gust carries the hour's peak. */
function rollupToSnapshot(h: RollupHour): Snapshot {
  const m = h.metrics
  return {
    ts: h.last_ts,
    lat: h.pos_last?.lat ?? null,
    lon: h.pos_last?.lon ?? null,
    sog: num(m.sog?.last),
    cog: num(m.cog?.last),
    heading_mag: num(m.heading_mag?.last),
    heading_true: num(m.heading_true?.last),
    rate_of_turn: num(m.rate_of_turn?.last),
    magnetic_variation: num(m.magnetic_variation?.last),
    magnetic_deviation: num(m.magnetic_deviation?.last),
    nav_state: str(m.nav_state?.last),
    wind_speed_apparent: num(m.wind_speed_apparent?.last),
    wind_angle_apparent: num(m.wind_angle_apparent?.last),
    wind_speed_true: num(m.wind_speed_true?.last),
    wind_gust: m.wind_gust?.max ?? num(m.wind_speed_true?.max) ?? null,
    wind_direction_true: num(m.wind_direction_true?.last),
    air_temp_k: num(m.air_temp_k?.last),
    air_pressure_pa: num(m.air_pressure_pa?.last),
    depth: num(m.depth?.last),
    water_temp_k: num(m.water_temp_k?.last),
    gps_satellites: num(m.gps_satellites?.last),
    ais_class: str(m.ais_class?.last)
  }
}

type SnapshotsQuery = {
  from?: number
  to?: number
  limit?: number
  offset?: number
  order?: 'asc' | 'desc'
  bucket?: number
}

async function fetchSnapshotsResult(q: SnapshotsQuery & { bucket: number }): Promise<SnapshotsResult> {
  const p = new URLSearchParams()
  if (q.from !== undefined) p.set('from', String(q.from))
  if (q.to !== undefined) p.set('to', String(q.to))
  if (q.limit !== undefined) p.set('limit', String(q.limit))
  if (q.offset !== undefined) p.set('offset', String(q.offset))
  if (q.order) p.set('order', q.order)
  p.set('bucket', String(q.bucket))
  return http<SnapshotsResult>(`/snapshots?${p}`)
}

async function fetchSnapshots(q: SnapshotsQuery & { bucket: number }): Promise<Snapshot[]> {
  return (await fetchSnapshotsResult(q)).rows
}

async function fetchRollupHours(from: number, to: number): Promise<RollupHour[]> {
  const res = await http<{ rows: RollupHour[] }>(`/rollups/hourly?from=${from}&to=${to}`)
  return res.rows
}

/**
 * Minute rows with transparent history split: today comes raw, anything
 * before today comes from hourly rollups as one row per hour.
 */
async function smartSnapshots(q: SnapshotsQuery): Promise<Snapshot[]> {
  const bucket = q.bucket ?? 1
  if (bucket !== 1) return fetchSnapshots({ ...q, bucket })

  const now = Date.now()
  const to = q.to ?? now
  const from = q.from ?? startOfUtcDay(now)
  const todayStart = startOfUtcDay(now)

  const parts: Promise<Snapshot[]>[] = []
  if (from < todayStart) {
    parts.push(fetchRollupHours(from, Math.min(to, todayStart - 1)).then((hs) => hs.map(rollupToSnapshot)))
  }
  if (to >= todayStart) {
    parts.push(fetchSnapshots({ from: Math.max(from, todayStart), to, bucket: 1, limit: q.limit ?? 5000, order: 'asc' }))
  }
  let rows = (await Promise.all(parts)).flat()
  rows = rows.filter((r) => r.ts >= from && r.ts <= to)
  rows.sort((a, b) => (q.order === 'desc' ? b.ts - a.ts : a.ts - b.ts))
  if (q.offset) rows = rows.slice(q.offset)
  if (q.limit !== undefined) rows = rows.slice(0, q.limit)
  return rows
}

/** Minute rows over a window, and the instant the boat stops having them. */
export type MinutesResult = { rows: Snapshot[]; minutesFrom: number }

/**
 * The boat's minutes over a window, with the hourly rollup filling whatever lies before them.
 *
 * This is the deep read, and it is deliberately not what `smartSnapshots` does. A minute row
 * costs a few kilobytes and a boat reporting engines and tanks sends thousands of them for a
 * day; a screen that wants a track or a barometer wants rows, not minutes, and pays for the
 * summaries instead. Only a reader who asked for "every minute" comes through here.
 *
 * Where the minutes stop is the boat's answer, not a calendar's: she keeps a window of raw
 * hours, shortened by whatever her disk actually still holds, and says where it begins. So
 * the request goes out for the whole window and the fill is decided by what came back - one
 * extra round trip, on the one screen that asked for it.
 */
async function minuteSnapshots(q: SnapshotsQuery): Promise<MinutesResult> {
  const now = Date.now()
  const to = q.to ?? now
  const order = q.order ?? 'desc'
  const res = await fetchSnapshotsResult({ from: q.from, to, bucket: 1, limit: q.limit ?? 5000, order })
  const floor = res.minutesFrom ?? startOfUtcDay(now)
  const from = q.from ?? floor

  let rows = res.rows
  if (from < floor) {
    const hours = await fetchRollupHours(from, Math.min(to, floor - 1))
    rows = hours.map(rollupToSnapshot).concat(rows)
  }
  rows = rows.filter((r) => r.ts >= from && r.ts <= to)
  rows.sort((a, b) => (order === 'desc' ? b.ts - a.ts : a.ts - b.ts))
  if (q.offset) rows = rows.slice(q.offset)
  if (q.limit !== undefined) rows = rows.slice(0, q.limit)
  return { rows, minutesFrom: floor }
}

// ===== Barometer (computed client-side from snapshots/rollups) =====

export type TimeSeriesPoint = { ts: number; value: number | null }

export type BaroTrend = {
  current_hpa: number | null
  delta_3h_hpa: number | null
  gale_flag: boolean
  series: TimeSeriesPoint[]
}

const hpa = (pa: number | null): number | null => (pa === null ? null : Math.round((pa / 100) * 10) / 10)

async function baroTrend(hours = 24): Promise<BaroTrend> {
  const now = Date.now()
  const rows = await smartSnapshots({ from: now - hours * 3600_000, to: now, order: 'asc', limit: 5000 })
  const series: TimeSeriesPoint[] = rows.map((r) => ({ ts: r.ts, value: hpa(r.air_pressure_pa) }))

  let current: number | null = null
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]!.value
    if (v !== null) {
      current = v
      break
    }
  }

  // 3h delta: the non-null point closest to now-3h (±30 min window).
  let delta: number | null = null
  if (current !== null) {
    const target = now - 3 * 3600_000
    let bestDt: number | null = null
    let bestV: number | null = null
    for (const p of series) {
      if (p.value === null || Math.abs(p.ts - target) > 30 * 60_000) continue
      const dt = Math.abs(p.ts - target)
      if (bestDt === null || dt < bestDt) {
        bestDt = dt
        bestV = p.value
      }
    }
    if (bestV !== null) delta = Math.round((current - bestV) * 10) / 10
  }

  return {
    current_hpa: current,
    delta_3h_hpa: delta,
    gale_flag: delta !== null && delta <= -3.0, // falling >=3 hPa / 3h
    series
  }
}

async function baroSeries(q: { from: number; to: number; points?: number }): Promise<{ ts: number; hpa: number }[]> {
  const rows = await smartSnapshots({ from: q.from, to: q.to, order: 'asc', limit: 5000 })
  let series = rows
    .map((r) => ({ ts: r.ts, hpa: hpa(r.air_pressure_pa) }))
    .filter((p): p is { ts: number; hpa: number } => p.hpa !== null)
  const points = q.points ?? 160
  if (series.length > points) {
    const step = (series.length - 1) / (points - 1)
    series = Array.from({ length: points }, (_, i) => series[Math.round(i * step)]!)
  }
  return series
}

// ===== Domain types =====

export type Voyage = {
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
  /** Litres burned, integrated from the engines' reported rate; null when no engine reports fuel. */
  fuel_used_l: number | null
  start_port: string | null
  end_port: string | null
  status: 'open' | 'closed'
}

export type VoyageRollup = {
  distance_nm: number
  hours_underway: number
  avg_sog_kn: number | null
  max_sog_kn: number | null
}

export type VoyageStatsCards = {
  today: VoyageRollup
  yesterday: VoyageRollup
  rolling_7d: VoyageRollup
  season: VoyageRollup
}

export type TrackPoint = { ts: number; lat: number; lon: number; sog: number | null }

/** Voyages the owner joined by hand, and so can put back apart. */
export type VoyageEdits = { merged: number[] }

/** What an edit answers with: the voyage that now exists, or why nothing happened. */
export type EditResult = { ok: true; id: number } | { ok: false; error: string }

/** Which engine fuel-rate paths feed the per-voyage fuel figure: the paths the
 *  boat reports, and the subset currently counted (empty means all of them). */
export type FuelPathsView = { available: string[]; selected: string[] }

export type AisTarget = {
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

export type AisFeed = {
  targets: AisTarget[]
  own: { lat: number; lon: number } | null
  count: number
  error?: string
}

/**
 * What she did with her last report. `mode` is the verdict: sealed to the screens on her list,
 * or refusing to send at all because there is nobody she can seal to. `reason` is filled in the
 * refusing case and in no other, and it is written for a skipper.
 *
 * An older plugin also answered `clear` here, for a boat that reported unsealed. That boat no
 * longer exists, and the value is read as one more mode this screen has nothing to say about.
 */
export type SealingStatus = {
  devices: number
  mode: 'sealed' | 'blocked' | 'none'
  reason: string | null
  /**
   * One fingerprint per screen she seals to, for comparing by eye with what a phone shows.
   * Absent in the earlier plugin, so it is read as a list that may not be there at all.
   */
  screens?: string[]
  /**
   * Whether she holds a root of her own: a first screen witnessed at her helm, against which
   * every later one has to chain. False for a boat paired before that existed, who checks the
   * shape of a key and nothing about who vouched for it.
   */
  screens_pinned?: boolean
  /** Rows of the shore's answer the chain refused, before sealing began. Pinned boats only. */
  screens_skipped?: { kid: string; reason: string }[]
  /** Screens the last sealed frame could not be wrapped to, though the chain had accepted them. */
  screens_rejected?: { kid: string; reason: string }[]
}

export type HealthResult = {
  status: 'ok' | 'degraded'
  diagnosis: { code: string; message: string; since_ts: number | null }
  boat_name: string | null
  last_delta_ts: number | null
  snapshots_today: number
  /** Per-path freshness (read by the depth micro-diagnosis). Absent in the earlier plugin. */
  paths?: Record<string, { last_seen_ts: number; active_source: string | null; sources: number }>
  /** Whether anything is reaching the shore at all. Absent in the earlier plugin. */
  sealing?: SealingStatus
  /**
   * Whether an AIS receiver has ever been proven aboard. The chart draws its AIS controls
   * from this rather than from the target count: a count of zero is what a boat alone at
   * sea reads, and taking the switch away from her is taking away the one control that
   * answers "is anybody out there". Absent in the earlier plugin.
   */
  ais?: { receiver_seen: boolean; first_seen_ts: number | null }
}

export type MapConfig = {
  /** Local Protomaps PMTiles basemap. Null when there is none. */
  basemap: string | null
  /** Hosted OpenMapTiles TileJSON. Null when a local basemap is present. */
  basemapTiles: string | null
  seamark: string | null
  glyphs: string
  sprite: string
  local: { basemap: boolean; seamark: boolean; fonts: boolean; sprites: boolean }
}

/**
 * Pairing - the boat's half of it. These POSTs live in the plugin's own router,
 * not in rest.ts: that one is GET-only on purpose, and it stays that way. A POST
 * here talks outbound to the relay and saves the plugin's own options. It still
 * writes nothing to the Signal K bus.
 *
 * `email` is unmasked in awaiting_approval and masked once paired - deliberately.
 * At the moment of approval the skipper is deciding whether to hand someone their
 * vessel's live position, and "b***@gmail.com" is not enough to make that call.
 * Afterwards it is just a label, so it gets the mask.
 */
/**
 * Whether her frames are actually reaching the relay. Paired and streaming are two
 * different things, and the difference is invisible from ashore: the owner would see a
 * screen that stopped updating and no reason why.
 */
export interface UplinkStatus {
  lastSentTs: number | null
  failures: number
  /** The relay does not know this token. Only pairing her again fixes it. */
  rejected: boolean
  /**
   * The relay knows her and will not carry her: remote watching is not running on the
   * account. Optional because a boat on an older build does not send it, and a screen that
   * read `undefined` as `false` would simply be back where it started.
   */
  unentitled?: boolean
  lastError: string | null
}

type PairState =
  | { state: 'idle' }
  | { state: 'showing_code'; userCode: string; expiresAt: string }
  | {
      state: 'awaiting_approval'
      userCode: string
      email: string | null
      expiresAt: string
      /**
       * The screen that typed the code, when it offered itself.
       *
       * The one comparison in this product the server cannot take part in: the same four
       * groups appear on the owner's phone, and reading them off both screens is what makes
       * a substituted key visible to a person. Offered, never demanded - approving without
       * looking leaves the boat exactly as safe as she was before any of this existed.
       */
      device?: { kid: string; fingerprint: string }
    }
  | {
      state: 'paired'
      boatId: string
      email: string | null
      pairedAt: string
      uplink?: UplinkStatus
    }
  | { state: 'expired' }
  | { state: 'error'; message: string }

/**
 * The screen's state, plus the state of the door it stands behind. `security_off` is
 * true when Signal K is running without security, which is its default: the pairing
 * endpoints would then answer anyone on the boat's network. It rides every state
 * because it describes the server, not the flow. `pairing_locked` rides along when
 * that also means the plugin is refusing pairing, unpairing and settings writes -
 * until the owner turns security on, or accepts the open network in the plugin
 * settings. `revoke_pending` is true when an unlink was cut on the boat but the relay
 * has not yet been reached to kill its copy of the key; the plugin keeps retrying on
 * its own.
 */
export type PairScreen = PairState & {
  security_off?: boolean
  pairing_locked?: boolean
  revoke_pending?: boolean
}

export const api = {
  live: () => http<LiveSnapshot>('/live'),
  health: () => http<HealthResult>('/health'),
  mapConfig: () => http<MapConfig>('/map-config'),

  logbook: {
    snapshots: (q: SnapshotsQuery = {}) => smartSnapshots(q),
    /**
     * Rows at the resolution the boat recorded them, for a reader who asked for every minute.
     * Everything else on the screens reads `snapshots`, which answers the same windows far
     * more cheaply by taking the hourly summary for any day but today.
     */
    minutes: (q: SnapshotsQuery = {}) => minuteSnapshots(q),
    snapshotLatest: () => http<LiveSnapshot>('/live'),
    /**
     * The boat's own hourly summaries, unflattened.
     *
     * `/snapshots` hands back one value per bucket - the last one - which is a logbook page.
     * These are what the page is a page OF: min, max, mean and sample count for every reading,
     * plus the distance run. An export that offers figures reads these; nothing else does.
     */
    rollupHours: (from: number, to: number) => fetchRollupHours(from, to)
  },

  voyage: {
    list: (limit = 50) => http<Voyage[]>(`/voyages?limit=${limit}`),
    stats: () => http<VoyageStatsCards>('/voyages/stats'),
    current: () => http<Voyage | null>('/voyages/current'),
    track: (voyageId: number) => http<TrackPoint[]>(`/voyages/${voyageId}/track`),
    /** Which voyages were made by hand and can be put back the way they were. */
    edits: () => http<VoyageEdits>('/voyages/edits'),
    // The two writes, each on one line so the CI read-only guard reads verb and
    // action together. They exist on the boat's own network only: the wire
    // protocol the shore speaks carries reads and nothing else.
    mergePrevious: (id: number) => http<EditResult>(`/voyages/${id}/merge-previous`, { method: 'POST' }),
    undoMerge: (id: number) => http<EditResult>(`/voyages/${id}/undo-merge`, { method: 'POST' })
  },
  config: {
    fuelPaths: () => http<FuelPathsView>('/config/fuel-paths'),
    // POST kept to one line so the CI read-only guard reads verb and path together, as with pairing.
    setFuelPaths: (paths: string[]) => http<{ fuelRatePaths: string[] }>('/config/fuel-paths', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) })
  },

  tools: {
    baroTrend,
    baroSeries
  },

  ais: {
    targets: (opts?: { maxNm?: number; limit?: number }) => {
      const maxNm = opts?.maxNm ?? 5
      const limit = opts?.limit ?? 30
      return http<AisFeed>(`/ais/targets?max_nm=${maxNm}&limit=${limit}`)
    }
  },

  pair: {
    status: () => http<PairScreen>('/pair/status'),
    start: () => http<PairScreen>('/pair/start', { method: 'POST' }),
    approve: () => http<PairScreen>('/pair/approve', { method: 'POST' }),
    deny: () => http<PairScreen>('/pair/deny', { method: 'POST' }),
    /** Unlink the boat. The token is destroyed here, on the vessel - no portal needed. */
    reset: () => http<PairScreen>('/pair/reset', { method: 'POST' })
  }
}
