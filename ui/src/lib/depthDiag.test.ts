/**
 * What is left of this file after the depth micro-diagnosis was removed.
 *
 * The diagnosis had a full suite here and every assertion passed over a screen that could not
 * reach the function: it answered only when depth was null, and the live frame never nulls a
 * depth it has once read. The reasoning is recorded in depthDiag.ts. The datum label stays,
 * because a number without the plane it was measured from is how a metre and a half of draft
 * gets read as clearance, and that one is drawn on every reading.
 */
import { describe, expect, it } from 'vitest'
import { depthDatumLabel } from './depthDiag'

describe('depthDatumLabel', () => {
  it('names each plane in words a person says', () => {
    expect(depthDatumLabel('belowTransducer')).toBe('BELOW TRANSDUCER')
    expect(depthDatumLabel('belowKeel')).toBe('BELOW KEEL')
    expect(depthDatumLabel('belowSurface')).toBe('BELOW SURFACE')
  })

  it('says the datum is unknown rather than guessing a plane', () => {
    // A snapshot from before the field existed, or a value nobody recognises:
    // the honest label is the gap itself, never a default plane.
    expect(depthDatumLabel(null)).toBe('DATUM UNKNOWN')
    expect(depthDatumLabel(undefined)).toBe('DATUM UNKNOWN')
    expect(depthDatumLabel('belowMoon')).toBe('DATUM UNKNOWN')
  })
})
