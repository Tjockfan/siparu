/**
 * The passage she is on, read as a trip computer reads it.
 *
 * Nothing here is measured. The boat already integrates distance, time under
 * way, the speeds and the litres burned (plugin `integrateMetrics`), and this
 * file reframes those five numbers into the cells an owner watches while under
 * way: how long, how far, how fast, how much, and how much per hour and per
 * mile. A reading whose denominator the passage does not have is not printed,
 * so a boat lying at anchor loses the averages instead of showing a zero or an
 * infinity dressed as a measurement.
 *
 * `idle` is deliberately absent, and it is the one cell a trip computer is
 * expected to have. Duration minus time under way is a real number of minutes,
 * but it is two different things added together: minutes she lay still with the
 * log running, and minutes nobody was recording because the boat was switched
 * off between snapshots. The voyage rows cannot tell them apart. Printing the
 * sum as "idle" would tell an owner his boat sat idling for three hours when
 * she was on the hard with the panel dark, so both spans are printed and the
 * subtraction is left to the person who knows which it was.
 */

import type { Voyage } from './api'

export interface TripReading {
  key: string
  /** The cell's own words. Sub carries the unit, as the bridge cells do. */
  label: string
  sub: string
  value: string
}

/** A denominator this small is absent: a metre of drift, a few idling seconds. */
const EPS = 1e-6

/** Hours and minutes, hours running past 24 rather than wrapping. */
function span(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * The cells this passage justifies, in reading order. Absent cells are absent
 * from the array: the panel draws what it is given and owns no list of its own,
 * which is the same rule the bridge and the system panels follow.
 */
export function tripReadings(v: Voyage, now: number): TripReading[] {
  const out: TripReading[] = []
  const cell = (key: string, label: string, sub: string, value: string) =>
    out.push({ key, label, sub, value })

  // A closed passage stops counting at its own end; an open one runs to now.
  const end = v.end_ts ?? now
  const elapsed = end - v.start_ts
  if (elapsed >= 0) cell('duration', 'Duration', v.end_ts === null ? 'So far' : 'Total', span(elapsed))

  if (v.hours_underway > EPS) {
    cell('underway', 'Under way', 'Moving', span(v.hours_underway * 3600_000))
  }

  cell('distance', 'Distance', 'nm', v.distance_nm.toFixed(1))

  if (v.avg_sog_kn !== null) cell('avgSpeed', 'Average speed', 'kn', v.avg_sog_kn.toFixed(1))
  if (v.max_sog_kn !== null) cell('maxSpeed', 'Max speed', 'kn', v.max_sog_kn.toFixed(1))

  // Fuel is measured off the bus or not at all. A boat whose engines report no
  // rate has no litres, and the three cells below simply do not exist for her.
  const litres = v.fuel_used_l
  if (litres !== null && Number.isFinite(litres)) {
    cell('fuelUsed', 'Fuel used', 'L', litres.toFixed(1))
    // Named as a pair, and in the words the live gauge beside them already uses ("Fuel per
    // mile", units.ts): the two are one quantity in two frames, and an owner comparing the
    // passage average against the instantaneous burn reads them together.
    if (v.hours_underway > EPS) {
      cell('fuelPerHour', 'Fuel per hour', 'L/h', (litres / v.hours_underway).toFixed(1))
    }
    if (v.distance_nm > EPS) {
      cell('fuelPerMile', 'Fuel per mile', 'L/nm', (litres / v.distance_nm).toFixed(2))
    }
  }

  return out
}
