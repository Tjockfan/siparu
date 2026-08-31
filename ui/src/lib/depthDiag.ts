/**
 * The plane a depth reading was taken from, in a person's words.
 *
 * This file used to carry a second thing: a micro-diagnosis that explained an absent depth
 * ("NO SENSOR / NORMAL", "QUIET - last heard 14:02"). It was removed rather than repaired,
 * and the measurement that decided it is worth keeping, because the same trap is one import
 * away from any screen here.
 *
 * The diagnosis could not run. It spoke only when depth was null, and the live frame never
 * nulls a depth it has once read - deliberately, since the shore is meant to show the last
 * known value and say how old it is (plugin/src/index.ts, `live()`: "No horizon here"). So
 * depth is null on exactly one kind of boat, the one that has never reported a depth at all,
 * and that boat is given no depth cell to write a diagnosis in. Both halves were tested and
 * green, and no reader could reach either.
 *
 * What the diagnosis was reaching for is now answered where it belongs: every core field
 * carries its own age on the frame, so a sounder that stops fades its own cell and prints
 * when it last spoke, the same as every other instrument. One mechanism, on the whole bridge,
 * instead of a second one for depth alone that could not fire.
 */

/** The plane the number was read from, in a person's words, sized for the cell's
 *  meta line. A snapshot from before the field existed names no plane, and the
 *  gap is said rather than guessed: naming a plane the data does not name is
 *  how a metre and a half of draft gets read as clearance. */
export function depthDatumLabel(datum: string | null | undefined): string {
  switch (datum) {
    case 'belowTransducer':
      return 'BELOW TRANSDUCER'
    case 'belowKeel':
      return 'BELOW KEEL'
    case 'belowSurface':
      return 'BELOW SURFACE'
    default:
      return 'DATUM UNKNOWN'
  }
}
