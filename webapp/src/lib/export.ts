/**
 * The boat's own record, in formats that outlive this screen.
 *
 * A logbook nobody can get out of the app is not a logbook, and the data is the
 * owner's: voyages leave as CSV for a spreadsheet, a track leaves as GPX for a
 * chart plotter or OpenCPN. Both are built here, from the same objects the screen
 * already holds, so an export needs nothing from the boat that the page has not
 * already been given and adds no route to a REST surface that is read-only by
 * design.
 *
 * Times are written as ISO 8601 in UTC. The screen shows local time because that
 * is the watch a person keeps, but a file outlives the timezone it was made in,
 * and GPX has no other option.
 */
import type { Snapshot, TrackPoint, Voyage } from "./api";

/** What a row has to carry to be exported: a moment. The logbook's Snapshot is one. */
type LogRow = Snapshot;

/** What a column has to carry: a heading and a way to print one row. The logbook's LogColumn
 *  is one, and is not imported here - lib/ is below the routes and stays that way. */
interface ExportColumn {
  head: string;
  cell: (s: LogRow) => string;
}

/** RFC 4180: a field containing a comma, a quote or a newline is quoted, and its quotes doubled. */
function csvField(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Hours as a person reads a passage: "3h 12m", "47m". Empty for a voyage that has none. */
function durationHm(hours: number): string {
  if (!(hours > 0)) return "";
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const iso = (ts: number | null): string | null => (ts === null ? null : new Date(ts).toISOString());

const CSV_HEADER = [
  "id",
  "start_utc",
  "end_utc",
  "duration",
  "from",
  "to",
  "distance_nm",
  "hours_underway",
  "avg_sog_kn",
  "max_sog_kn",
  "fuel_used_l",
  "start_lat",
  "start_lon",
  "end_lat",
  "end_lon",
] as const;

/**
 * Every voyage given, oldest first, one row each.
 *
 * Oldest first because a spreadsheet is read downwards and a season reads
 * forwards; the screen lists newest first because a person opens it to see where
 * he has just been. Figures go out unrounded, as the boat integrated them: the
 * screen rounds at the point it prints, and a file that rounded too would lose
 * what someone exported it to work on.
 */
export function voyagesCsv(voyages: readonly Voyage[]): string {
  const rows = [...voyages].sort((a, b) => a.start_ts - b.start_ts);
  const lines = [CSV_HEADER.join(",")];
  for (const v of rows) {
    lines.push(
      [
        v.id,
        iso(v.start_ts),
        iso(v.end_ts),
        durationHm(v.hours_underway),
        v.start_port,
        v.end_port,
        v.distance_nm,
        v.hours_underway,
        v.avg_sog_kn,
        v.max_sog_kn,
        v.fuel_used_l,
        v.start_lat,
        v.start_lon,
        v.end_lat,
        v.end_lon,
      ]
        .map(csvField)
        .join(","),
    );
  }
  // Trailing newline: a file without one appends to the next thing that reads it.
  return lines.join("\r\n") + "\r\n";
}

/**
 * The rows on screen, as CSV, with the columns the reader has open.
 *
 * The table's own columns are what goes out, because the table's columns are the boat's: they
 * are earned by a reading being present (columns.ts), so a boat with no barometer exports no
 * barometer field rather than a column of blanks. The cells are printed the way the screen
 * prints them, which is the one thing about this file that is not obvious and is deliberate:
 * a logbook page is a record of what was read, and a reader who exports what he is looking at
 * and finds different numbers in it has been given a second document.
 *
 * The time column is the exception. On screen it is a clock face, "14:20", which is what a
 * person keeps a watch by and is useless in a file that outlives the day it was made: the
 * first field is the full moment in ISO 8601 UTC instead, as in every other export here.
 *
 * Oldest first, as the voyages go out, because a spreadsheet is read downwards.
 */
export function snapshotsCsv(
  snaps: readonly LogRow[],
  cols: readonly ExportColumn[],
): string {
  const data = cols.slice(1);
  const lines = [["utc", ...data.map((c) => c.head)].map(csvField).join(",")];
  for (const s of [...snaps].sort((a, b) => a.ts - b.ts)) {
    lines.push([iso(s.ts), ...data.map((c) => c.cell(s))].map(csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function xmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "26 Jul 2026 · Monaco to Saint-Tropez", or just the date when no port is known. */
export function voyageTitle(v: Voyage): string {
  const date = new Date(v.start_ts).toISOString().slice(0, 10);
  if (!v.start_port && !v.end_port) return `Voyage ${v.id} ${date}`;
  return `${date} ${v.start_port ?? "?"} to ${v.end_port ?? "?"}`;
}

/**
 * One voyage's track as GPX 1.1, which is what a chart plotter reads.
 *
 * A single segment, and no speed on the points: GPX has no element for it, every
 * vendor extension for it is a different vendor's, and a reader that wants speed
 * derives it from the fixes and the timestamps that are here. Points the boat
 * recorded without a fix never reach this function; the track endpoint drops them.
 */
export function trackGpx(v: Voyage, track: readonly TrackPoint[]): string {
  const name = xmlText(voyageTitle(v));
  const pts = track
    .map(
      (p) =>
        `   <trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.ts).toISOString()}</time></trkpt>`,
    )
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Siparu" xmlns="http://www.topografix.com/GPX/1/1">',
    " <metadata>",
    `  <name>${name}</name>`,
    `  <time>${new Date(v.start_ts).toISOString()}</time>`,
    " </metadata>",
    " <trk>",
    `  <name>${name}</name>`,
    "  <trkseg>",
    pts,
    "  </trkseg>",
    " </trk>",
    "</gpx>",
    "",
  ].join("\n");
}

/**
 * Hand a built file to the browser. The only thing in this module that touches the
 * DOM, kept apart from the builders above so those stay testable as text in, text
 * out.
 *
 * A blob and an anchor, because the file is made here and there is nothing on the
 * boat to fetch it from: the plugin's REST surface is read-only and this adds
 * nothing to it. The object URL is revoked on the next frame rather than
 * immediately - Safari reads the blob after the click returns, and revoking in the
 * same tick gives an empty file.
 */
export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A filename that sorts by date and survives every filesystem. */
export function exportFilename(prefix: string, ts: number, ext: string): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.${ext}`;
}
