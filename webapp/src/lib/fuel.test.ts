import { describe, expect, it } from 'vitest'
import { fuelReadout } from './fuel'

// A 90-minute trip: 120 L burned over 12 nm.
const L = 120
const NM = 12
const H = 1.5

describe('fuelReadout', () => {
  it('shows the total in litres', () => {
    expect(fuelReadout(L, NM, H, 'total_l')).toBe('120 L')
    expect(fuelReadout(48.4, NM, H, 'total_l')).toBe('48.4 L') // one decimal under 100
  })

  it('converts the total to US and Imperial gallons', () => {
    expect(fuelReadout(L, NM, H, 'total_usgal')).toBe('31.7 US gal') // 120 * 0.264172
    expect(fuelReadout(L, NM, H, 'total_impgal')).toBe('26.4 Imp gal') // 120 * 0.219969
  })

  it('divides by distance and by its inverse', () => {
    expect(fuelReadout(L, NM, H, 'per_nm')).toBe('10.00 L/nm')
    expect(fuelReadout(L, NM, H, 'nm_per_l')).toBe('0.10 nm/L')
  })

  it('divides by hours for the average burn', () => {
    expect(fuelReadout(L, NM, H, 'per_hour')).toBe('80.0 L/h')
  })

  it('returns null when the boat reports no fuel', () => {
    for (const m of ['total_l', 'per_nm', 'nm_per_l', 'per_hour'] as const) {
      expect(fuelReadout(null, NM, H, m)).toBeNull()
    }
  })

  it('returns null for a frame whose denominator the trip lacks', () => {
    expect(fuelReadout(L, 0, H, 'per_nm')).toBeNull() // no distance
    expect(fuelReadout(0, NM, H, 'nm_per_l')).toBeNull() // no fuel to divide into
    expect(fuelReadout(L, NM, 0, 'per_hour')).toBeNull() // no time under way
  })

  it('still reports a real zero total', () => {
    // Engine reported a rate but the trip was too short to accrue: 0 L is a
    // reading, not an absence. Only the ratios that divide BY it fall to null.
    expect(fuelReadout(0, NM, H, 'total_l')).toBe('0.0 L')
    expect(fuelReadout(0, NM, H, 'per_nm')).toBe('0.00 L/nm')
  })
})
