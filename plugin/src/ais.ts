/**
 * AIS targets for the map overlay: other vessels from the Signal K full
 * model, trimmed server-side by distance, freshness and count - a busy
 * anchorage can carry 400+ targets and the webapp only needs the nearby ones.
 *
 * Pure function over the vessels dict; the REST layer feeds it
 * app.getPath('vessels') and app.selfContext.
 */
import { AisFeed, AisTarget } from './contract'
import { haversineNm } from './rollup'

const MS_TO_KN = 1.9438

export interface AisQuery {
  maxNm: number
  maxAgeMin: number
  limit: number
}

/** Full-model node: {value, timestamp, ...} or a plain value. */
function nodeValue(node: unknown): unknown {
  if (node && typeof node === 'object' && 'value' in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>).value
  }
  return node
}

function dig(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return nodeValue(cur)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function deg(rad: unknown): number | null {
  const r = num(rad)
  if (r === null) return null
  return Math.round((((r * 180) / Math.PI) % 360) * 10) / 10
}

function kn(ms: unknown): number | null {
  const m = num(ms)
  if (m === null) return null
  return Math.round(m * MS_TO_KN * 10) / 10
}

/**
 * AIS text (name/ship_type/nav_state) renders in map popups. XSS
 * defense-in-depth: strip markup characters server-side too - the frontend
 * escapes as well, this is the second layer.
 */
function cleanStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/[<>"'`]/g, '').trim()
  return s || null
}

function tsMs(iso: unknown): number | null {
  if (typeof iso !== 'string') return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

export function buildAisFeed(vessels: unknown, selfContext: string, now: number, q: AisQuery): AisFeed {
  if (!vessels || typeof vessels !== 'object') return { targets: [], own: null, count: 0 }
  const dict = vessels as Record<string, unknown>
  const selfKey = selfContext.replace(/^vessels\./, '').trim()

  const selfV = dict[selfKey]
  const ownPos = dig((selfV as Record<string, unknown>)?.navigation, 'position') as
    | { latitude?: unknown; longitude?: unknown }
    | undefined
  const ownLat = num(ownPos?.latitude)
  const ownLon = num(ownPos?.longitude)

  // Without our own position the distance filter is impossible; an explicit
  // error beats silently drawing far-away traffic as "nearby".
  if (ownLat === null || ownLon === null) {
    return { targets: [], own: null, count: 0, error: 'no-self-position' }
  }

  const cutoff = now - q.maxAgeMin * 60_000
  const targets: AisTarget[] = []

  for (const [key, v] of Object.entries(dict)) {
    if (key === selfKey || !v || typeof v !== 'object') continue
    const vessel = v as Record<string, unknown>
    const nav = (vessel.navigation ?? {}) as Record<string, unknown>
    const pos = dig(nav, 'position') as { latitude?: unknown; longitude?: unknown } | undefined
    const lat = num(pos?.latitude)
    const lon = num(pos?.longitude)
    if (lat === null || lon === null) continue

    const posBlock = nav.position as { timestamp?: unknown } | undefined
    const ts = posBlock ? tsMs(posBlock.timestamp) : null
    if (ts !== null && ts < cutoff) continue

    const dist = haversineNm(ownLat, ownLon, lat, lon)
    if (dist > q.maxNm) continue

    const design = (vessel.design ?? {}) as Record<string, unknown>
    const shipType = dig(design, 'aisShipType') as { name?: unknown } | undefined
    const length = dig(design, 'length') as { overall?: unknown } | undefined

    targets.push({
      mmsi: String(vessel.mmsi ?? key.split(':').pop()),
      name: cleanStr(dig(vessel, 'name')),
      lat,
      lon,
      sog_kn: kn(dig(nav, 'speedOverGround')),
      cog_deg: deg(dig(nav, 'courseOverGroundTrue')),
      heading_deg: deg(dig(nav, 'headingTrue')),
      nav_state: cleanStr(dig(nav, 'state')),
      ais_class: cleanStr(dig(vessel.sensors, 'ais', 'class')),
      ship_type: cleanStr(shipType && typeof shipType === 'object' ? shipType.name : null),
      length_m: num(length?.overall),
      distance_nm: Math.round(dist * 100) / 100,
      ts
    })
  }

  targets.sort((a, b) => (a.distance_nm ?? 0) - (b.distance_nm ?? 0))
  return {
    targets: targets.slice(0, q.limit),
    own: { lat: ownLat, lon: ownLon },
    count: Math.min(targets.length, q.limit)
  }
}

export function clampAisQuery(maxNm?: number, maxAgeMin?: number, limit?: number): AisQuery {
  const clamp = (v: number | undefined, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d
  return {
    maxNm: clamp(maxNm, 5, 0.5, 50),
    maxAgeMin: clamp(maxAgeMin, 15, 1, 120),
    limit: clamp(limit, 30, 1, 400)
  }
}
