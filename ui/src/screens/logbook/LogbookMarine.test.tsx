/**
 * That the screen actually asks.
 *
 * columns.test.ts pins the derivation, and a derivation nothing calls is the defect this repo
 * already carries once: the depth micro-diagnosis is a tested pure function that no cell can
 * ever render. So this renders the real screen over a stubbed data hook and reads the markup.
 *
 * The stub stands in for the network, not for the logic under test - the column set, the
 * header, the row cells and the grid width all come from the component.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "../../data/api";
import { DayLine, Rows, columnsCount, pageIsLined, summaryNote, tableShape, windowInterval, withClosingReadings } from "./LogbookMarine";
import { columnsFor, logbookColumns } from "./columns";
import { unitGroups } from "./unitRows";
import { ALL_ON } from "./columnSelection";
import type { UnitGroup } from "./unitRows";
import { shipTimes, type ZoneLookup } from "../../lib/shipTime";

const page: Snapshot[] = [];

// The hooks are replaced; everything else in that module is kept. A mock that listed the
// module's constants by hand held a second copy of each one, and the copy went stale the day
// the screen started reading a new one: the suite failed on a missing export rather than on
// anything about the table. What this file is here to stand in for is the fetching, and that
// is all it stands in for.
vi.mock("./useLogbookData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useLogbookData")>()),
  useLogbookLive: () => ({
    snaps: page,
    err: null,
    busy: false,
    hasMore: false,
    loadMore: () => {},
  }),
  useLogbookDay: () => ({
    dateStr: "2026-08-21",
    setDateStr: () => {},
    isToday: true,
    snaps: page,
    err: null,
    busy: false,
    prevDay: () => {},
    nextDay: () => {},
    goToday: () => {},
  }),
  useLogbookRange: () => ({ snaps: page, err: null, busy: false, truncated: false, loaded: true }),
}));

// The zone table is a lazy chunk and a static render runs no effects, so on its own this suite
// would only ever see the page as it stands before the table arrives: in UTC. The stand-in is
// for the loading and nothing else - the clock, the head and the lines are the real ones, read
// off the rows the screen hands over. Null is that cold page, and is what every test above the
// ship's-clock block runs on.
const zoneTable = vi.hoisted(() => ({ current: null as ZoneLookup | null }));
vi.mock("../../data/useShipTimes", async () => {
  const { shipTimes } = await import("../../lib/shipTime");
  return {
    useShipTimes: (rows: Parameters<typeof shipTimes>[0]) => shipTimes(rows, zoneTable.current),
  };
});

// The screen remembers the wind unit. There is no DOM in this suite, so the store is a map.
beforeAll(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  });
});

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    ts: 1_770_000_000_000,
    lat: null, lon: null, sog: null, cog: null,
    heading_mag: null, heading_true: null, rate_of_turn: null,
    magnetic_variation: null, magnetic_deviation: null, nav_state: null,
    wind_speed_apparent: null, wind_angle_apparent: null, wind_speed_true: null,
    wind_gust: null, wind_direction_true: null, air_temp_k: null,
    air_pressure_pa: null, depth: null, water_temp_k: null,
    gps_satellites: null, ais_class: null,
    ...over,
  } as Snapshot;
}

async function draw(rows: Snapshot[], book: "bridge" | "engine" = "bridge"): Promise<string> {
  page.length = 0;
  page.push(...rows);
  const { default: LogbookMarine } = await import("./LogbookMarine");
  return renderToStaticMarkup(<LogbookMarine book={book} />);
}

describe("the logbook table over a boat's own instruments", () => {
  it("draws the barometer column for a boat that carries one", async () => {
    const html = await draw([snap({ sog: 4.1, heading_true: 1.9, wind_speed_true: 6.4, air_pressure_pa: 101_300, depth: 18.2 })]);
    expect(html).toContain("BARO");
    expect(html).toContain("1013");
  });

  /**
   * The failure that was on screen: a sailing yacht with no barometer got a BARO heading and a
   * dot under it in every row, for as long as the boat existed.
   */
  it("draws no barometer column, and no dot for one, on a boat without a barometer", async () => {
    const html = await draw([
      snap({ sog: 3.2, heading_true: 1.1, wind_speed_true: 8.0, depth: 12.0 }),
      snap({ sog: 3.4, heading_true: 1.2, wind_speed_true: 7.6, depth: 11.4 }),
    ]);
    expect(html).not.toContain("BARO");
    expect(html).toContain("TWS");
    expect(html).toContain("DEP");
    // Five tracks were being laid out for four readings; the width is the boat's now.
    expect(html).toContain("--lb-cols:4");
  });

  it("comes down to a time and a speed on a boat carrying only a GPS", async () => {
    const html = await draw([snap({ sog: 2.4 }), snap({ sog: 2.6 })]);
    for (const head of ["HDG", "TWS", "BFT", "BARO", "DEP"]) expect(html).not.toContain(head);
    expect(html).toContain("UTC");
    expect(html).toContain("--lb-cols:1");
  });

  /**
   * An empty live page used to be a header over nothing at all - no way to tell a boat that
   * logged nothing from a request that failed. The day view has always said it; the live view
   * did not, and the live view is the one a reader opens first.
   */
  it("says why the page is empty instead of showing a header over nothing", async () => {
    const html = await draw([]);
    expect(html).toContain("No snapshots");
    expect(html).toMatch(/Nothing was logged in this window/i);
  });

  /**
   * What a printed page says it is holding.
   *
   * The range view can draw any of the boat's four figures now, and nothing in the numbers
   * tells a reader which one he is looking at: a column of hourly means and a column of hourly
   * readings are both just numbers. The word is the only thing that separates them, so it goes
   * wherever the interval goes - the band over the rows and the masthead that goes to paper.
   */
  it("names the figure a page carries, and leaves the plain reading unnamed", () => {
    expect(windowInterval("1h", "last")).toBe("Hourly");
    expect(windowInterval("1h", "avg")).toBe("Hourly · Average");
    expect(windowInterval("6h", "min")).toBe("Six-hourly · Minimum");
    expect(windowInterval("1d", "max")).toBe("Daily · Maximum");
  });

  /**
   * The three sentences the count can be, and the one that was wrong.
   *
   * Pinned apart from the screen because the screen cannot show the difference: an empty window
   * and a reader who has never chosen anything both render "0", and only the second is honest.
   * What separates them is the standing count carried in from the window before this one.
   */
  it("names the reader's own count when the window has none of its own", () => {
    // The whole selection is drawn: the plain figure, which is what it has always been.
    expect(columnsCount(9, 9, 9, 9)).toBe("9");
    // Too narrow for all of them - the screen saying so out loud.
    expect(columnsCount(5, 9, 9, 9)).toBe("5 of 9");
    // An empty day. The window offers nothing; the reader still keeps nine.
    expect(columnsCount(0, 0, 9, 0)).toBe("9");
    // And on a page that has never had a row, there is nothing to claim.
    expect(columnsCount(0, 0, 0, 0)).toBe("0");
    // A window with rows and a reader who turned every column off: an honest zero, not the
    // nine he had before he did it.
    expect(columnsCount(0, 0, 9, 8)).toBe("0");
  });

  /**
   * The disabled button was for a window with nothing to offer. A reader who pressed None and
   * applied it got the same button: nothing drawn, so nothing chosen, so the one control that
   * reopens the picker went dead, and the choice was saved, so a reload brought the dead button
   * back. The window still has columns to offer; only the selection is empty, and the button
   * has to stay live for exactly that reader.
   */
  it("keeps the picker reachable for a reader who turned every column off", async () => {
    try {
      localStorage.setItem("lb:columns:bridge", JSON.stringify({ off: ["sog", "depth"] }));
      const html = await draw([snap({ sog: 1.0, depth: 4.2 })]);
      const [btn] = /<button[^>]*class="lb-colbtn[^"]*"[^>]*>.*?<\/button>/s.exec(html) as RegExpExecArray;
      expect(btn).not.toContain("disabled");
      expect(btn).not.toContain("quiet");
      expect(btn).toContain("<b>0</b>");
    } finally {
      localStorage.setItem("lb:columns:bridge", JSON.stringify({ off: [] }));
    }
  });

  /**
   * And the bar above it does not contradict that sentence.
   *
   * A window's columns come out of its rows, so an empty one has none to draw and none to
   * offer, and the button that opens the picker read a bare "0" in the accent this screen
   * keeps for figures worth reading - over a picker that opened with nothing in it. Between
   * them they told a reader his column selection had gone, when what had happened was that a
   * day had turned over and the closed hour was not rolled up yet. The body says why the page
   * is empty; the button has to stop saying something else.
   */
  it("does not tell a reader his columns are gone when the window is merely empty", async () => {
    const html = await draw([]);
    const button = /<button[^>]*class="lb-colbtn[^"]*"[^>]*>.*?<\/button>/s.exec(html);
    expect(button, "the columns button is on the page").not.toBeNull();
    const [btn] = button as RegExpExecArray;
    // Nothing behind it to choose from, so it does not open.
    expect(btn).toContain("disabled");
    // And the figure is not dressed as one that wants reading.
    expect(btn).toContain("quiet");
  });

  /**
   * The page is one book, and the wiring is what decides which. The column model has told the
   * two apart since it was written and the screen showed them together anyway, so the thing
   * worth pinning here is not the split but that this screen performs it: the engineer's page
   * draws his gauges and none of the officer's, over the very same rows.
   */
  it("draws the engineer's book on his page, and none of the officer's", async () => {
    // Revolutions come off the wire in hertz, as Signal K sends them: 25.5 Hz is 1530 rpm.
    const rows = [
      snap({ sog: 4.1, depth: 18.2, path_values: { "propulsion.port.revolutions": 25.5 } }),
      snap({ sog: 4.2, depth: 18.0, path_values: { "propulsion.port.revolutions": 26 } }),
    ];
    const bridge = await draw(rows, "bridge");
    expect(bridge).toContain("SOG");
    expect(bridge).toContain("DEP");
    expect(bridge).not.toContain("RPM");

    // A lone engine's column is headed by the reading alone: there is no second machine for
    // an initial to tell her apart from.
    const engine = await draw(rows, "engine");
    expect(engine).toContain("RPM");
    expect(engine).toContain("1530");
    expect(engine).not.toContain("SOG");
    expect(engine).not.toContain("DEP");
    // The hour belongs to both: an engineer's page of bare numbers is not a log.
    expect(engine).toContain("UTC");
  });

  /**
   * The shape of the engineer's page is the boat's, and the boat decides it by how many
   * machines she has. One engine is twelve columns and fits; three are thirty-six and do not,
   * so the machines come down the side and the readings go across - the table the reading is
   * actually taken from, and the only arrangement where port sits above starboard.
   */
  it("turns the engineer's table on its side when the boat has more than one engine", async () => {
    const three = (rpm: number) => ({
      "propulsion.port.revolutions": rpm,
      "propulsion.center.revolutions": rpm + 1,
      "propulsion.starboard.revolutions": rpm + 2,
    });
    const html = await draw([snap({ path_values: three(25) })], "engine");
    // A lane apiece would head these "P RPM", "C RPM", "S RPM". As rows the reading is headed
    // once and the machines are named down the side.
    expect(html).not.toContain("P RPM");
    expect(html).toContain("PORT");
    expect(html).toContain("STARBOARD");
    expect(html).toContain("1500");
    expect(html).toContain("1620");
    // The hour is written once over the machines, not repeated on each of their lines.
    expect(html.match(/class="tm"/g)).toHaveLength(3);
    expect(html.match(/lb-row u cont/g)).toHaveLength(2);
  });

  /**
   * The engineer chooses his readings the way the officer chooses his columns.
   *
   * The unit-major table used to hide the picker on the claim that there was nothing to pick;
   * twelve gauges across a family of three said otherwise. The refusal is stored per family -
   * RPM is a word the engines and the generators both use, and striking it off one page says
   * nothing about the other.
   */
  it("lets the engineer strike a reading off his table", async () => {
    const { describePath } = await import("../../../../plugin/src/units");
    const sub = describePath("propulsion.port.revolutions")!.sub!;
    const paths = {
      "propulsion.port.revolutions": 25,
      "propulsion.port.oilPressure": 400_000,
      "propulsion.starboard.revolutions": 26,
      "propulsion.starboard.oilPressure": 400_001,
    };
    try {
      localStorage.setItem("lb:columns:engine", JSON.stringify({ off: [`u:engine:${sub}`] }));
      const html = await draw([snap({ path_values: paths })], "engine");
      expect(html).toContain("Columns");
      expect(html).not.toContain("RPM");
      expect(html).toContain("OIL");
    } finally {
      localStorage.setItem("lb:columns:engine", JSON.stringify({ off: [] }));
    }
  });

  /**
   * The tabs divide the table, not just the one that is turned on its side.
   *
   * A single-engine boat with two generators draws her engine as columns, because one machine
   * has no width to save. The generators are a different family with different readings, and a
   * page showing both at once heads a column for a gauge half its lines cannot have.
   */
  it("shows one family at a time even when the table is drawn a column per reading", async () => {
    const html = await draw(
      [
        snap({
          path_values: {
            "propulsion.port.revolutions": 25,
            "propulsion.port.oilPressure": 400_000,
            "electrical.generators.0.voltage": 230,
            "electrical.generators.1.voltage": 229,
          },
        }),
      ],
      "engine",
    );
    expect(html).toContain("RPM");
    expect(html).toContain("OIL");
    // The generators have their own tab, and their readings wait behind it.
    expect(html).not.toContain("VOLT");
    expect(html).toContain("GENERATORS");
  });

  /**
   * A position is two lanes wide, and the screen has to spend them: the head and every row
   * carry the span, and the grid variable counts lanes rather than columns. Pinned on the
   * rendered markup because fitColumns.test pins the arithmetic and measures.test pins the CSS,
   * and the wiring between them was the one leg nothing held - a phone overprinting the
   * longitude with the latitude was exactly that leg missing.
   *
   * The unit over a column is the same kind of leg: the column model carries it, the stylesheet
   * styles it, and only the screen can be caught not drawing it.
   */
  it("spends both lanes of a position on screen, and names a unit once over its column", async () => {
    const html = await draw([snap({ lat: 43.55, lon: 7.02, sog: 4.1, air_pressure_pa: 101_300 })]);
    // Two heads span two lanes, and the one row's two cells under them.
    expect(html.match(/class="w2"/g)).toHaveLength(2);
    expect(html.match(/class="v w2"/g)).toHaveLength(2);
    // Lanes, not columns: LAT 2 + LON 2 + SOG 1 + BARO 1.
    expect(html).toContain("--lb-cols:6");
    expect(html).toContain('<b class="lb-u">hPa</b>');
    expect(html).toContain('<b class="lb-u">kn</b>');
  });

  /**
   * The room an empty beat keeps is what the last full table drew, in lanes.
   *
   * The hold was written when a column was a lane; the position made a column two, and the hold
   * went on counting columns. Every Live to Day swap then dressed its empty beat two lanes
   * narrower than the table that had just left, and snapped back when the rows landed - the one
   * stretch the hold exists to remove.
   */
  it("holds the lanes a position took across an empty beat, not the columns", () => {
    const hold = { current: null as number | null };
    const familyHold = { current: [] as UnitGroup[] };
    const chosenHold = { current: 0 };
    const full = tableShape(
      [snap({ lat: 43.55, lon: 7.02, sog: 4.1 })],
      "bridge", "kn", ALL_ON, 390, null, hold, familyHold, chosenHold,
    );
    expect(full.block).toEqual({ "--lb-cols": 5 });
    const empty = tableShape([], "bridge", "kn", ALL_ON, 390, null, hold, familyHold, chosenHold);
    expect(empty.block).toEqual({ "--lb-cols": 5 });
  });

  /**
   * The band naming the window stands over the heads, and the heads stand over the rows.
   *
   * Printed the other way round, the names of the columns sat two bands above the figures they
   * named, with the window and the day written in between; a reader ran his eye up past a date
   * to find out what a column was.
   */
  it("puts the window's band over the heads, and the heads next to the rows", async () => {
    const html = await draw([snap({ sog: 4.1 })]);
    const band = html.indexOf('class="lb-day"');
    const heads = html.indexOf('class="lb-cols"');
    const rows = html.indexOf('class="lb-rows"');
    expect(band).toBeGreaterThan(-1);
    expect(band).toBeLessThan(heads);
    expect(heads).toBeLessThan(rows);
  });

  /**
   * Paper repeats no head row, so the line where the day turns carries the names again: the
   * date first, then a head per lane in the table's own order, a position keeping its two.
   * The engineer's table leads with the machine's lane as well, and that lane is headed by
   * nothing here the way it is headed by nothing in the rows.
   */
  it("writes the heads again on the day line, one per lane", () => {
    const cols = columnsFor(logbookColumns([snap({ lat: 43.5, lon: 7.0, sog: 4.1, depth: 8 })], "kn"), "bridge");
    const html = renderToStaticMarkup(<DayLine day="SUN · 23 AUG 2026" cols={cols} group={null} />);
    expect(html).toContain('<span class="sd">SUN · 23 AUG 2026</span>');
    expect(html.match(/<span class="sh( w2)?">[A-Z]+<b/g)?.map((m) => m.replace(/<[^>]+>|<b$/g, "")))
      .toEqual(["LAT", "LON", "SOG", "DEP"]);
    expect(html.match(/class="sh w2"/g)).toHaveLength(2);
    // The unit rides with the name: on paper this line is the only head the table has.
    expect(html).toContain('SOG<b class="lb-u">kn</b>');
    expect(html).toContain('DEP<b class="lb-u">m</b>');

    const [eng] = unitGroups([snap({ path_values: { "propulsion.port.revolutions": 25, "propulsion.starboard.revolutions": 26 } })]);
    const unit = renderToStaticMarkup(<DayLine day="MON · 24 AUG 2026" cols={[]} group={eng!} />);
    expect(unit).toContain('class="lb-sep u"');
    expect(unit).toContain('<span class="sh"></span><span class="sh">RPM<b class="lb-u">rpm</b></span>');
  });

  /**
   * An average page keeps the heading columns, carrying the reading the window closed on.
   *
   * They used to leave the table, and the table changed shape with the figure: thirteen lanes
   * under Last, ten under Average. Only a hole is filled - a mean the window has is never
   * overwritten by a reading - and a machine's paths are filled the same way.
   */
  it("fills what the figure cannot carry from the closing reading, and nothing else", () => {
    const avg = [snap({ ts: 1, sog: 5.0, heading_true: null, cog: null, path_values: { "propulsion.port.revolutions": 24 } })];
    const plain = [snap({ ts: 1, sog: 5.9, heading_true: 2.0, cog: 2.1, path_values: { "propulsion.port.revolutions": 26, "propulsion.port.oilPressure": 400_000 } })];
    const [row] = withClosingReadings(avg, plain);
    expect(row!.sog).toBe(5.0);
    expect(row!.heading_true).toBe(2.0);
    expect(row!.cog).toBe(2.1);
    expect(row!.path_values).toEqual({ "propulsion.port.revolutions": 24, "propulsion.port.oilPressure": 400_000 });
    // No plain row for that moment, or no plain rows at all: the summary stands as it is.
    expect(withClosingReadings(avg, [snap({ ts: 2, heading_true: 1 })])[0]!.heading_true).toBeNull();
    expect(withClosingReadings(avg, [])).toBe(avg);
  });

  it("says which columns of a summary page are the closing reading rather than the figure", () => {
    const fixed = [snap({ lat: 43.5, lon: 7.0 })];
    expect(summaryNote("avg", ["COG", "HDG", "AWA"], fixed)).toBe(
      "COG, HDG and AWA have no average, so on each row they carry the reading that window closed on, as the position does.",
    );
    expect(summaryNote("max", ["HDG"], [snap({})])).toBe(
      "HDG has no maximum, so on each row it carries the reading that window closed on.",
    );
  });

  /**
   * A drawn column still shows its holes. This is the dot that means something - the boat
   * measured depth on this page, and did not measure it in this row.
   */
  it("keeps printing gaps inside a column the page earned", async () => {
    const html = await draw([snap({ sog: 1.0, depth: 4.2 }), snap({ sog: 1.1 })]);
    expect(html).toContain("DEP");
    expect(html).toContain("4.2");
    expect(html).toContain("·");
  });
});

/**
 * The hour on a row is the hour aboard, read off the row's own position, and the offset stands
 * over the lane. The reader's zone does not enter into it: this suite is not run in Malta.
 */
describe("the time lane on the ship's clock", () => {
  const PORT = { lat: 35.9, lon: 14.52 };
  const at = (h: number) => Date.UTC(2026, 8, 17, h, 59);
  const malta: ZoneLookup = () => "Europe/Malta";
  const lines = (html: string) =>
    [...html.matchAll(/class="sd">(.*?)<\/span>(?=<span class="sh|<\/div>)/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));

  it("prints the hour aboard and names the offset over it, in both books", async () => {
    zoneTable.current = malta;
    try {
      const rows = [snap({ ts: at(0), ...PORT, sog: 0.2, path_values: { "propulsion.port.revolutions": 25.5 } })];
      for (const book of ["bridge", "engine"] as const) {
        const html = await draw(rows, book);
        expect(html).toContain("UTC+2");
        expect(html).toContain("02:59");
        expect(html).not.toContain("00:59");
      }
    } finally {
      zoneTable.current = null;
    }
  });

  it("prints the machines' table on the same clock as the officer's", async () => {
    zoneTable.current = malta;
    try {
      const html = await draw(
        [
          snap({
            ts: at(0),
            ...PORT,
            path_values: { "propulsion.port.revolutions": 25.5, "propulsion.starboard.revolutions": 25 },
          }),
        ],
        "engine",
      );
      expect(html).toContain("UTC+2");
      expect(html).toContain("02:59");
      expect(html).not.toContain("00:59");
    } finally {
      zoneTable.current = null;
    }
  });

  it("stays in UTC, and says UTC, for a boat that never reported a position", async () => {
    zoneTable.current = malta;
    try {
      const html = await draw([snap({ ts: at(0), sog: 0.2 })]);
      expect(html).toContain("00:59");
      expect(html).not.toContain("UTC+2");
    } finally {
      zoneTable.current = null;
    }
  });

  // 21:59 UTC is Thursday evening aboard; 22:59 UTC is already Friday there.
  const evening = [snap({ ts: at(21), ...PORT, sog: 1 }), snap({ ts: at(22), ...PORT, sog: 1 })];
  const cols = columnsFor(logbookColumns(evening, "kn"), "bridge");
  const rowsHtml = (dated: boolean | "turns", rows = evening, lookup = malta) => {
    const times = shipTimes(rows, lookup);
    return renderToStaticMarkup(
      <Rows snaps={rows} cols={cols} group={null} times={times} footer={null} lined={pageIsLined(rows, times, dated)} />,
    );
  };

  it("dates a range page at the ship's midnight, with the offset on the line", () => {
    const got = lines(rowsHtml(true));
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(/^THU · 17 .* · UTC\+2$/);
    expect(got[1]).toMatch(/^FRI · 18 .* · UTC\+2$/);
  });

  it("dates a day page that holds a turn aboard, newest first, the top rows included", () => {
    // The page lists newest first. The rows at the top are the ones past the ship's midnight,
    // which is exactly the stretch the page's own title does not name.
    const got = lines(rowsHtml("turns", [...evening].reverse()));
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(/^FRI · 18 /);
    expect(got[1]).toMatch(/^THU · 17 /);
  });

  it("leaves a day page that sits inside one day aboard to its title", () => {
    expect(lines(rowsHtml("turns", [evening[0]]))).toHaveLength(0);
  });

  it("draws no line on a live page that sits inside one offset", () => {
    expect(lines(rowsHtml(false))).toHaveLength(0);
  });

  it("dates every view once a page holds two offsets, the first row included", () => {
    const passage = [snap({ ts: at(10), ...PORT, sog: 8 }), snap({ ts: at(11), lat: 36.5, lon: 22.5, sog: 8 })];
    const twoZones: ZoneLookup = (_lat, lon) => (lon > 20 ? "Europe/Athens" : "Europe/Malta");
    const got = lines(rowsHtml(false, passage, twoZones));
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(/ · UTC\+2$/);
    expect(got[1]).toMatch(/ · UTC\+3$/);
  });
});

/**
 * Paper. The masthead is the only thing on a printed sheet that names the window, and the head
 * row prints only where no dated line carries the heads instead (swiss.css, .lb-frame.dated).
 * Both used to be true by construction: every hour was UTC and only the range view wrote lines.
 */
describe("the printed page under the ship's clock", () => {
  const PORT = { lat: 35.9, lon: 14.52 };
  const malta: ZoneLookup = () => "Europe/Malta";

  it("does not head a table of ship's hours with the word UTC", async () => {
    zoneTable.current = malta;
    try {
      const html = await draw([snap({ ts: Date.UTC(2026, 8, 17, 0, 59), ...PORT, sog: 0.2 })]);
      const masthead = html.match(/class="ph-meta">.*?<\/div><\/div>/s)?.[0] ?? "";
      expect(masthead).toContain("WINDOW");
      expect(masthead).not.toMatch(/· UTC</);
    } finally {
      zoneTable.current = null;
    }
  });

  /**
   * On paper the dated line shares its row with the column heads, and the date alone already
   * runs into the lane beside it. The offset after it ran over the first head on any sheet whose
   * first reading is one lane wide: a bridge page with the position struck off, every page of a
   * single engine. So the sheet names the clock once, in the masthead, where "UTC" used to
   * stand, and the line keeps the offset for the screen and for a sheet that holds two.
   */
  it("names the ship's clock once in the masthead, and sets the offset apart on the line", async () => {
    zoneTable.current = malta;
    try {
      const html = await draw([snap({ ts: Date.UTC(2026, 8, 17, 0, 59), ...PORT, sog: 0.2 })]);
      const masthead = html.match(/class="ph-meta">.*?<\/div><\/div>/s)?.[0] ?? "";
      expect(masthead).toContain("CLOCK");
      expect(masthead).toContain("SHIP&#x27;S TIME · UTC+2");
      expect(html).not.toMatch(/class="lb-frame[^"]* mixed/);
    } finally {
      zoneTable.current = null;
    }
  });

  it("says UTC in the masthead for a boat that never reported a position", async () => {
    const html = await draw([snap({ ts: Date.UTC(2026, 8, 17, 0, 59), sog: 0.2 })]);
    const masthead = html.match(/class="ph-meta">.*?<\/div><\/div>/s)?.[0] ?? "";
    expect(masthead).toMatch(/CLOCK<\/span><b>UTC</);
  });

  it("sends the reader of a two-offset sheet to the dated lines, and marks the frame so they keep the offset", async () => {
    zoneTable.current = (_lat, lon) => (lon > 20 ? "Europe/Athens" : "Europe/Malta");
    try {
      const html = await draw([
        snap({ ts: Date.UTC(2026, 8, 17, 10), ...PORT, sog: 8 }),
        snap({ ts: Date.UTC(2026, 8, 17, 11), lat: 36.5, lon: 22.5, sog: 8 }),
      ]);
      expect(html).toMatch(/class="lb-frame dated mixed/);
      expect(html).toContain("SHIP&#x27;S TIME · OFFSET ON EACH DATED LINE");
      expect(html).toMatch(/class="sd">[^<]*<span class="so"> · UTC\+2<\/span>/);
    } finally {
      zoneTable.current = null;
    }
  });

  it("gives the frame the class that drops the head row whenever the page writes dated lines", async () => {
    // A live page across a zone change writes lines, so its one head row must not print above
    // them: the lines are the heads on paper, and the names would be set twice.
    zoneTable.current = (_lat, lon) => (lon > 20 ? "Europe/Athens" : "Europe/Malta");
    try {
      const passage = [
        snap({ ts: Date.UTC(2026, 8, 17, 10), ...PORT, sog: 8 }),
        snap({ ts: Date.UTC(2026, 8, 17, 11), lat: 36.5, lon: 22.5, sog: 8 }),
      ];
      // The two travel together or the sheet is wrong either way: the class without the lines
      // prints a table with no heads at all, the lines without the class print them twice.
      const crossed = await draw(passage);
      expect(crossed).toMatch(/class="lb-frame dated/);
      expect(crossed.match(/class="sd"/g)).toHaveLength(2);
      const still = await draw([passage[1]]);
      expect(still).not.toMatch(/class="lb-frame dated/);
      expect(still).not.toContain('class="sd"');
    } finally {
      zoneTable.current = null;
    }
  });
});
