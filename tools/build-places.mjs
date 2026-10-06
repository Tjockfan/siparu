#!/usr/bin/env node
/**
 * Build plugin/data/places.json.gz, the gazetteer that names voyage ends, from a GeoNames
 * dump and the World Port Index.
 *
 *   node tools/build-places.mjs allCountries.txt UpdatedPub150.csv plugin/data/places.json.gz
 *
 * The dump is https://download.geonames.org/export/dump/allCountries.zip (CC BY 4.0,
 * about 1.8 GB unzipped). The port index is NGA Publication 150, UpdatedPub150.csv from
 * https://msi.nga.mil (a work of the US government, public domain): 3,800 ports with the
 * name a sailor uses, where GeoNames often has the quarter or hamlet nearest the quay.
 * This script downloads neither: a release that rebuilds the gazetteer does so
 * deliberately, with dated sources, and says so in the changelog.
 *
 * What is kept, and why. A voyage ends on the water, near a coast, so the gazetteer wants
 * the places a sailor would name: harbours, marinas, anchorages, bays, coves, inlets, fjords
 * and lagoons, and the towns and villages behind them. The whole dump is thirteen million
 * rows, most of them inland or not places at all. Two passes:
 *
 *   1. Every named feature of the sea and the shore (the SEA set) is read as a marker of
 *      where the water is; those in the HAVEN and WATER subsets go into the gazetteer too.
 *   2. A populated place is kept when it lies within COAST_KM of one of those markers. That
 *      is the coastal filter: no coastline geometry, just "is there something of the sea
 *      nearby", which is what being on the coast means to a boat.
 *
 * Inland waters come along where GeoNames names their shores the way it names the sea's
 * (a bay on a great lake is a BAY): coverage there is incidental, neither promised nor
 * removed. A boat with nothing named within five miles gets a coordinate, as every boat
 * did before this file existed.
 *
 * Islands are read as markers of the sea but not named: there are a hundred and seventy
 * thousand named islets in the dump, most of them skerries, and the bay, fjord or village
 * within five miles says where the boat is just as well, at a third of the file.
 *
 * Each row is [latitude, longitude, name] for a haven (harbour, marina, anchorage, port),
 * a seat of administration or a town of a thousand or more; [latitude, longitude, name, 1]
 * for a feature of the water itself (bay, cove, inlet, fjord, lagoon); and
 * [latitude, longitude, name, 2] for a village, hamlet or quarter whose population GeoNames
 * does not know or puts under a thousand. The plugin handicaps the second and third kinds
 * by a fraction of a mile, so a boat in a marina is at the town rather than at the bay the
 * town stands on or the quarter nearest the quay, while a village with nothing larger
 * near it is still named.
 *
 * The output is gzipped JSON. Uncompressed it is three times the size of the rest of the
 * package, and the names are in every script there is; zlib is in Node, so reading it
 * costs nothing the plugin does not already have.
 */
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { gzipSync } from 'node:zlib'

const [, , input, portIndex, output] = process.argv
if (!input || !portIndex || !output) {
  console.error('usage: build-places.mjs <allCountries.txt> <UpdatedPub150.csv> <places.json.gz>')
  process.exit(2)
}

/**
 * Features of the sea and the shore, by GeoNames feature code, each checked against the
 * published table (featureCodes_en.txt). Markers of where water is. Classes: H hydrographic,
 * T hypsographic, S spot, and L for PRT, which GeoNames files under "area" rather than
 * water. Stream banks and stock tanks are not here: they are inland, and a marker that is
 * inland makes an inland village read as coastal.
 */
const SEA = new Set([
  // H: hydrographic
  'HBR', 'HBRX', 'MAR', 'ANCH', 'BAY', 'BAYS', 'COVE', 'INLT', 'FJD', 'FJDS', 'LGN', 'LGNS',
  'SD', 'CHN', 'CHNM', 'CHNN', 'STRT', 'GULF', 'SEA', 'OCN', 'RF', 'SHOL', 'BNK', 'ESTY',
  'NRWS', 'WHRF', 'DCK', 'DCKB', 'DCKD', 'BGHT',
  // T: hypsographic, the shore itself
  'CAPE', 'PT', 'PTS', 'BCH', 'BCHS', 'HDLD', 'ISL', 'ISLS', 'ISLET', 'ISLT', 'PEN', 'PENX',
  'SPIT', 'CLF', 'SHOR', 'ATOL', 'CFT', 'MOLE',
  // S: spots a sailor steers by
  'LTHSE', 'BTYD', 'PIER', 'QUAY', 'JTY', 'BRKW', 'STNC', 'FY',
  // L: the one "area" code that is a haven
  'PRT'
])
const SEA_CLASSES = new Set(['H', 'T', 'S', 'L'])

/** The subset of SEA worth a name of its own on a voyage: a boat stops at these. */
const HAVEN = new Set(['HBR', 'MAR', 'ANCH', 'PRT', 'BTYD'])
const WATER = new Set(['BAY', 'COVE', 'INLT', 'FJD', 'LGN'])

/** Longer than this is a description, not a name a sailor would say. */
const NAME_MAX = 40

/** Populated places kept when coastal. Sections, ruins, abandoned and former places are not. */
const TOWN = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLCD', 'PPLG', 'PPLS', 'PPLF'])
/** Seats of administration: towns by role, whatever population GeoNames has for them. */
const SEAT = new Set(['PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC', 'PPLCD', 'PPLG'])
/** A populated place with fewer people than this, or an unknown count, is a hamlet. */
const TOWN_POP = 1000

const WATER_KIND = 1
const HAMLET_KIND = 2

/** How near to a sea feature a town must be to count as coastal. */
const COAST_KM = 3

/**
 * Grid cell size for the proximity check, in degrees of latitude. One cell is a shade over
 * COAST_KM north to south everywhere; east to west a degree shrinks with the cosine of the
 * latitude, so the search reaches across as many cells as COAST_KM needs there.
 */
const CELL = 0.03
const KM_PER_DEG = 111.32

const toRad = (d) => (d * Math.PI) / 180
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)))
}

const cellKey = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`

/** Markers by grid cell, so the coastal test looks at nine cells rather than the world. */
const markers = new Map()
function mark(lat, lon) {
  const key = cellKey(lat, lon)
  let cell = markers.get(key)
  if (!cell) markers.set(key, (cell = []))
  cell.push(lat, lon)
}
function nearSea(lat, lon) {
  const ci = Math.floor(lat / CELL)
  const cj = Math.floor(lon / CELL)
  const jSpan = Math.ceil(COAST_KM / (KM_PER_DEG * CELL * Math.max(Math.cos(toRad(lat)), 0.05)))
  for (let i = ci - 1; i <= ci + 1; i++) {
    for (let j = cj - jSpan; j <= cj + jSpan; j++) {
      const cell = markers.get(`${i},${j}`)
      if (!cell) continue
      for (let k = 0; k < cell.length; k += 2) {
        if (haversineKm(lat, lon, cell[k], cell[k + 1]) <= COAST_KM) return true
      }
    }
  }
  return false
}

/** A name without case or accents, so "Saint-Tropez" and "SAINT-TROPEZ" are one name. */
const plain = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/**
 * Rows kept, and a guard against the same name twice within about a kilometre of itself:
 * the name is looked up in its own hundredth-of-a-degree cell and the eight around it, so
 * a duplicate straddling a cell edge is still a duplicate.
 */
const kept = []
const seen = new Set()
const DUP_CELL = 0.01
function keep(lat, lon, name, kind) {
  if (name.length > NAME_MAX) return
  const key = plain(name)
  const ci = Math.floor(lat / DUP_CELL)
  const cj = Math.floor(lon / DUP_CELL)
  for (let i = ci - 1; i <= ci + 1; i++) {
    for (let j = cj - 1; j <= cj + 1; j++) {
      if (seen.has(`${key}|${i},${j}`)) return
    }
  }
  seen.add(`${key}|${ci},${cj}`)
  const row = [Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, name]
  if (kind) row.push(kind)
  kept.push(row)
}

/** Whether a kept row of this name lies within `km` of the position. */
function keptNear(name, lat, lon, km) {
  const want = plain(name)
  for (const row of kept) {
    if (Math.abs(row[0] - lat) > 0.05) continue
    if (plain(row[2]) === want && haversineKm(lat, lon, row[0], row[1]) <= km) return true
  }
  return false
}

async function pass(fn) {
  const rl = createInterface({ input: createReadStream(input, { encoding: 'utf8' }), crlfDelay: Infinity })
  let n = 0
  for await (const line of rl) {
    n++
    const cols = line.split('\t')
    // geonameid, name, asciiname, alternatenames, latitude, longitude, class, code, ...
    const name = cols[1]
    const lat = Number(cols[4])
    const lon = Number(cols[5])
    const cls = cols[6]
    const code = cols[7]
    const population = Number(cols[14]) || 0
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    fn(name, lat, lon, cls, code, population)
  }
  return n
}

const t0 = Date.now()
let seaRows = 0
const rows = await pass((name, lat, lon, cls, code) => {
  if (SEA_CLASSES.has(cls) && SEA.has(code)) {
    seaRows++
    mark(lat, lon)
    if (HAVEN.has(code)) keep(lat, lon, name, 0)
    else if (WATER.has(code)) keep(lat, lon, name, WATER_KIND)
  }
})
const namedSea = kept.length
console.error(`pass 1: ${rows} rows, ${seaRows} sea and shore markers, ${namedSea} named (${((Date.now() - t0) / 1000).toFixed(0)} s)`)

let towns = 0
let hamlets = 0
await pass((name, lat, lon, cls, code, population) => {
  if (cls === 'P' && TOWN.has(code) && nearSea(lat, lon)) {
    const town = SEAT.has(code) || population >= TOWN_POP
    if (town) towns++
    else hamlets++
    keep(lat, lon, name, town ? 0 : HAMLET_KIND)
  }
})
console.error(`pass 2: ${towns} coastal towns and ${hamlets} hamlets, ${kept.length} places in all (${((Date.now() - t0) / 1000).toFixed(0)} s)`)

// The port index last, and only where GeoNames did not already carry the same name within
// three kilometres: the index is coarse to the minute of arc, so where both know a port
// the GeoNames position is the better one.
function csvRows(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}
const index = csvRows(readFileSync(portIndex, 'utf8').replace(/^\uFEFF/, ''))
const header = index[0]
const col = (title) => header.indexOf(title)
const nameCol = col('Main Port Name')
const latCol = col('Latitude')
const lonCol = col('Longitude')
if (nameCol < 0 || latCol < 0 || lonCol < 0) {
  console.error('the port index does not have the columns this script expects')
  process.exit(1)
}
let ports = 0
let portsNew = 0
for (const row of index.slice(1)) {
  const name = (row[nameCol] || '').trim()
  const lat = Number(row[latCol])
  const lon = Number(row[lonCol])
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
  ports++
  if (keptNear(name, lat, lon, 3)) continue
  portsNew++
  keep(lat, lon, name, 0)
}
console.error(`port index: ${ports} ports read, ${portsNew} added, ${kept.length} places in all (${((Date.now() - t0) / 1000).toFixed(0)} s)`)

kept.sort((a, b) => a[0] - b[0] || a[1] - b[1])

const day = (f) => statSync(f).mtime.toISOString().slice(0, 10)
const json = JSON.stringify({
  source: 'GeoNames gazetteer (https://www.geonames.org, CC BY 4.0) and the NGA World Port Index (public domain). Extract of coastal places built by tools/build-places.mjs.',
  built: new Date().toISOString().slice(0, 10),
  dumps: { geonames: day(input), portIndex: day(portIndex) },
  places: kept
}).replace(/\],\[/g, '],\n[')
const packed = gzipSync(json, { level: 9 })
writeFileSync(output, packed)
const digest = createHash('sha256').update(packed).digest('hex')
console.error(`wrote ${output}: ${kept.length} places, ${(json.length / 1e6).toFixed(1)} MB of JSON, ${(packed.length / 1e6).toFixed(1)} MB gzipped`)
console.error(`sha256 ${digest} (record it in the changelog with the dump dates)`)
