/**
 * Place names for the ends of a voyage, looked up aboard from a bundled gazetteer.
 *
 * The detector records where a passage began and ended as a position, and a position is an
 * honest answer but not a readable one: a list of passages written as coordinates tells the
 * owner nothing about where she went. The configured ports (config `ports`) name the ends
 * the owner has told the boat about; this names the rest, from the nearest known place
 * within a few miles. The lookup is a file read and some arithmetic, so no position leaves
 * the boat for it, which is the condition the config text promises.
 *
 * The data file is a filtered extract of the GeoNames gazetteer (CC BY 4.0, see NOTICE)
 * and the World Port Index: harbours, marinas, anchorages, ports, bays, coves, inlets,
 * fjords and lagoons, plus the populated places near them. It is built by
 * tools/build-places.mjs, gzipped, and ships inside the package.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { haversineNm } from './rollup'

/** Names a position, or declines: null where nothing known is near enough. */
export type PlaceResolver = (lat: number | null, lon: number | null) => string | null

/**
 * One gazetteer row: latitude, longitude, name, and a kind where the name is not a town or
 * a haven: 1 for a feature of the water (a bay, a cove, a fjord), 2 for a hamlet or a
 * quarter. The table is sorted by latitude.
 */
type Row = [number, number, string] | [number, number, string, 0 | 1 | 2]

const LAND = 0
const WATER = 1
const HAMLET = 2

interface PlacesFile {
  places?: unknown
}

/** Where the bundled gazetteer sits relative to the compiled module (plugin/dist). */
export const PLACES_FILE = path.join(__dirname, '..', 'data', 'places.json.gz')

/**
 * How far a named place may be from a voyage end and still stand for it. Five miles reaches
 * from an anchorage to the village behind the next headland and no further: past that, the
 * name would be a guess, and a coordinate is the better answer.
 */
export const PLACE_RADIUS_NM = 5

/**
 * A bay or a cove is named only where no town or haven is nearly as close: a boat moored
 * in a marina is at the town, not at the bay the town stands on, even when the bay's own
 * mark on the chart is the nearer point. One mile is the width of a harbour.
 */
export const WATER_HANDICAP_NM = 1

/**
 * A hamlet or a quarter likewise gives way to the town it belongs to: the gazetteer knows
 * the quarter nearest the quay by name, and the owner knows the town. Less than the water's
 * handicap, because a village with no town within a mile of it is the right answer.
 */
export const HAMLET_HANDICAP_NM = 0.75

function isRow(x: unknown): x is Row {
  return (
    Array.isArray(x) &&
    (x.length === 3 || (x.length === 4 && (x[3] === LAND || x[3] === WATER || x[3] === HAMLET))) &&
    typeof x[0] === 'number' &&
    typeof x[1] === 'number' &&
    typeof x[2] === 'string' &&
    x[0] >= -90 &&
    x[0] <= 90 &&
    x[1] >= -180 &&
    x[1] <= 180 &&
    x[2].length > 0
  )
}

export class Gazetteer {
  /**
   * Columns rather than rows: three hundred thousand small arrays cost a Cerbo more memory
   * than the file they came from, where three typed arrays and one list of names cost
   * what the names weigh. Sorted by latitude, so a lookup reads one band of it.
   */
  private constructor(
    private readonly lat: Float64Array,
    private readonly lon: Float64Array,
    private readonly kind: Uint8Array,
    private readonly names: string[]
  ) {}

  /** Parse the JSON text of a places file. Rows that are not [lat, lon, name] are dropped. */
  static parse(text: string): Gazetteer {
    const parsed = JSON.parse(text) as PlacesFile
    const rows = Array.isArray(parsed.places) ? parsed.places.filter(isRow) : []
    rows.sort((a, b) => a[0] - b[0])
    const lat = new Float64Array(rows.length)
    const lon = new Float64Array(rows.length)
    const kind = new Uint8Array(rows.length)
    const names = new Array<string>(rows.length)
    rows.forEach((r, i) => {
      lat[i] = r[0]
      lon[i] = r[1]
      kind[i] = r[3] ?? 0
      names[i] = r[2]
    })
    return new Gazetteer(lat, lon, kind, names)
  }

  /**
   * Read a places file, gzipped or plain, or null when it cannot be read or holds nothing.
   * Either way one line says so. A boat without the gazetteer keeps recording voyages and
   * keeps writing their ends as positions, as she did before it.
   */
  static fromFile(file: string, log?: (msg: string) => void): Gazetteer | null {
    try {
      const bytes = fs.readFileSync(file)
      const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
      const g = Gazetteer.parse(text)
      if (g.size === 0) {
        log?.(`places: ${file} holds no places; voyage ends stay positions`)
        return null
      }
      log?.(`places: ${g.size} places loaded from ${file}`)
      return g
    } catch (err) {
      log?.(`places: gazetteer not loaded from ${file}: ${err}`)
      return null
    }
  }

  /**
   * A resolver that reads the file on its first question rather than at start. The read
   * costs a tenth of a second here and about a second on the small ARM boards Signal K
   * commonly runs on, and a boat whose voyages nobody lists should not pay it at boot. A
   * file that fails to load is not tried again: the answer is positions until a restart.
   */
  static lazy(file: string, log?: (msg: string) => void, withinNm = PLACE_RADIUS_NM): PlaceResolver {
    let loaded: Gazetteer | null | undefined
    return (lat, lon) => {
      if (lat === null || lon === null) return null
      if (loaded === undefined) loaded = Gazetteer.fromFile(file, log)
      return loaded ? loaded.nearest(lat, lon, withinNm) : null
    }
  }

  get size(): number {
    return this.names.length
  }

  /**
   * The nearest place within `withinNm` of the position, or null when there is none. Towns
   * and havens are measured as they lie; a feature of the water or a hamlet carries its
   * handicap, so it is named only where nothing better is nearly as near.
   */
  nearest(lat: number, lon: number, withinNm = PLACE_RADIUS_NM): string | null {
    const band = withinNm / 60
    const cosLat = Math.cos((lat * Math.PI) / 180)
    const lonBand = cosLat > 1e-6 ? band / cosLat : 360
    let best: string | null = null
    let bestScore = Infinity
    for (let i = this.firstAtOrAbove(lat - band); i < this.names.length; i++) {
      const rowLat = this.lat[i]!
      if (rowLat > lat + band) break
      const rowLon = this.lon[i]!
      let dLon = Math.abs(rowLon - lon)
      if (dLon > 180) dLon = 360 - dLon
      if (dLon > lonBand) continue
      const d = haversineNm(lat, lon, rowLat, rowLon)
      if (d >= withinNm) continue
      const k = this.kind[i]
      const score = k === WATER ? d + WATER_HANDICAP_NM : k === HAMLET ? d + HAMLET_HANDICAP_NM : d
      if (score < bestScore) {
        bestScore = score
        best = this.names[i]!
      }
    }
    return best
  }

  /** Index of the first row whose latitude is at or above `lat` (binary search). */
  private firstAtOrAbove(lat: number): number {
    let lo = 0
    let hi = this.lat.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.lat[mid]! < lat) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** This gazetteer as the resolver VoyageLog takes. */
  resolver(withinNm = PLACE_RADIUS_NM): PlaceResolver {
    return (lat, lon) => (lat === null || lon === null ? null : this.nearest(lat, lon, withinNm))
  }
}
