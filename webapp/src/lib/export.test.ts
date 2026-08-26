import { describe, expect, it } from "vitest";
import type { TrackPoint, Voyage } from "./api";
import { exportFilename, snapshotsCsv, trackGpx, voyageTitle, voyagesCsv } from "./export";

const voyage = (over: Partial<Voyage> = {}): Voyage => ({
  id: 7,
  start_ts: Date.UTC(2026, 6, 24, 8, 21),
  end_ts: Date.UTC(2026, 6, 24, 10, 35),
  start_lat: 58.396,
  start_lon: 8.721,
  end_lat: 58.2005,
  end_lon: 8.2564,
  distance_nm: 15.703,
  hours_underway: 2.164,
  avg_sog_kn: 7.26,
  max_sog_kn: 12.1,
  fuel_used_l: 41.62,
  start_port: "Grimstad",
  end_port: "Lillesand",
  status: "closed",
  ...over,
});

describe("voyagesCsv", () => {
  it("writes one row per voyage, oldest first, with the figures unrounded", () => {
    // The screen lists newest first because a person opens it to see where he has
    // just been; a spreadsheet is read downwards, so a season reads forwards here.
    const csv = voyagesCsv([
      voyage({ id: 2, start_ts: Date.UTC(2026, 6, 24, 8, 0) }),
      voyage({ id: 1, start_ts: Date.UTC(2026, 6, 22, 8, 0) }),
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "id,start_utc,end_utc,duration,from,to,distance_nm,hours_underway,avg_sog_kn,max_sog_kn,fuel_used_l,start_lat,start_lon,end_lat,end_lon",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith("1,")).toBe(true);
    expect(lines[2]!.startsWith("2,")).toBe(true);
    // Not "15.7": an export is what somebody opened a spreadsheet to work on.
    expect(lines[1]).toContain("15.703");
    expect(lines[1]).toContain("2026-07-22T08:00:00.000Z");
  });

  it("leaves an unknown figure empty rather than writing a zero into it", () => {
    // A voyage under way has no end, and a boat with no engine reports no fuel.
    // A zero in either column is a reading somebody would add up.
    const csv = voyagesCsv([
      voyage({ end_ts: null, end_port: null, end_lat: null, end_lon: null, fuel_used_l: null, max_sog_kn: null }),
    ]);
    const row = csv.trimEnd().split("\r\n")[1]!.split(",");
    expect(row[2]).toBe(""); // end_utc
    expect(row[5]).toBe(""); // to
    expect(row[9]).toBe(""); // max_sog_kn
    expect(row[10]).toBe(""); // fuel_used_l
  });

  it("quotes a port whose name contains a comma, so the row keeps its columns", () => {
    // "Cannes, Vieux Port" unquoted shifts every figure after it one column left,
    // which a spreadsheet opens without complaining.
    const csv = voyagesCsv([voyage({ start_port: 'Cannes, Vieux Port', end_port: 'The "Old" Basin' })]);
    const row = csv.trimEnd().split("\r\n")[1]!;
    expect(row).toContain('"Cannes, Vieux Port"');
    expect(row).toContain('"The ""Old"" Basin"');
    // 15 columns, whatever is in them.
    expect(row.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g)).toHaveLength(14);
  });

  it("reads a duration the way a person says one", () => {
    expect(voyagesCsv([voyage({ hours_underway: 2.164 })])).toContain("2h 10m");
    expect(voyagesCsv([voyage({ hours_underway: 0.883 })])).toContain("53m");
    // A voyage that has only just opened has no duration to state.
    const row = voyagesCsv([voyage({ hours_underway: 0 })]).trimEnd().split("\r\n")[1]!;
    expect(row.split(",")[3]).toBe("");
  });

  it("ends the file with a newline", () => {
    expect(voyagesCsv([voyage()]).endsWith("\r\n")).toBe(true);
  });
});

describe("snapshotsCsv", () => {
  // What the logbook hands over: rows that are moments, and columns that print one.
  const snap = (ts: number, sog: string) => ({ ts, sog }) as never;
  const cols = [
    { head: "UTC", cell: () => "never used" },
    { head: "SOG", cell: (s: { sog: string }) => s.sog },
    { head: "AWA", cell: () => "32°S" },
  ] as never[];

  it("writes the moment in full and the cells as the screen prints them", () => {
    const csv = snapshotsCsv(
      [snap(Date.UTC(2026, 6, 24, 10, 35), "6.3"), snap(Date.UTC(2026, 6, 24, 8, 21), "5.8")],
      cols,
    );
    const lines = csv.trimEnd().split("\r\n");
    // The time column's own cell is a clock face and is dropped: a file outlives the day.
    expect(lines[0]).toBe("utc,SOG,AWA");
    // Oldest first, as the voyages go out, because a spreadsheet is read downwards.
    expect(lines[1]).toBe("2026-07-24T08:21:00.000Z,5.8,32°S");
    expect(lines[2]).toBe("2026-07-24T10:35:00.000Z,6.3,32°S");
  });

  it("carries the columns the reader has open, and only those", () => {
    // The set is the boat's and the reader's between them: a column she never earned is not
    // in `cols` at all, and one he turned off was taken out before this was called.
    const csv = snapshotsCsv([snap(Date.UTC(2026, 6, 24, 8, 21), "5.8")], cols.slice(0, 2));
    expect(csv.trimEnd().split("\r\n")[0]).toBe("utc,SOG");
    expect(csv).not.toContain("AWA");
  });

  it("quotes a cell that would otherwise start a new field", () => {
    // Nothing on the bridge prints a comma today. The rule is here because the columns are
    // built from what a boat sends, and the day one does the file must not silently shift.
    const csv = snapshotsCsv([snap(Date.UTC(2026, 6, 24, 8, 21), "5.8")], [
      { head: "UTC", cell: () => "" },
      { head: "NOTE", cell: () => 'gust 24, veering' },
    ] as never[]);
    expect(csv.trimEnd().split("\r\n")[1]).toBe('2026-07-24T08:21:00.000Z,"gust 24, veering"');
  });

  it("writes a header and nothing else when the page is empty", () => {
    // The button is disabled in this state; the function still has to be honest about it.
    expect(snapshotsCsv([], cols)).toBe("utc,SOG,AWA\r\n");
  });
});

describe("trackGpx", () => {
  const track: TrackPoint[] = [
    { ts: Date.UTC(2026, 6, 24, 8, 21), lat: 58.396, lon: 8.721, sog: 6.2 },
    { ts: Date.UTC(2026, 6, 24, 8, 22), lat: 58.3951, lon: 8.7233, sog: 6.4 },
  ];

  it("writes a plotter-readable track: one segment, every fix with its time", () => {
    const gpx = trackGpx(voyage(), track);
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(gpx).toContain('<gpx version="1.1" creator="Siparu"');
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(gpx.match(/<trkseg>/g)).toHaveLength(1);
    expect(gpx.match(/<trkpt /g)).toHaveLength(2);
    expect(gpx).toContain('<trkpt lat="58.396" lon="8.721"><time>2026-07-24T08:21:00.000Z</time></trkpt>');
  });

  it("escapes a port name that would otherwise break the document", () => {
    // A plotter that cannot parse the file says nothing useful about why.
    const gpx = trackGpx(voyage({ start_port: "Fish & Chips <Marina>" }), track);
    expect(gpx).toContain("Fish &amp; Chips &lt;Marina&gt;");
    expect(gpx).not.toContain("<Marina>");
  });

  it("names a voyage by its ports, and by its number when the boat knows none", () => {
    expect(voyageTitle(voyage())).toBe("2026-07-24 Grimstad to Lillesand");
    expect(voyageTitle(voyage({ start_port: null, end_port: null }))).toBe("Voyage 7 2026-07-24");
    // Under way: the arrival is not known yet and is not guessed at.
    expect(voyageTitle(voyage({ end_port: null }))).toBe("2026-07-24 Grimstad to ?");
  });

  it("writes an empty segment rather than a broken document for a track with no fixes", () => {
    const gpx = trackGpx(voyage(), []);
    expect(gpx).toContain("<trkseg>");
    expect(gpx).toContain("</trkseg>");
    expect(gpx).not.toContain("<trkpt");
  });
});

describe("exportFilename", () => {
  it("sorts by date in a directory listing", () => {
    expect(exportFilename("siparu-voyages", Date.UTC(2026, 6, 4), "csv")).toBe(
      "siparu-voyages-20260704.csv",
    );
  });
});
