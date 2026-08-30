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
import { describePath, systemNumeric, unitFor, type SystemReading } from "../../../../plugin/src/units";
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
  /** Which family of machines this reading belongs to, for the engineer's tabs. Absent on the
   *  bridge's columns, which are the boat herself and not a machine aboard her. */
  tab?: string;
  /** What this column prints for one row. Never null: an absent reading inside a drawn column
   *  is a gap in a real series, and reads as one. */
  cell: (s: Snapshot) => string;
  /** The barometer is a secondary reading and is set quieter, as it always was. */
  dim?: boolean;
  /** The wind head toggles knots and Beaufort on tap; nothing else does. */
  tappable?: boolean;
  /**
   * The unit the figures under this head are printed in, named once over the column instead of
   * three hundred times down it.
   *
   * Absent where the cell carries its own mark and a head would only say it twice: a course
   * prints "124", a position prints its degrees and its hemisphere, a time is a time. Absent
   * too where the boat reports a metric this build has no unit for, which is the same silence
   * `systemNumeric` keeps rather than dressing a figure in a guess.
   */
  unit?: string;
  /**
   * How many lanes this column needs. Absent means one, which is every reading: a lane is sized
   * for a four-figure number and they all are.
   *
   * A position is not. Measured in the browser on the demo boat: the widest longitude cell asks
   * for 105px where a heading asks for 35, and both were handed the same lane, so the position
   * was drawn over the column beside it - by 13px on a phone, where the lane is 50px. Overflow
   * is not clipped in a row, so nothing that measured clipping saw it; the reader saw
   * "43°33.508007°01.241'".
   */
  lanes?: number;
}

/**
 * The hour a reading was taken, as the log prints it.
 *
 * Shared with the engineer's unit-major table, which stamps its rows the same way: a second
 * copy of this would be the two books disagreeing about what time it is.
 */
export function hhmm(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** The time column, which every row has by construction - a snapshot is a moment. */
const UTC: LogColumn = {
  key: "ts",
  head: "UTC",
  book: "bridge",
  cell: (s) => hhmm(s.ts),
};

/**
 * One half of a position, written the way the bridge board writes it: degrees and decimal
 * minutes, hemisphere last. Thousandths of a minute is roughly two metres, which is the same
 * resolution the board and the exports already print.
 */
function fmtPos(deg: number | null, width: number, pos: string, neg: string): string {
  if (deg === null) return "·";
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = (abs - d) * 60;
  return `${String(d).padStart(width, "0")}°${m.toFixed(3).padStart(6, "0")}' ${deg < 0 ? neg : pos}`;
}

/**
 * Every column the logbook can draw, in reading order, each paired with the question "did the
 * boat report this?". Heading accepts either source, as the row always has: a boat with a
 * magnetic compass and no true heading still has a heading column.
 */
function candidates(windUnit: WindUnit): { col: LogColumn; has: (s: Snapshot) => boolean }[] {
  return [
    // The position leads the readings the way it leads a written log line: the entry says
    // where she was before it says how she was doing.
    {
      col: {
        key: "lat",
        head: "LAT",
        book: "bridge",
        lanes: 2,
        cell: (s) => fmtPos(s.lat, 2, "N", "S"),
      },
      has: (s) => s.lat !== null,
    },
    {
      col: {
        key: "lon",
        head: "LON",
        book: "bridge",
        lanes: 2,
        cell: (s) => fmtPos(s.lon, 3, "E", "W"),
      },
      has: (s) => s.lon !== null,
    },
    {
      col: {
        key: "sog",
        head: "SOG",
        book: "bridge",
        unit: "kn",
        cell: (s) => fmtNum(sogKnFiltered(s.sog), 1),
      },
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
        // Beaufort is a scale, not a unit: its head already says which scale is in force.
        unit: windUnit === "kn" ? "kn" : undefined,
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
        unit: "hPa",
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
        unit: "°C",
        cell: (s) => fmtNum(kToC(s.air_temp_k), 1),
      },
      has: (s) => s.air_temp_k !== null,
    },
    {
      col: {
        key: "sea",
        head: "SEA",
        book: "bridge",
        unit: "°C",
        cell: (s) => fmtNum(kToC(s.water_temp_k), 1),
      },
      has: (s) => s.water_temp_k !== null,
    },
    {
      col: {
        key: "depth",
        head: "DEP",
        book: "bridge",
        unit: "m",
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
  // Not FUEL, which "Fuel per mile" would shorten to: the burn rate above already heads a
  // column that way, and two columns headed FUEL on one boat leave the reader guessing which
  // is the L/h and which the L/nm. The unit is the one name that states the direction.
  "Fuel per mile": "L/NM",
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
 * A reading's column head, spelled from the parameter's own name.
 *
 * Shared with the engineer's unit-major table, which heads the same readings: two copies of
 * this mapping would drift the first time a gauge was renamed in one of them.
 */
export function metricHead(sub: string): string {
  return METRIC_HEAD[sub] ?? sub.split(" ")[0]!.toUpperCase();
}

/**
 * The reading a path carries, as this book names it.
 *
 * A tank's level deliberately carries no sub on the gauge screen - the cell there says
 * "Fuel 0" over "72%", and "Fuel 0 / Current level" would name what the figure already
 * shows. A log column cannot lean on its figure that way: the head is all the reader has
 * before the rows, so the level gets its name back here. Any other sub-less path stays out
 * of the book, as it always has - a head would be a guess at what it is.
 */
export function logbookSub(d: SystemReading): string | null {
  if (d.sub !== null) return d.sub;
  return d.tab === "tanks" ? "Current level" : null;
}

/**
 * How a unit is headed: the initial of a side, the number of a numbered one.
 *
 * "Port" and "Starboard" share no initial with each other and none with "Center", so a letter
 * is enough on the boats that name their sides; a numbered engine keeps its number, which is
 * the only thing distinguishing it from the next one.
 */
function unitHead(label: string): string {
  const m = /^(Engine|Generator|Fuel|Fresh water|Black water|Grey water|Lubrication)\s+(\S+)$/.exec(label);
  // An initial per word, not one per family: "Fuel 0" and "Fresh water 0" sharing F0 is the
  // gearbox collision over again, two lanes with one name.
  if (m) return `${m[1]!.split(" ").map((w) => w[0]).join("")}${m[2]}`.toUpperCase();
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
  const described: { path: string; d: SystemReading & { sub: string } }[] = [];
  for (const path of paths) {
    const d = describePath(path);
    // A path no reading describes gets no column: a header would be a guess at what it is.
    if (!d) continue;
    const sub = logbookSub(d);
    if (sub === null) continue;
    described.push({ path, d: { ...d, sub } });
  }
  // The machine's initial exists to keep her apart from the next one, so a family of one
  // machine heads her columns with the reading alone: "FUEL", not "E FUEL" repeated down
  // the whole header for a boat with nothing to tell apart.
  const unitsByTab = new Map<string, Set<string>>();
  for (const { d } of described) {
    if (!unitsByTab.has(d.tab)) unitsByTab.set(d.tab, new Set());
    unitsByTab.get(d.tab)!.add(d.label);
  }
  const out: { col: LogColumn; has: (s: Snapshot) => boolean }[] = [];
  for (const { path, d } of described) {
    const metric = metricHead(d.sub);
    out.push({
      col: {
        key: `p:${path}`,
        head: unitsByTab.get(d.tab)!.size > 1 ? `${unitHead(d.label)} ${metric}` : metric,
        book: "engine",
        tab: d.tab,
        unit: unitFor(path),
        cell: (s) => {
          const v = s.path_values?.[path];
          if (typeof v !== "number") return "·";
          const n = systemNumeric(path, v).value;
          // A reading the table cannot make (an economy at rest) comes back NaN, meant for a
          // chart to drop; on a page it is the same gap as no reading.
          if (!Number.isFinite(n)) return "·";
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
