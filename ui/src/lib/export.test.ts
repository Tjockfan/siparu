import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackPoint, Voyage } from "../data/api";
import { exportFilename, printDocument, printName, snapshotsCsv, trackGpx, voyageTitle, voyagesCsv } from "./export";

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

  it("keeps that sort when a file has something to say about itself", () => {
    // After the date, not before it: a suffix in front of the stamp files every partial export
    // into a second heap of its own, away from the days it belongs beside.
    expect(exportFilename("logbook-bridge", Date.UTC(2026, 8, 1), "csv", "-partial")).toBe(
      "logbook-bridge-20260901-partial.csv",
    );
  });
});

describe("printName", () => {
  it("names the page the way the files are named, minus the extension the browser adds", () => {
    expect(printName("Siparu-Voyage", Date.UTC(2026, 8, 12))).toBe("Siparu-Voyage-20260912");
  });
});

describe("printDocument", () => {
  // These tests run without a DOM: the globals the function touches are stood in for, which
  // is also the whole of what it is allowed to touch. Two of those globals are the ways a
  // browser can say the dialog is over, and which one arrives is the difference between the
  // two browsers this function has to live with.
  const tab = { title: "" };
  const classes = new Set<string>();
  const head: { textContent: string }[] = [];
  const calls: { title: string; dark: boolean; sheets: number }[] = [];
  let afterprint: (() => void)[] = [];
  let touches: (() => void)[] = [];
  const stand = (print: () => void) => {
    vi.stubGlobal("document", {
      get title() { return tab.title; },
      set title(v: string) { tab.title = v; },
      documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
      createElement: () => {
        const el = { textContent: "", remove: () => { head.splice(head.indexOf(el), 1); } };
        return el;
      },
      head: { appendChild: (el: { textContent: string }) => head.push(el) },
      addEventListener: (type: string, fn: () => void) => { if (type === "pointerdown") touches.push(fn); },
      removeEventListener: (type: string, fn: () => void) => {
        if (type === "pointerdown") touches = touches.filter((f) => f !== fn);
      },
    });
    vi.stubGlobal("window", {
      print,
      addEventListener: (type: string, fn: () => void) => { if (type === "afterprint") afterprint.push(fn); },
      removeEventListener: (type: string, fn: () => void) => {
        if (type === "afterprint") afterprint = afterprint.filter((f) => f !== fn);
      },
    });
  };
  /** The browser firing afterprint. A blocking dialog does this before print() returns. */
  const fireAfterprint = () => afterprint.slice().forEach((f) => f());
  /** The reader touching the page again. */
  const touch = () => touches.slice().forEach((f) => f());
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0; classes.clear(); head.length = 0; afterprint = []; touches = [];
  });
  const seen = () => calls.push({ title: tab.title, dark: classes.has("pdf-screen"), sheets: head.length });

  it("prints under the given name", () => {
    tab.title = "Siparu: sign in";
    stand(seen);
    printDocument("Siparu-Logbook-20260912");
    expect(calls).toEqual([{ title: "Siparu-Logbook-20260912", dark: false, sheets: 0 }]);
  });

  it("dresses the dark page: the class and the sheet with no margin", () => {
    tab.title = "Siparu";
    stand(seen);
    printDocument("Siparu-Voyage-20260912", "screen");
    expect(calls).toEqual([{ title: "Siparu-Voyage-20260912", dark: true, sheets: 1 }]);
  });

  it("hands the page back at once to a browser that stopped at the dialog", () => {
    tab.title = "Siparu";
    stand(() => { seen(); fireAfterprint(); });
    printDocument("Siparu-Voyage-20260912", "screen");
    expect(tab.title).toBe("Siparu");
    expect(classes.has("pdf-screen")).toBe(false);
    expect(head).toHaveLength(0);
  });

  it("keeps the page dressed where print() returns with the dialog still up", () => {
    tab.title = "Siparu";
    stand(seen);
    printDocument("Siparu-Voyage-20260912", "screen");
    // WebKit is still deciding what to print. Undressing here is what printed the dark page
    // white and named the file after the tab.
    expect(tab.title).toBe("Siparu-Voyage-20260912");
    expect(classes.has("pdf-screen")).toBe(true);
    expect(head).toHaveLength(1);
    touch();
    expect(tab.title).toBe("Siparu");
    expect(classes.has("pdf-screen")).toBe(false);
    expect(head).toHaveLength(0);
  });

  it("ignores the afterprint WebKit fires while the dialog is still open", () => {
    tab.title = "Siparu";
    stand(seen);
    printDocument("Siparu-Voyage-20260912", "screen");
    // On an iPhone this arrived three times with the dialog up, once per relayout: changing
    // the paper orientation was one of them, and it used to take the dark page away mid-print.
    fireAfterprint();
    fireAfterprint();
    expect(tab.title).toBe("Siparu-Voyage-20260912");
    expect(classes.has("pdf-screen")).toBe(true);
  });

  it("puts the page back only once, however many times the reader touches it", () => {
    tab.title = "Siparu";
    stand(seen);
    printDocument("Siparu-Voyage-20260912", "screen");
    touch();
    tab.title = "Siparu: voyage";
    touch();
    expect(tab.title).toBe("Siparu: voyage");
  });

  it("hands everything back even when the dialog throws", () => {
    tab.title = "Siparu";
    stand(() => { throw new Error("no printer"); });
    expect(() => printDocument("Siparu-Voyage-20260912", "screen")).toThrow();
    expect(tab.title).toBe("Siparu");
    expect(classes.has("pdf-screen")).toBe(false);
    expect(head).toHaveLength(0);
  });
});
