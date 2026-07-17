/**
 * Unit/format helpers for the Logbook UI.
 *
 * The gauge physics is not here. It is in the plugin that serves this app (`units.ts`), and so
 * is anything the shore also reads: a knot is the same length ashore, and a force 6 has to be a
 * force 6 on both screens or neither is worth looking at. What is left below is this screen's
 * own presentation.
 */
import { beaufortFromKn, MS_TO_KN, SOG_VALID_KN } from "../../../plugin/src/units";

export { SOG_VALID_KN };

export const formatTs = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const formatTimeShort = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const radToDeg = (r: number | null | undefined) =>
  r === null || r === undefined ? null : ((r * 180) / Math.PI + 360) % 360;

export const msToKnots = (v: number | null | undefined) =>
  v === null || v === undefined ? null : v * MS_TO_KN;

/** SignalK SOG (m/s) → knots; null when < SOG_VALID_KN. */
export const sogKnFiltered = (sog_ms: number | null | undefined): number | null => {
  // GPS anchor swing (<threshold) is rounded to zero but SHOWN AS ZERO;
  // null only when data is genuinely absent. An empty "·" on the primary card breaks the hierarchy.
  const kn = msToKnots(sog_ms);
  if (kn === null) return null;
  return kn >= SOG_VALID_KN ? kn : 0;
};

export const kToC = (k: number | null | undefined) =>
  k === null || k === undefined ? null : k - 273.15;

export const paToHPa = (p: number | null | undefined) =>
  p === null || p === undefined ? null : p / 100;

export const fmtNum = (v: number | null | undefined, digits = 1, suffix = "") =>
  v === null || v === undefined ? "·" : `${v.toFixed(digits)}${suffix}`;

/** Decimal degree → "DD° MM.MMM' H" (mariner/Simrad standard). */
const toDM = (dec: number, padDeg: number, hemi: [string, string]) => {
  const sign = dec < 0 ? hemi[1] : hemi[0];
  const abs = Math.abs(dec);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${String(deg).padStart(padDeg, "0")}° ${min.toFixed(3).padStart(6, "0")}' ${sign}`;
};

export const fmtLatLon = (lat: number | null, lon: number | null) => {
  if (lat === null || lon === null) return "·";
  return `${toDM(lat, 2, ["N", "S"])}  ${toDM(lon, 3, ["E", "W"])}`;
};

const CARDINAL_16 = [
  "N", "NNE", "NE", "ENE",
  "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW",
  "W", "WNW", "NW", "NNW",
];

/** Degrees (0–360) → 16-point compass abbreviation (N, NNE, NE, ENE, E, ...). */
export const degToCardinal = (deg: number | null | undefined): string | null => {
  if (deg === null || deg === undefined || Number.isNaN(deg)) return null;
  const norm = ((deg % 360) + 360) % 360;
  const idx = Math.round(norm / 22.5) % 16;
  return CARDINAL_16[idx];
};

/** Radians → cardinal. Handy for SK fields like directionTrue. */
export const radToCardinal = (rad: number | null | undefined): string | null => {
  const d = radToDeg(rad);
  return d === null ? null : degToCardinal(d);
};

/**
 * Magnetic variation/deviation (radians) → deck-log display: "|deg|.d°E/W".
 * SignalK sign convention: east = positive. null/invalid → "" (filled in by hand in the log).
 * Since radToDeg returns 0–360, west (negative) values exceed 180; here we
 * use the raw radian sign.
 */
export const fmtVariation = (rad: number | null | undefined): string => {
  if (rad === null || rad === undefined || Number.isNaN(rad)) return "";
  const deg = (rad * 180) / Math.PI;
  const hemi = deg >= 0 ? "E" : "W";
  return `${Math.abs(deg).toFixed(1)}°${hemi}`;
};

/**
 * SignalK unit -> "human" unit conversion (for the Logbook+ table).
 * Returns: { value, units, digits } - a displayable form (deg/knot/°C/hPa)
 * to show in place of the original value/units.
 */
export type Converted = { value: number | string | boolean | null; units: string | null; digits: number };

export function convertByUnit(
  value: number | string | boolean | null,
  units: string | null | undefined,
): Converted {
  if (value === null || value === undefined || typeof value !== "number" || !units) {
    return { value, units: units ?? null, digits: 2 };
  }
  switch (units) {
    case "rad":
      return { value: ((value * 180) / Math.PI + 360) % 360, units: "°", digits: 1 };
    case "rad/s":
      return { value: (value * 180) / Math.PI, units: "°/s", digits: 2 };
    case "m/s":
      return { value: value * 1.94384, units: "kn", digits: 2 };
    case "K":
      return { value: value - 273.15, units: "°C", digits: 1 };
    case "Pa":
      return { value: value / 100, units: "hPa", digits: 1 };
    case "ratio":
      return { value: value * 100, units: "%", digits: 1 };
    case "Hz":
      // engine revolutions are usually Hz; 1 Hz = 60 RPM
      return { value: value * 60, units: "RPM", digits: 0 };
    case "m":
      return { value, units: "m", digits: 2 };
    case "m3":
      return { value: value * 1000, units: "L", digits: 1 };
    case "m3/s":
      return { value: value * 3600 * 1000, units: "L/h", digits: 2 };
    case "s":
      return { value, units: "s", digits: 0 };
    default:
      return { value, units, digits: 2 };
  }
}

/** Stringify a numeric value to the given digits. Other types are stringified. */
export const fmtValue = (v: unknown, digits = 2): string => {
  if (v === null || v === undefined) return "·";
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) < 1e9) return String(v);
    if (Math.abs(v) >= 10000) return v.toFixed(0);
    return v.toFixed(digits);
  }
  return String(v);
};

/**
 * Knots to Beaufort. The scale itself is in the plugin, so the boat and the shore cannot come
 * to disagree about what a gale is: this is the same function under the name this screen calls it.
 */
export const knotToBeaufort = beaufortFromKn;

/** DM for a single position coordinate. */
export const fmtCoordDM = (
  dec: number | null,
  hemi: ["N", "S"] | ["E", "W"],
  padDeg: number,
): string => {
  if (dec === null || dec === undefined || Number.isNaN(dec)) return "·";
  const sign = dec < 0 ? hemi[1] : hemi[0];
  const abs = Math.abs(dec);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${String(deg).padStart(padDeg, "0")}°${min.toFixed(3).padStart(6, "0")}' ${sign}`;
};

/** Start of today (local time), unix ms. */
export const startOfLocalDay = (d: Date = new Date()): number => {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
};

/**
 * Date input "YYYY-MM-DD" → start of that UTC day, ms.
 *
 * UTC, not local, because a logbook day is a UTC day: the plugin stamps rows in epoch
 * ms and /snapshots windows on startOfUtcDay, so a local midnight would ask for a
 * window the boat never recorded against and drag rows into the neighbouring day.
 * It also makes every day exactly 24h, which is what the caller's dayStart + 24h
 * assumes - on a local clock the two DST days are 23 and 25 hours long.
 */
export const dateInputToMs = (s: string): number => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0);
};

/** Date → "YYYY-MM-DD" (UTC), the day the logbook files that instant under. */
export const dateToInput = (d: Date = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
