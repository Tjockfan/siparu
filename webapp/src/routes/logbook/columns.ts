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
import { describePath, systemNumeric } from "../../../../plugin/src/units";
import type { Snapshot } from "../../lib/api";
import { fmtNum, knotToBeaufort, kToC, msToKnots, paToHPa, radToDeg, sogKnFiltered } from "../../lib/format";

export type WindUnit = "kn" | "bft";

/**
 * Which log a column belongs in.
 *
 * A ship keeps two: the chief officer's and the engineer's. The screen had only the first, so a
 * boat reporting three engines put none of them in her log at all - and a table with both books
 * open at once is 30 columns wide, which is why the picker exists.
 */
export type LogBook = "bridge" | "engine";

export interface LogColumn {
  /** Stable identity, used as the React key, by the picker's selection and by the tests. */
  key: string;
  head: string;
  book: LogBook;
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
  book: "bridge",
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
      col: { key: "sog", head: "SOG", book: "bridge", cell: (s) => fmtNum(sogKnFiltered(s.sog), 1) },
      has: (s) => s.sog !== null,
    },
    {
      col: {
        key: "cog",
        head: "COG",
        book: "bridge",
        cell: (s) => {
          const c = radToDeg(s.cog);
          return c === null ? "·" : Math.round(c) + "°";
        },
      },
      has: (s) => s.cog !== null,
    },
    {
      col: {
        key: "hdg",
        head: "HDG",
        book: "bridge",
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
        book: "bridge",
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
        key: "awa",
        head: "AWA",
        book: "bridge",
        cell: (s) => {
          const a = radToDeg(s.wind_angle_apparent);
          if (a === null) return "·";
          // Signed, and the sign is the side she is on: an apparent angle read as a bearing
          // leaves a helmsman working out which tack from a number that never goes negative.
          const rel = ((a + 180) % 360) - 180;
          return `${Math.abs(Math.round(rel))}°${rel < 0 ? "P" : "S"}`;
        },
      },
      has: (s) => s.wind_angle_apparent !== null,
    },
    {
      col: {
        key: "baro",
        head: "BARO",
        book: "bridge",
        dim: true,
        cell: (s) => {
          const b = paToHPa(s.air_pressure_pa);
          return b === null ? "·" : String(Math.round(b));
        },
      },
      has: (s) => s.air_pressure_pa !== null,
    },
    {
      col: {
        key: "air",
        head: "AIR",
        book: "bridge",
        cell: (s) => fmtNum(kToC(s.air_temp_k), 1),
      },
      has: (s) => s.air_temp_k !== null,
    },
    {
      col: {
        key: "sea",
        head: "SEA",
        book: "bridge",
        cell: (s) => fmtNum(kToC(s.water_temp_k), 1),
      },
      has: (s) => s.water_temp_k !== null,
    },
    {
      col: {
        key: "depth",
        head: "DEP",
        book: "bridge",
        cell: (s) => (s.depth === null ? "·" : s.depth.toFixed(1)),
      },
      has: (s) => s.depth !== null,
    },
  ];
}

/**
 * How a gauge's parameter is headed in a column two figures wide.
 *
 * Spelled out rather than truncated: "Oil pressure" cut to four characters is "Oil " and
 * "Engine load" is "Engi". A parameter nobody listed falls back to its first word, which is at
 * least a word she said.
 */
const METRIC_HEAD: Record<string, string> = {
  Revolutions: "RPM",
  Temperature: "TEMP",
  "Oil pressure": "OIL",
  "Oil temperature": "OILT",
  "Coolant temperature": "COOL",
  "Coolant pressure": "COOLP",
  "Exhaust temperature": "EXH",
  "Intake manifold temperature": "INTK",
  "Boost pressure": "BOOST",
  "Engine load": "LOAD",
  "Engine torque": "TORQ",
  "Run time": "HRS",
  "Fuel rate": "FUEL",
  "Fuel used (since reset)": "USED",
  "Fuel pressure": "FUELP",
  "Alternator voltage": "ALT",
  // A gearbox has both an oil temperature and an oil pressure, and both shortened to their
  // first word: two columns headed GEARBOX in a list of forty, and the reader picking one got
  // whichever came first.
  "Gearbox oil temperature": "GBOXT",
  "Gearbox oil pressure": "GBOXP",
  "Current level": "LEVEL",
  Voltage: "VOLT",
  Current: "AMP",
};

/**
 * How a unit is headed: the initial of a side, the number of a numbered one.
 *
 * "Port" and "Starboard" share no initial with each other and none with "Center", so a letter
 * is enough on the boats that name their sides; a numbered engine keeps its number, which is
 * the only thing distinguishing it from the next one.
 */
function unitHead(label: string): string {
  const m = /^(Engine|Generator|Fuel|Fresh water|Black water|Grey water|Lubrication)\s+(\S+)$/.exec(label);
  if (m) return `${m[1][0]}${m[2]}`.toUpperCase();
  return label.slice(0, 1).toUpperCase();
}

/**
 * The engineer's columns, one per gauge the boat put in these rows.
 *
 * Derived exactly like the bridge's: from the readings on the page, never from a list written
 * down here. A boat with one engine is offered one tachometer column and a boat with three is
 * offered three, and neither case is written anywhere.
 *
 * Order is the boat's own, which on a multi-engine boat groups her by parameter the way she
 * reports them - port, centre, starboard - rather than by an order invented ashore.
 */
function engineCandidates(snaps: Snapshot[]): { col: LogColumn; has: (s: Snapshot) => boolean }[] {
  const paths: string[] = [];
  for (const s of snaps) {
    for (const p of Object.keys(s.path_values ?? {})) if (!paths.includes(p)) paths.push(p);
  }
  const out: { col: LogColumn; has: (s: Snapshot) => boolean }[] = [];
  for (const path of paths) {
    const d = describePath(path);
    // A path no reading describes gets no column: a header would be a guess at what it is.
    if (!d || d.sub === null) continue;
    const metric = METRIC_HEAD[d.sub] ?? d.sub.split(" ")[0]!.toUpperCase();
    out.push({
      col: {
        key: `p:${path}`,
        head: `${unitHead(d.label)} ${metric}`,
        book: "engine",
        cell: (s) => {
          const v = s.path_values?.[path];
          if (typeof v !== "number") return "·";
          const n = systemNumeric(path, v).value;
          return Number.isInteger(n) ? String(n) : n.toFixed(1);
        },
      },
      has: (s) => typeof s.path_values?.[path] === "number",
    });
  }
  return out;
}

/**
 * The columns these rows justify. UTC always leads; the rest are kept when any row on the page
 * has a reading for them.
 *
 * `some` rather than a count: one reading is enough to make a column honest, and requiring
 * more would hide a sounder that spoke twice on a day alongside.
 */
export function logbookColumns(snaps: Snapshot[], windUnit: WindUnit): LogColumn[] {
  const earned = [...candidates(windUnit), ...engineCandidates(snaps)].filter((c) =>
    snaps.some(c.has)
  );
  return [UTC, ...earned.map((c) => c.col)];
}

/**
 * One book's columns out of everything these rows earned.
 *
 * The time column belongs to both and is kept whichever book is asked for: it is the moment
 * every other reading on the row is a reading AT, and an engineer's page whose rows carry no
 * hour is a list of numbers rather than a log.
 */
export function columnsFor(cols: LogColumn[], book: LogBook): LogColumn[] {
  return cols.filter((c) => c.key === "ts" || c.book === book);
}
