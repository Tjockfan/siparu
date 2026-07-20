/**
 * The engine, generator and tank panels this boat has, worked out from what she is saying.
 *
 * Nothing here knows how many engines or tanks exist, and there is no list of them to keep up
 * to date. The plugin subscribes to whole families (`propulsion.*`, `tanks.*`,
 * `electrical.generators.*`) and puts whatever a boat reports on the live frame; this sorts
 * those paths into panels and asks `units.ts` what each one is called and how it reads. A boat
 * that grows a fourth fuel tank tomorrow gets a fourth cell without anything here changing.
 *
 * The same `describePath` answers ashore, so a gauge cannot land under Engine on one screen and
 * Tanks on the other, and 24.4 Hz cannot be 1464 rpm here and something else there. That is the
 * whole reason the physics is in the plugin rather than on either screen.
 *
 * A panel with nothing in it is not returned. An empty Engine tab reads as a broken product;
 * a boat that reports no engine simply has no Engine tab, which reads as what it is.
 */
import {
  describePath,
  SYSTEM_TABS,
  SYSTEM_TAB_NAMES,
  systemValue,
  type SystemTab,
} from "../../../../plugin/src/units";
import type { LiveSnapshot } from "../../lib/api";

export interface SystemGauge {
  /** The plain Signal K path, and the key its age arrives under. */
  path: string;
  /** "Port", "Fuel 0", "Generator 1". */
  label: string;
  /** The metric under the label, or null where the label already says it. */
  sub: string | null;
  /** The reading, in the units a person says. */
  value: string;
  /**
   * Seconds since this gauge last moved, or null when the boat is running a plugin old enough
   * not to say. Per gauge on purpose: the frame's own age stays near zero while the GPS keeps
   * talking, so it cannot see one instrument going quiet while the boat sails on.
   */
  ageS: number | null;
}

export interface SystemPanel {
  key: SystemTab;
  name: string;
  gauges: SystemGauge[];
}

/** One parameter across every instance: a row of the engine or generator matrix. */
export interface SystemMatrixRow {
  /** The parameter this row reads, "Revolutions" / "Coolant". Its cells share it. */
  sub: string;
  /** The gauge each instance reports for this parameter, absent where one is silent. */
  cells: Record<string, SystemGauge | undefined>;
}

export interface SystemMatrix {
  /** The instances, one column each, in the order the boat reports them. */
  cols: string[];
  /** The parameters, one row each, in first-seen order. */
  rows: SystemMatrixRow[];
}

/**
 * A panel's gauges rearranged so one parameter reads across every instance on a single row.
 *
 * The flat list draws each gauge once, in the boat's order, which puts a three-engine boat's
 * three tachometers in three different places: you cannot see at a glance that one is running
 * hot. This pivots the same gauges to columns-by-instance, rows-by-parameter, so the readings
 * that mean the same thing sit side by side. It invents nothing - a column that does not report
 * a parameter has no cell on that row - and it keeps a gauge whose `sub` is null (none does on
 * an engine or generator today) as its own row rather than dropping it.
 *
 * Instance and parameter order both follow first appearance, so the boat's own wiring order
 * survives the pivot the way it does in the flat list.
 */
export function toMatrix(gauges: SystemGauge[]): SystemMatrix {
  const cols: string[] = [];
  const rowOrder: string[] = [];
  const at: Record<string, Record<string, SystemGauge>> = {};
  for (const g of gauges) {
    const row = g.sub ?? g.label;
    if (!cols.includes(g.label)) cols.push(g.label);
    if (!(row in at)) {
      at[row] = {};
      rowOrder.push(row);
    }
    at[row][g.label] = g;
  }
  return { cols, rows: rowOrder.map((sub) => ({ sub, cells: at[sub] })) };
}

/** The panels this frame justifies, in the order they are drawn, empty ones dropped. */
export function systemPanels(snap: LiveSnapshot | null): SystemPanel[] {
  const byTab: Record<SystemTab, SystemGauge[]> = { engine: [], generator: [], tanks: [] };

  for (const [path, value] of Object.entries(snap?.paths ?? {})) {
    const d = describePath(path);
    if (!d) continue; // a path no panel claims, or one deliberately suppressed
    const age = snap?.path_ages?.[path];
    byTab[d.tab].push({
      path,
      label: d.label,
      sub: d.sub,
      value: systemValue(path, value),
      ageS: typeof age === "number" ? age : null,
    });
  }

  // Within a panel, the boat's own order. She reports her engines the way she is wired, and
  // that is closer to how her owner thinks about them than any sort we could invent.
  return SYSTEM_TABS.filter((k) => byTab[k].length > 0).map((k) => ({
    key: k,
    name: SYSTEM_TAB_NAMES[k],
    gauges: byTab[k],
  }));
}
