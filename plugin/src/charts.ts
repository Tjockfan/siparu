/**
 * Chart asset resolution + safe file serving.
 *
 * The webapp map loads a basemap, an optional seamark PMTiles, glyph PBFs and a
 * sprite sheet. Seamarks, glyphs and sprites resolve to either a local file under
 * `<dataDir>/charts/` (offline charts, dropped in by the user) or the configured
 * asset server. /map-config reports the resolved URLs; the webapp never guesses.
 *
 * The basemap is the odd one out, because its two sources speak different tile
 * schemas: a local `basemap.pmtiles` is a Protomaps archive, while the hosted
 * basemap is OpenMapTiles vector tiles behind a TileJSON. They cannot be swapped
 * for one another, so they get separate fields and exactly one is ever set. Local
 * wins: charts already on disk cost no bandwidth and survive a dead uplink.
 *
 * Serving stays GET-only and read-only like every other route.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** URL prefix the server mounts our router on - used for local asset URLs. */
const MOUNT = '/plugins/siparu'

export interface MapConfig {
  /** Local Protomaps PMTiles basemap, server-relative. Null when there is none. */
  basemap: string | null
  /** Hosted OpenMapTiles TileJSON. Null when a local basemap is present. */
  basemapTiles: string | null
  seamark: string | null
  /** Glyph URL template containing {fontstack}/{range} placeholders. */
  glyphs: string
  /** Sprite base URL - the style appends the sheet name. */
  sprite: string
  /** Which assets come from the local charts folder (true) vs remote. */
  local: { basemap: boolean; seamark: boolean; fonts: boolean; sprites: boolean }
}

export function chartsDir(dataDir: string): string {
  return path.join(dataDir, 'charts')
}

/** Resolve every map asset to a local or remote URL. Sync fs is fine here:
 *  called once per /map-config request against at most four stat'ed paths. */
export function resolveMapConfig(dataDir: string, remoteBaseUrl: string, basemapTilesUrl: string): MapConfig {
  const dir = chartsDir(dataDir)
  const has = (rel: string): boolean => {
    try {
      return fs.statSync(path.join(dir, rel)).isFile()
    } catch {
      return false
    }
  }
  const hasDir = (rel: string): boolean => {
    try {
      return fs.statSync(path.join(dir, rel)).isDirectory()
    } catch {
      return false
    }
  }
  const localBasemap = has('basemap.pmtiles')
  const localSeamark = has('seamark.pmtiles')
  const localFonts = hasDir('fonts')
  const localSprites = hasDir('sprites')
  return {
    basemap: localBasemap ? `${MOUNT}/charts/basemap.pmtiles` : null,
    basemapTiles: localBasemap ? null : basemapTilesUrl,
    seamark: localSeamark ? `${MOUNT}/charts/seamark.pmtiles` : `${remoteBaseUrl}/seamark.pmtiles`,
    glyphs: localFonts
      ? `${MOUNT}/charts/fonts/{fontstack}/{range}.pbf`
      : `${remoteBaseUrl}/fonts/{fontstack}/{range}.pbf`,
    sprite: localSprites ? `${MOUNT}/charts/sprites` : `${remoteBaseUrl}/sprites`,
    local: { basemap: localBasemap, seamark: localSeamark, fonts: localFonts, sprites: localSprites }
  }
}

const SERVABLE_EXT = new Set(['.pmtiles', '.pbf', '.json', '.png'])

/**
 * Map a request path (everything after /charts/) to an absolute file path
 * inside the charts dir. Returns null for traversal attempts, absolute
 * paths, or extensions we do not serve.
 */
export function safeChartPath(dataDir: string, rel: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.startsWith('/')) return null
  const dir = chartsDir(dataDir)
  const abs = path.normalize(path.join(dir, decoded))
  // normalize()d path must stay inside the charts dir (kills `..` and
  // absolute-path tricks in one check).
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null
  if (!SERVABLE_EXT.has(path.extname(abs).toLowerCase())) return null
  return abs
}

/** Content types express would not guess for our extensions. */
export function chartContentType(absPath: string): string | undefined {
  const ext = path.extname(absPath).toLowerCase()
  if (ext === '.pmtiles') return 'application/octet-stream'
  if (ext === '.pbf') return 'application/x-protobuf'
  return undefined // .json/.png: express sendFile sets these itself
}
