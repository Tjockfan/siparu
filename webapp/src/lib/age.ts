/**
 * How long ago something happened, in the coarsest unit that still says something.
 *
 * The tiers only, not the wording. Three screens aboard print an age and all three print
 * it differently: the chart popup packs "3m ago" beside an absolute clock in a dense mono
 * key/value list, the pairing band writes "3 min ago" mid-sentence, and a quiet gauge
 * shows "3 MIN AGO" under its last reading. Those are three deliberate typographic
 * settings and flattening them into one string would be a redesign wearing a refactor's
 * clothes. What none of them should own is the arithmetic.
 *
 * That arithmetic had drifted into three different answers to the same question. Two of
 * them were wrong in ways the third had already found, written down, and fixed only for
 * itself:
 *
 *   - Rounding overstates exactly where it is read. A gauge quiet for the ninety seconds
 *     that trip the stale threshold announced "2 MIN AGO", and one quiet for 3599 seconds
 *     said "60 MIN AGO" rather than an hour. So: floor, everywhere.
 *   - There is no ceiling on the far side. The plugin never forgets a path it has seen
 *     once, so a boat wintering ashore read "3611 H AGO" and expected somebody to divide.
 *     So: a day tier, everywhere.
 *
 * A comment asking three files to agree is what this repo keeps proving does not hold.
 */

export type AgeUnit = "s" | "min" | "h" | "d";

export interface Age {
  /** Whole units, floored. */
  value: number;
  unit: AgeUnit;
}

/**
 * Seconds into the tier a person reads them in.
 *
 * Note what happens to an age that is not a number: every comparison against NaN is
 * false, so it falls the length of the ladder and lands in days, and the caller prints
 * "NaN d ago". That is inherited, not chosen - all three copies did exactly this before
 * they were one, each in its own coarsest unit - and it is left alone here so that this
 * change stays a move rather than a move plus a fix. It is the same shape as the NaN that
 * used to walk out of the Beaufort ladder as a hurricane, and it wants the same treatment
 * in a slice of its own, where breaking it can be the point.
 */
export function ageOf(seconds: number): Age {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return { value: s, unit: "s" };
  if (s < 3600) return { value: Math.floor(s / 60), unit: "min" };
  if (s < 86400) return { value: Math.floor(s / 3600), unit: "h" };
  return { value: Math.floor(s / 86400), unit: "d" };
}
