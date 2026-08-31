/* Which engine fuel-rate paths count toward voyage fuel, read as the boat
 * reports them today. The selection lives in the plugin's options and outlives
 * the paths that were current when it was made: renaming a propulsion instance,
 * or tidying two sources into one, leaves a filter naming something the boat no
 * longer sends. The voyage figure then integrates nothing and the screen shows
 * no fuel at all, which reads as a broken passage rather than a stale setting.
 * These helpers keep that state visible and undoable. */
import type { FuelPathsView } from "../data/api";

/** propulsion.<instance>.fuel.rate -> "Instance" (Port / Engine / Starboard). */
export function fuelPathLabel(p: string): string {
  const m = p.match(/^propulsion\.([^.]+)\.fuel\.rate$/);
  const inst = m ? m[1] : p;
  return inst.charAt(0).toUpperCase() + inst.slice(1);
}

/** Selected paths the boat is not reporting, in the order they were selected. */
export function fuelSourcesNotReporting(v: FuelPathsView): string[] {
  const reporting = new Set(v.available);
  return v.selected.filter((p) => !reporting.has(p));
}

/**
 * Whether to offer the picker at all. A single-engine boat with nothing
 * narrowed has no choice to make, but a selection that is already in force is
 * always worth reaching: it is the only way to read it, or to lift it.
 */
export function fuelSourceOffered(v: FuelPathsView): boolean {
  return v.available.length > 1 || v.selected.length > 0;
}

/**
 * Rows for the sheet: every reporting path, then any selected path that has
 * gone quiet. The quiet ones have to be listed or they cannot be switched off -
 * the sheet applies the selection it holds, so a path it never drew would be
 * written straight back.
 */
export function fuelSourceRows(v: FuelPathsView): { path: string; reporting: boolean }[] {
  return [
    ...v.available.map((path) => ({ path, reporting: true })),
    ...fuelSourcesNotReporting(v).map((path) => ({ path, reporting: false })),
  ];
}

/**
 * One sentence for the state where the setting names an engine the boat is not
 * sending, so no fuel is counted anywhere. Null while at least one selected
 * source still reports, since the figure is then answerable to something.
 */
export function fuelSourceNotice(v: FuelPathsView): string | null {
  const quiet = fuelSourcesNotReporting(v);
  if (quiet.length === 0 || quiet.length < v.selected.length) return null;
  const who = quiet.map(fuelPathLabel).join(", ");
  return `No fuel counted: ${who} is selected but not reporting a rate.`;
}

/** Short summary for the affordance: "All" when nothing is narrowed. */
export function fuelSourceSummary(v: FuelPathsView): string {
  const quiet = fuelSourcesNotReporting(v);
  if (quiet.length > 0 && quiet.length === v.selected.length) {
    // Nothing selected is reporting, so there is no fuel to show anywhere. Say
    // which engine the setting is waiting for rather than leaving a blank.
    const who = quiet.length === 1 ? fuelPathLabel(quiet[0]) : `${quiet.length} engines`;
    return `${who} · not reporting`;
  }
  if (v.selected.length === 0) return "All";
  if (v.selected.length === 1) return fuelPathLabel(v.selected[0]);
  return `${v.selected.length} engines`;
}
