/**
 * Plugin configuration: JSON Schema for the Signal K admin UI + resolved
 * runtime options with defaults.
 *
 * Day-1 rule: no boat-specific value may be hardcoded - SOG sanity
 * threshold, TWS source fallback, season start, boat name, optional port
 * table and voyage/tender-merge thresholds are all configuration.
 */

export interface PortEntry {
  name: string
  latitude: number
  longitude: number
  radiusNm: number
}

export interface VoyageOptions {
  openKnots: number
  openMinutes: number
  closeMinutes: number
  mergeMaxGapMinutes: number
  mergeMaxHopNm: number
  mergeShortNm: number
}

export interface Options {
  boatName: string
  snapshotSeconds: number
  maxSogKnots: number
  seasonStart: string // MM-DD
  maxStorageMB: number
  chartsRemoteUrl: string
  chartsBasemapUrl: string
  relayUrl: string
  ports: PortEntry[]
  voyage: VoyageOptions
  // The relay credential deliberately does NOT live here. Plugin options are
  // served wholesale by GET /plugins/<id>/config, which with security off (the
  // default install) answers anyone on the boat's network. The token lives in
  // the plugin's data dir instead - see remotelink.ts, and the migration in
  // index.ts that moves a legacy copy out of here.
}

export const DEFAULTS: Options = {
  boatName: '',
  snapshotSeconds: 60,
  maxSogKnots: 70,
  seasonStart: '01-01',
  maxStorageMB: 500,
  chartsRemoteUrl: 'https://tiles.siparu.app',
  chartsBasemapUrl: 'https://tiles.openfreemap.org/planet',
  relayUrl: 'https://relay.siparu.app',
  ports: [],
  voyage: {
    openKnots: 1.5,
    openMinutes: 3,
    closeMinutes: 5,
    mergeMaxGapMinutes: 45,
    mergeMaxHopNm: 0.5,
    mergeShortNm: 1.0
  }
}

/** Values considered live-tunable internals, not user configuration. */
export const INTERNAL = {
  samplePeriodMs: 2000,
  /** A path value older than this loses priority in fallback merges (TWS, depth). */
  staleMs: 30_000,
  /**
   * On the recording path only: a value whose source last spoke longer ago than
   * this is written as null rather than standing in for a measurement nobody
   * took. The live screen keeps showing it (last-known-wins) and ages it there.
   *
   * Deliberately not staleMs: 30s is the fallback-priority threshold, and at the
   * default snapshotSeconds of 60 it would null a barometer that is merely
   * unhurried. Two minutes is generous on purpose, because the server offers no
   * guarantee to be precise against: subscribing with policy 'fixed' does not
   * republish the last value every period - it buffers whatever actually arrives
   * (bufferWithTime), so a silent source stays silent on the wire. What makes a
   * healthy path keep reporting is the sensor itself resending its reading, which
   * NMEA hardware does and a change-of-state source may not. So this is a
   * deliberately loose assumption about instruments, not a tight read of a
   * protocol: it is set to catch the sensor that died, and to let the slow one be.
   */
  fabricationHorizonMs: 120_000,
  /** Track segments implying speed above this are excluded from rollup distance. */
  rollupSpeedGuardKn: 80,
  /** No delta for this long -> /health reports degraded. */
  degradedAfterMs: 5 * 60_000
}

export const KN_TO_MS = 0.514444

/**
 * MM-DD that exists on a calendar. The regex alone let "99-99" through, which
 * Date.UTC silently normalised years into the future - season statistics went
 * empty with no error anywhere. 02-29 is allowed: the season-window code
 * resolves it against each actual year.
 */
export function isCalendarMonthDay(s: string): boolean {
  const m = /^(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const month = Number(m[1])
  const day = Number(m[2])
  if (month < 1 || month > 12) return false
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0)
}

/**
 * The relay URL carries the boat token as a Bearer header, so it must not be
 * plain http - except toward loopback, which is how `wrangler dev` is reached.
 * Anything else falls back to the default rather than sending the credential
 * in clear text.
 */
export function safeRelayUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^https?:\/\/\S+$/.test(raw)) return undefined
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return raw.replace(/\/+$/, '')
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1'
    return u.protocol === 'http:' && loopback ? raw.replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

export function resolveOptions(raw: unknown): Options {
  const c = (raw ?? {}) as Partial<Options>
  const v = (c.voyage ?? {}) as Partial<VoyageOptions>
  const num = (x: unknown, d: number, min?: number): number =>
    typeof x === 'number' && Number.isFinite(x) && (min === undefined || x >= min) ? x : d
  return {
    boatName: typeof c.boatName === 'string' ? c.boatName.trim() : DEFAULTS.boatName,
    snapshotSeconds: num(c.snapshotSeconds, DEFAULTS.snapshotSeconds, 10),
    maxSogKnots: num(c.maxSogKnots, DEFAULTS.maxSogKnots, 1),
    seasonStart: isCalendarMonthDay(c.seasonStart ?? '') ? (c.seasonStart as string) : DEFAULTS.seasonStart,
    maxStorageMB: num(c.maxStorageMB, DEFAULTS.maxStorageMB, 10),
    chartsRemoteUrl: /^https?:\/\/\S+$/.test(c.chartsRemoteUrl ?? '')
      ? (c.chartsRemoteUrl as string).replace(/\/+$/, '')
      : DEFAULTS.chartsRemoteUrl,
    chartsBasemapUrl: /^https?:\/\/\S+$/.test(c.chartsBasemapUrl ?? '')
      ? (c.chartsBasemapUrl as string).replace(/\/+$/, '')
      : DEFAULTS.chartsBasemapUrl,
    relayUrl: safeRelayUrl(c.relayUrl) ?? DEFAULTS.relayUrl,
    ports: Array.isArray(c.ports)
      ? c.ports
          .filter(
            (p): p is PortEntry =>
              !!p &&
              typeof p.name === 'string' &&
              typeof p.latitude === 'number' &&
              Number.isFinite(p.latitude) &&
              Math.abs(p.latitude) <= 90 &&
              typeof p.longitude === 'number' &&
              Number.isFinite(p.longitude) &&
              Math.abs(p.longitude) <= 180
          )
          .map((p) => ({ ...p, radiusNm: num(p.radiusNm, 4.0, 0.01) }))
      : [],
    voyage: {
      openKnots: num(v.openKnots, DEFAULTS.voyage.openKnots, 0.1),
      openMinutes: num(v.openMinutes, DEFAULTS.voyage.openMinutes, 1),
      closeMinutes: num(v.closeMinutes, DEFAULTS.voyage.closeMinutes, 1),
      mergeMaxGapMinutes: num(v.mergeMaxGapMinutes, DEFAULTS.voyage.mergeMaxGapMinutes, 0),
      mergeMaxHopNm: num(v.mergeMaxHopNm, DEFAULTS.voyage.mergeMaxHopNm, 0),
      mergeShortNm: num(v.mergeShortNm, DEFAULTS.voyage.mergeShortNm, 0)
    }
  }
}

/** JSON Schema rendered by the Signal K admin UI plugin-config screen. */
export const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    boatName: {
      type: 'string',
      title: 'Boat name',
      description: 'Leave empty to use the vessel name configured in Signal K.',
      default: DEFAULTS.boatName
    },
    snapshotSeconds: {
      type: 'number',
      title: 'Snapshot interval (seconds)',
      description: 'How often a history row is recorded. 60 is a good default.',
      default: DEFAULTS.snapshotSeconds,
      minimum: 10
    },
    maxSogKnots: {
      type: 'number',
      title: 'Maximum plausible speed (knots)',
      description:
        'Speed-over-ground readings above this are treated as GPS/AIS glitches and rejected. Set comfortably above your hull maximum.',
      default: DEFAULTS.maxSogKnots,
      minimum: 1
    },
    seasonStart: {
      type: 'string',
      title: 'Season start (MM-DD)',
      description: 'Start of your boating season, used for season statistics.',
      default: DEFAULTS.seasonStart,
      pattern: '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    },
    maxStorageMB: {
      type: 'number',
      title: 'History storage limit (MB)',
      description:
        'Raw history is pruned oldest-first when the limit is reached. Hourly/daily summaries are always kept.',
      default: DEFAULTS.maxStorageMB,
      minimum: 10
    },
    chartsRemoteUrl: {
      type: 'string',
      title: 'Seamark and font server (advanced)',
      description:
        'Base URL the map loads seamarks, fonts and sprites from. Files placed in the plugin\'s "charts" data folder are served locally instead (offline charts).',
      default: DEFAULTS.chartsRemoteUrl
    },
    chartsBasemapUrl: {
      type: 'string',
      title: 'Basemap tile server (advanced)',
      description:
        'TileJSON URL for the coastline, land and place names, in OpenMapTiles schema. The default is a free, keyless, planet-wide host - which, like any tile server, receives the requesting IP address and the tile coordinates being viewed, and those reveal approximately where the boat is, even with remote viewing off. Drop a basemap.pmtiles into the "charts" data folder to keep the chart fully offline, or point this at your own OpenMapTiles server.',
      default: DEFAULTS.chartsBasemapUrl
    },
    ports: {
      type: 'array',
      title: 'Named ports (optional)',
      description: 'Used to label voyage start/end locations. Positions never leave the boat.',
      default: [],
      items: {
        type: 'object',
        required: ['name', 'latitude', 'longitude'],
        properties: {
          name: { type: 'string', title: 'Name' },
          latitude: { type: 'number', title: 'Latitude', minimum: -90, maximum: 90 },
          longitude: { type: 'number', title: 'Longitude', minimum: -180, maximum: 180 },
          radiusNm: {
            type: 'number',
            title: 'Radius (NM)',
            description: 'Voyages starting/ending within this distance are labeled with the port name.',
            default: 4.0
          }
        }
      }
    },
    voyage: {
      type: 'object',
      title: 'Voyage detection',
      properties: {
        openKnots: {
          type: 'number',
          title: 'Underway threshold (knots)',
          description: 'A voyage opens when speed stays above this.',
          default: DEFAULTS.voyage.openKnots
        },
        openMinutes: {
          type: 'number',
          title: 'Open after (minutes)',
          default: DEFAULTS.voyage.openMinutes
        },
        closeMinutes: {
          type: 'number',
          title: 'Close after stationary (minutes)',
          default: DEFAULTS.voyage.closeMinutes
        },
        mergeMaxGapMinutes: {
          type: 'number',
          title: 'Merge: max stop between legs (minutes)',
          description: 'Short stops (e.g. picking up a tender) merge two legs into one voyage.',
          default: DEFAULTS.voyage.mergeMaxGapMinutes
        },
        mergeMaxHopNm: {
          type: 'number',
          title: 'Merge: max drift while stopped (NM)',
          default: DEFAULTS.voyage.mergeMaxHopNm
        },
        mergeShortNm: {
          type: 'number',
          title: 'Merge: max length of the short leg (NM)',
          default: DEFAULTS.voyage.mergeShortNm
        }
      }
    }
  }
}
