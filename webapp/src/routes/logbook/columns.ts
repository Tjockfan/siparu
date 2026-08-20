/**
 * Which columns this logbook page earns, and how each cell is printed.
 *
 * The table used to name six columns in the markup and print six cells in the row, in two
 * separate lists that had to agree. On a boat carrying no barometer that produced a BARO
 * column with a dot in every row, forever - a column whose only content was the news that
 * it had no content. The bridge has answered this since it was drawn (`has()`: a cell exists
 * when the boat puts a value behind it); the logbook did not.
 *
 * The set comes from the rows on screen: a column is drawn when at least one row in the
 * current page has something to put in it. Two consequences, both deliberate:
 *
 *   - An instrument fitted after the window began has no column until its first sample is on
 *     the page. There is nothing to show in the meantime, so the empty column would be the
 *     old dot column with a shorter lifespan.
 *   - Loading further back can add a column, because the older rows can carry a reading the
 *     newer ones do not. The table grows a column rather than lying about one, and the
 *     alternative - deriving the set from the plugin's path list - means writing a fourth
 *     hand-kept copy of the field/path mapping ashore, which is the drift this repo already
 *     files as a defect.
 *
 * One list, read by both the header and the row, so the two cannot disagree about order or
 * membership again.
 */
import type { Snapshot } from "../../lib/api";
import { fmtNum, knotToBeaufort, msToKnots, paToHPa, radToDeg, sogKnFiltered } from "../../lib/format";

export type WindUnit = "kn" | "bft";

export interface LogColumn {
  /** Stable identity, used as the React key and by the tests. */
  key: string;
  head: string;
  /** What this column prints for one row. Never null: an absent reading inside a drawn column
   *  is a gap in a real series, and reads as one. */
  cell: (s: Snapshot) => string;
  /** The barometer is a secondary reading and is set quieter, as it always was. */
  dim?: boolean;
  /** The wind head toggles knots and Beaufort on tap; nothing else does. */
  tappable?: boolean;
}

/** The time column, which every row has by construction - a snapshot is a moment. */
const UTC: LogColumn = {
  key: "ts",
  head: "UTC",
  cell: (s) => {
    const d = new Date(s.ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  },
};

/**
 * Every column the logbook can draw, in reading order, each paired with the question "did the
 * boat report this?". Heading accepts either source, as the row always has: a boat with a
 * magnetic compass and no true heading still has a heading column.
 */
function candidates(windUnit: WindUnit): { col: LogColumn; has: (s: Snapshot) => boolean }[] {
  return [
    {
      col: { key: "sog", head: "SOG", cell: (s) => fmtNum(sogKnFiltered(s.sog), 1) },
      has: (s) => s.sog !== null,
    },
    {
      col: {
        key: "hdg",
        head: "HDG",
        cell: (s) => {
          const h = radToDeg(s.heading_true ?? s.heading_mag);
          return h === null ? "·" : Math.round(h) + "°";
        },
      },
      has: (s) => (s.heading_true ?? s.heading_mag) !== null,
    },
    {
      col: {
        key: "wind",
        head: windUnit === "kn" ? "TWS" : "BFT",
        tappable: true,
        cell: (s) => {
          const tws = msToKnots(s.wind_speed_true);
          if (tws === null) return "·";
          return windUnit === "kn" ? String(Math.round(tws)) : String(knotToBeaufort(tws) ?? "·");
        },
      },
      has: (s) => s.wind_speed_true !== null,
    },
    {
      col: {
        key: "baro",
        head: "BARO",
        dim: true,
        cell: (s) => {
          const b = paToHPa(s.air_pressure_pa);
          return b === null ? "·" : String(Math.round(b));
        },
      },
      has: (s) => s.air_pressure_pa !== null,
    },
    {
      col: { key: "depth", head: "DEP", cell: (s) => (s.depth === null ? "·" : s.depth.toFixed(1)) },
      has: (s) => s.depth !== null,
    },
  ];
}

/**
 * The columns these rows justify. UTC always leads; the rest are kept when any row on the page
 * has a reading for them.
 *
 * `some` rather than a count: one reading is enough to make a column honest, and requiring
 * more would hide a sounder that spoke twice on a day alongside.
 */
export function logbookColumns(snaps: Snapshot[], windUnit: WindUnit): LogColumn[] {
  return [UTC, ...candidates(windUnit).filter((c) => snaps.some(c.has)).map((c) => c.col)];
}
