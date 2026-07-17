/**
 * A voyage's fuel, read the way the person asked to read it.
 *
 * The boat measures one thing: litres burned, integrated from the engines' own
 * reported rate (plugin `integrateMetrics`). Everything here is that one number
 * reframed - a total in another unit, or divided by the trip's distance or
 * hours. Nothing is estimated; a frame whose denominator is missing (no
 * distance, no fuel, no time) returns null rather than an infinity or a zero
 * dressed as a reading.
 *
 * This is where the naming that `units.ts` refused to do on a live gauge
 * becomes safe: there, an unlabelled "economy" cell collided two quantities
 * (L/h and L/nm) with no way to tell them apart. Here the person picks the
 * frame by name from a menu, so "Litres / nm" and "nm / litre" each say exactly
 * what they are and cannot be confused for the other.
 */

export type FuelMode =
  | 'total_l'
  | 'total_usgal'
  | 'total_impgal'
  | 'per_nm'
  | 'nm_per_l'
  | 'per_hour'

export const FUEL_MODES: { mode: FuelMode; label: string }[] = [
  { mode: 'total_l', label: 'Litres' },
  { mode: 'total_usgal', label: 'US gallons' },
  { mode: 'total_impgal', label: 'Imp gallons' },
  { mode: 'per_nm', label: 'Litres / nm' },
  { mode: 'nm_per_l', label: 'nm / L' },
  { mode: 'per_hour', label: 'Litres / hour' },
]

const L_TO_US_GAL = 0.26417205
const L_TO_IMP_GAL = 0.21996923

/** A denominator this small is treated as absent: a metre of drift, a few idling seconds. */
const EPS = 1e-6

function fmt(value: number, unit: string, decimals: number): string {
  return `${value.toFixed(decimals)} ${unit}`
}

/**
 * The trip's fuel in the chosen frame, or null when it cannot be honestly
 * shown: the boat reports no fuel (`litres` null), or the frame divides by a
 * distance/time the trip does not have.
 */
export function fuelReadout(
  litres: number | null,
  distanceNm: number,
  hoursUnderway: number,
  mode: FuelMode
): string | null {
  if (litres === null || !Number.isFinite(litres)) return null

  switch (mode) {
    case 'total_l':
      return fmt(litres, 'L', litres < 100 ? 1 : 0)
    case 'total_usgal':
      return fmt(litres * L_TO_US_GAL, 'US gal', 1)
    case 'total_impgal':
      return fmt(litres * L_TO_IMP_GAL, 'Imp gal', 1)
    case 'per_nm':
      return distanceNm > EPS ? fmt(litres / distanceNm, 'L/nm', 2) : null
    case 'nm_per_l':
      return litres > EPS ? fmt(distanceNm / litres, 'nm/L', 2) : null
    case 'per_hour':
      return hoursUnderway > EPS ? fmt(litres / hoursUnderway, 'L/h', 1) : null
  }
}
