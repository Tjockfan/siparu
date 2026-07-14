/**
 * Plugin REST client. The webapp is served by the Signal K server itself, so
 * everything is same-origin under /plugins/siparu - no auth headers here;
 * if Signal K security is enabled its session cookie applies automatically.
 *
 * The surface intentionally mirrors what the screens consume. History
 * queries are transparently split: raw rows exist for today (UTC) only, so
 * ranges reaching further back are served from hourly rollup lines mapped to
 * snapshot-shaped rows (gust = the hour's peak, everything else = the hour's
 * last value). Screens never notice.
 */

export type Snapshot = {
  ts: number
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
  wind_gust: number | null
  wind_direction_true: number | null
  air_temp_k: number | null
  air_pressure_pa: number | null
  depth: number | null
  water_temp_k: number | null
  gps_satellites: number | null
  ais_class: string | null
}

export type LiveSnapshot = Snapshot & { data_age_s: number | null }

type MetricAgg = { min?: number; max?: number; avg?: number; last: number | string | null }

type RollupHour = {
  hour: string
  count: number
  first_ts: number
  last_ts: number
  distance_nm: number
  pos_first: { lat: number; lon: number } | null
  pos_last: { lat: number; lon: number } | null
  metrics: Partial<Record<keyof Omit<Snapshot, 'ts'>, MetricAgg>>
}

export class ApiError extends Error {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    super(`${status}: ${detail}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
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
    try {
      const body = (await r.json()) as { error?: { message?: string } }
      if (body?.error?.message) detail = body.error.message
    } catch {
      /* not JSON */
    }
    throw new ApiError(r.status, detail)
  }
  return r.json() as Promise<T>
}

function startOfUtcDay(ts: number): number {
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

async function fetchSnapshots(q: SnapshotsQuery & { bucket: number }): Promise<Snapshot[]> {
  const p = new URLSearchParams()
  if (q.from !== undefined) p.set('from', String(q.from))
  if (q.to !== undefined) p.set('to', String(q.to))
  if (q.limit !== undefined) p.set('limit', String(q.limit))
  if (q.offset !== undefined) p.set('offset', String(q.offset))
  if (q.order) p.set('order', q.order)
  p.set('bucket', String(q.bucket))
  const res = await http<{ rows: Snapshot[] }>(`/snapshots?${p}`)
  return res.rows
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

export type HealthResult = {
  status: 'ok' | 'degraded'
  diagnosis: { code: string; message: string; since_ts: number | null }
  boat_name: string | null
  last_delta_ts: number | null
  snapshots_today: number
  /** Per-path freshness (read by the depth micro-diagnosis). Absent in the earlier plugin. */
  paths?: Record<string, { last_seen_ts: number; active_source: string | null; sources: number }>
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
  lastError: string | null
}

export type PairScreen =
  | { state: 'idle' }
  | { state: 'showing_code'; userCode: string; expiresAt: string }
  | { state: 'awaiting_approval'; userCode: string; email: string | null; expiresAt: string }
  | {
      state: 'paired'
      boatId: string
      email: string | null
      pairedAt: string
      uplink?: UplinkStatus
    }
  | { state: 'expired' }
  | { state: 'error'; message: string }

export const api = {
  live: () => http<LiveSnapshot>('/live'),
  health: () => http<HealthResult>('/health'),
  mapConfig: () => http<MapConfig>('/map-config'),

  logbook: {
    snapshots: (q: SnapshotsQuery = {}) => smartSnapshots(q),
    snapshotLatest: () => http<LiveSnapshot>('/live')
  },

  voyage: {
    list: (limit = 50) => http<Voyage[]>(`/voyages?limit=${limit}`),
    stats: () => http<VoyageStatsCards>('/voyages/stats'),
    current: () => http<Voyage | null>('/voyages/current'),
    track: (voyageId: number) => http<TrackPoint[]>(`/voyages/${voyageId}/track`)
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
