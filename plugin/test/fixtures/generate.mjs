/**
 * Regenerates season-sample.ndjson.gz: a wholly synthetic, procedurally
 * generated track. No real vessel data is involved at any point. A seeded PRNG
 * lays down an alternating sequence of stationary periods (moored/anchored,
 * SOG ~ 0) and underway legs (SOG at a cruising band, position advanced along a
 * bearing), which is exactly the workout the voyage detector needs: a threshold
 * crossing to open, sustained stillness to close, and legs long enough that the
 * short-leg merge pass leaves them apart.
 *
 * The origin sits in open ocean, far from any berth, so the coordinates trace a
 * path that could not be mistaken for a place. Run with `node generate.mjs`;
 * the output is byte-stable for a given seed. After regenerating the track,
 * re-derive expected-voyages.json from the engine (see README).
 */
import { gzipSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Deterministic PRNG (mulberry32); a fixed seed makes the fixture reproducible.
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = mulberry32(0x51706172) // "Sipar"
const between = (lo, hi) => lo + rnd() * (hi - lo)

const STEP_MS = 60_000 // minute cadence
const MS_TO_KN = 1.94384
const M_PER_DEG_LAT = 111_320

const rows = []
let ts = 1_700_000_000_000 // arbitrary synthetic epoch; only intervals matter
let lat = 35.0 // open Atlantic, no marina within hundreds of miles
let lon = -40.0
const round = (x, n) => {
  const f = 10 ** n
  return Math.round(x * f) / f
}

function push(sog, navState) {
  // ~3% of rows carry no nav_state, mirroring installations that publish SOG
  // but not a navigation state; the detector must lean on SOG alone there.
  const state = rnd() < 0.03 ? null : navState
  rows.push({
    ts,
    lat: round(lat, 7),
    lon: round(lon, 7),
    sog: round(sog, 2),
    nav_state: state
  })
  ts += STEP_MS
}

function stationary(hours) {
  const steps = Math.round((hours * 3600_000) / STEP_MS)
  const state = rnd() < 0.5 ? 'moored' : 'anchored'
  for (let i = 0; i < steps; i++) {
    lat += between(-0.00004, 0.00004) // slow swing at anchor
    lon += between(-0.00004, 0.00004)
    push(between(0.0, 0.08), state) // SOG well under the 1.5 kn open threshold
  }
}

function leg(hours) {
  const steps = Math.round((hours * 3600_000) / STEP_MS)
  const bearing = between(0, 2 * Math.PI)
  const cruiseMs = between(4.0, 5.5) // ~7.8 to 10.7 kn
  for (let i = 0; i < steps; i++) {
    // Ramp in and out so the opening/closing streaks look like a real departure.
    const ramp = Math.min(1, i / 6, (steps - i) / 6)
    const sog = Math.max(0, cruiseMs * ramp + between(-0.2, 0.2))
    const distM = sog * (STEP_MS / 1000)
    lat += (distM * Math.cos(bearing)) / M_PER_DEG_LAT
    lon += (distM * Math.sin(bearing)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180))
    push(sog, 'motoring')
  }
}

stationary(between(6, 10)) // start at rest
for (let i = 0; i < 11; i++) {
  leg(between(3, 9))
  stationary(between(8, 16))
}

const ndjson = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
writeFileSync(path.join(HERE, 'season-sample.ndjson.gz'), gzipSync(Buffer.from(ndjson, 'utf8')))

const spanDays = (rows[rows.length - 1].ts - rows[0].ts) / 86_400_000
const sogs = rows.map((r) => r.sog)
console.error(
  `rows=${rows.length} spanDays=${spanDays.toFixed(2)} ` +
    `maxKn=${(Math.max(...sogs) * MS_TO_KN).toFixed(2)} ` +
    `nullState=${rows.filter((r) => r.nav_state === null).length}`
)
