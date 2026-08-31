/**
 * How long ago something happened, in the coarsest unit that still says something.
 *
 * Mostly the tiers, not the wording. Four screens aboard print an age and they do not all
 * print it the same way: the chart popup packs "3m ago" beside an absolute clock in a
 * dense mono key/value list, the pairing band writes "3 min ago" mid-sentence, and a quiet
 * gauge shows "3 MIN AGO" under its last reading. Those are deliberate typographic
 * settings and flattening them into one string would be a redesign wearing a refactor's
 * clothes. What none of them should own is the arithmetic.
 *
 * The one exception is quietFor at the foot of this file, and the note there says why: two
 * of those four screens are tabs of the same board showing the same kind of gauge, so they
 * are one voice rather than two.
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

/**
 * How stale a reading has to be before a screen stops presenting it as current.
 *
 * Ninety seconds: the standing-still report cadence is sixty, so this leaves room for one
 * frame to be late without calling a working instrument dead. Worked out on the systems
 * panel, and shared from here because the bridge reads the same ages off the same frame.
 * Two thresholds for one question is how an engine gauge came to fade at ninety seconds
 * while, on the tab beside it, a wind speed dead for an hour went on reading confidently.
 */
export const QUIET_AFTER_S = 90;

/**
 * How long a reading has been silent, or null while it is still current.
 *
 * Returns the age rather than a boolean so the caller can print it without asserting the
 * value it has just proved present.
 *
 * An age the boat did not send is not a fresh one. Older plugins send no ages at all, and
 * a field with no value has none by construction, so absent means unknown: the reading is
 * drawn exactly as it was before, unqualified. Claiming freshness we cannot know is the
 * failure this whole mechanism exists to prevent, and it would be a poor bargain to
 * reintroduce it in the default.
 */
export function quietSince(ageS: number | null | undefined): number | null {
  return typeof ageS === "number" && ageS >= QUIET_AFTER_S ? ageS : null;
}

/**
 * How long a gauge has been quiet, in the voice both instrument panels use.
 *
 * The one piece of wording this file does own, against the rule stated at the top, and it
 * is here for that rule's own reason: the bridge and the systems panel are two halves of
 * the same board and a reader moves between them by tapping a tab. Their gauges are the
 * same kind of object drawn at two sizes, so a difference in how they say "this stopped
 * talking" would read as a difference in what happened. The other three voices stay where
 * they are read - they sit in prose, in a popup and in a band, and none of them is this.
 *
 * Upper case in the string rather than a text-transform, which is what the rest of
 * swiss.css would do: the reserve this sits in was measured against the widest string it
 * can return, and moving the case into CSS changes that measurement's terms.
 */
export function quietFor(s: number): string {
  const { value, unit } = ageOf(s);
  return `${value} ${unit.toUpperCase()} AGO`;
}
