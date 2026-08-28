/**
 * The engineer's log read the way an engineer keeps it: one row per machine, not one column.
 *
 * A three-engine boat reports thirty-six readings a minute, and a column apiece put them in a
 * table thirty-six lanes wide - every lane at its 48px minimum, headed "P GBOXT", with the port
 * tachometer and the starboard one at opposite ends of the screen. The two figures a chief
 * engineer actually compares were the two furthest apart in the room.
 *
 * A machine is a row here and a reading is a column, which is how the book has been kept since
 * it was kept in ink: the hour on the left, the machines under it, one line each. Twelve lanes
 * instead of thirty-six, and port against starboard is a glance down a column.
 *
 * The shape is the boat's, never a list written here: what the units are, what they report and
 * in what order all come out of the paths on the page. A boat that grows a fourth engine grows
 * a fourth line the hour she reports it.
 */
import { describePath, systemNumeric } from "../../../../plugin/src/units";
import type { Snapshot } from "../../lib/api";
import { metricHead } from "./columns";

/** One reading a family takes, drawn as a column across its machines. */
export interface UnitMetric {
  /** The reading's own name, as the path describes it ("Oil pressure"). */
  key: string;
  head: string;
}

/** One machine in a family, drawn as a row: what it is called and where its readings live. */
export interface UnitRow {
  /** The unit's label from the path ("Port", "Generator 1"). */
  key: string;
  head: string;
  /** Metric key to the path carrying it, for this unit alone. */
  paths: Record<string, string>;
}

/** A family of machines that share a shape: the engines, the generators, the tanks. */
export interface UnitGroup {
  tab: string;
  head: string;
  units: UnitRow[];
  metrics: UnitMetric[];
}

/**
 * What each family is called on the tab that opens it.
 *
 * Plural because the tab names a book, not a machine: a reader picking between "Engines" and
 * "Tanks" is choosing which log to open. The three keys are the whole of what `describePath`
 * can return, so a family without a name here is a family that does not exist.
 */
const GROUP_HEAD: Record<string, string> = {
  engine: "ENGINES",
  generator: "GENERATORS",
  tanks: "TANKS",
};

/**
 * The families these rows carry, each with its machines and its readings in the boat's own order.
 *
 * Order is the order the paths arrived, which on a multi-engine boat is port, centre, starboard,
 * because that is how she reports them - and it is the order an engineer reads them in. Sorting
 * would replace her arrangement with an alphabet.
 */
export function unitGroups(snaps: Snapshot[]): UnitGroup[] {
  const tabs: string[] = [];
  /** tab -> unit label -> metric key -> path */
  const byTab = new Map<string, Map<string, Map<string, string>>>();
  /** tab -> metric key, in the order the boat first mentioned each */
  const metricsByTab = new Map<string, string[]>();

  for (const s of snaps) {
    for (const path of Object.keys(s.path_values ?? {})) {
      const d = describePath(path);
      // A path no reading describes has no unit and no metric: a row headed with a guess is
      // worse than a path left out of the book.
      if (!d || d.sub === null) continue;
      if (!byTab.has(d.tab)) {
        tabs.push(d.tab);
        byTab.set(d.tab, new Map());
        metricsByTab.set(d.tab, []);
      }
      const units = byTab.get(d.tab)!;
      if (!units.has(d.label)) units.set(d.label, new Map());
      units.get(d.label)!.set(d.sub, path);
      const metrics = metricsByTab.get(d.tab)!;
      if (!metrics.includes(d.sub)) metrics.push(d.sub);
    }
  }

  return tabs.map((tab) => {
    const units: UnitRow[] = [...byTab.get(tab)!].map(([label, paths]) => ({
      key: label,
      head: label.toUpperCase(),
      paths: Object.fromEntries(paths),
    }));
    const metrics: UnitMetric[] = metricsByTab.get(tab)!.map((sub) => ({
      key: sub,
      head: metricHead(sub),
    }));
    return { tab, head: GROUP_HEAD[tab] ?? tab.toUpperCase(), units, metrics };
  });
}

/**
 * One machine's reading at one moment, printed.
 *
 * A unit that does not carry this metric at all and one that carries it and had nothing to say
 * print the same mark, because to the reader they are the same fact: no figure for this box.
 * The gap is the reading, and a blank cell would leave him counting lanes to find out which.
 */
export function unitCell(s: Snapshot, unit: UnitRow, metric: UnitMetric): string {
  const path = unit.paths[metric.key];
  if (path === undefined) return "·";
  const v = s.path_values?.[path];
  if (typeof v !== "number") return "·";
  const n = systemNumeric(path, v).value;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
