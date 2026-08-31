/**
 * A logbook column has to be earned by a reading, because the alternative was on screen for
 * months: a boat with no barometer printed a BARO column with a dot in every row, and a bare
 * boat printed three of them. A column that can never be filled is not a missing feature, it
 * is the screen telling the owner his instrument is broken.
 *
 * The pairs below are what the derivation has to get right - not "does it return an array".
 */
import { describe, expect, it } from "vitest";
import { logbookColumns } from "./columns";
import type { Snapshot } from "../../data/api";

/** A snapshot with nothing in it but a time, which is the one thing every row has. */
function row(over: Partial<Snapshot> = {}): Snapshot {
  return {
    ts: 1_770_000_000_000,
    lat: null,
    lon: null,
    sog: null,
    cog: null,
    heading_mag: null,
    heading_true: null,
    rate_of_turn: null,
    magnetic_variation: null,
    magnetic_deviation: null,
    nav_state: null,
    wind_speed_apparent: null,
    wind_angle_apparent: null,
    wind_speed_true: null,
    wind_gust: null,
    wind_direction_true: null,
    air_temp_k: null,
    air_pressure_pa: null,
    depth: null,
    water_temp_k: null,
    gps_satellites: null,
    ais_class: null,
    ...over,
  } as Snapshot;
}

const keys = (snaps: Snapshot[], unit: "kn" | "bft" = "kn") =>
  logbookColumns(snaps, unit).map((c) => c.key);

describe("logbookColumns", () => {
  it("keeps the time column even when the boat reported nothing else", () => {
    expect(keys([row()])).toEqual(["ts"]);
    expect(keys([])).toEqual(["ts"]);
  });

  /** The motor yacht: every instrument aboard, every column drawn, in reading order. */
  it("draws every column a fully instrumented boat fills", () => {
    const full = row({ sog: 4.1, heading_true: 1.9, wind_speed_true: 6.4, air_pressure_pa: 101_300, depth: 18.2 });
    expect(keys([full])).toEqual(["ts", "sog", "hdg", "wind", "baro", "depth"]);
  });

  /**
   * The sailing yacht of the profile table: no barometer aboard. This is the case that was on
   * screen - a column of dots, one per row, saying nothing at all.
   */
  it("drops the column of a sensor the boat does not carry", () => {
    const sailing = row({ sog: 3.2, heading_true: 1.1, wind_speed_true: 8.0, depth: 12.0 });
    expect(keys([sailing])).not.toContain("baro");
    expect(keys([sailing])).toEqual(["ts", "sog", "hdg", "wind", "baro", "depth"].filter((k) => k !== "baro"));
  });

  /** The bare boat: a GPS and an engine, nothing else on the bus. */
  it("falls back to a time and a speed on a boat carrying only a GPS", () => {
    expect(keys([row({ sog: 2.4 })])).toEqual(["ts", "sog"]);
  });

  /**
   * One reading over the whole page is enough. A sounder that spoke twice while the boat lay
   * alongside still measured the water, and its two figures are the reason to open the page.
   */
  it("earns a column on a single reading anywhere on the page", () => {
    const page = [row({ sog: 1 }), row({ sog: 1 }), row({ sog: 1, depth: 4.2 }), row({ sog: 1 })];
    expect(keys(page)).toContain("depth");
  });

  /** A boat steering on a magnetic compass has a heading, and the column has to accept it. */
  it("accepts either heading source", () => {
    expect(keys([row({ heading_mag: 2.0 })])).toContain("hdg");
    expect(keys([row({ heading_true: 2.0 })])).toContain("hdg");
  });

  /**
   * A position is written in degrees, minutes and a hemisphere, and that does not go in a lane
   * sized for a four-figure reading.
   *
   * Measured in the browser on the demo boat: the widest longitude cell asks for 105px where a
   * heading asks 35, and on a 390px phone the latitude overran its 50px lane by 30 and was
   * painted across the longitude beside it. A row does not clip, so it overprinted rather than
   * being cut, and no measurement of clipping ever saw it. The pair says what it needs here;
   * fitColumns reserves it and the stylesheet spends it.
   */
  it("asks two lanes for each half of a position and one for every reading", () => {
    const full = row({ lat: 43.5, lon: 7.02, sog: 4.1, heading_true: 1.9, depth: 18.2 });
    const cols = logbookColumns([full], "kn");
    expect(cols.filter((c) => (c.lanes ?? 1) > 1).map((c) => c.key)).toEqual(["lat", "lon"]);
    for (const c of cols) expect(c.lanes ?? 1, c.key).toBe(c.key === "lat" || c.key === "lon" ? 2 : 1);
  });

  /**
   * A unit is named once over its column, and the column takes it from the path rather than
   * from a list kept here.
   *
   * Without it the engineer's table printed twelve columns of bare figures: "4.0" for an oil
   * pressure and "94.5" for the oil temperature beside it, a pair a reader has to already know
   * the boat to tell apart. The names live in the plugin's own metric table, which is the same
   * table that converts the figures, so a column cannot be headed in one unit and filled in
   * another.
   */
  it("takes each engine column's unit from the path that fills it", () => {
    const eng = logbookColumns(
      [
        row({
          path_values: {
            "propulsion.port.revolutions": 26.0,
            "propulsion.port.oilPressure": 4.0e5,
            "propulsion.port.oilTemperature": 367.6,
            "propulsion.port.alternatorVoltage": 28.3,
          },
        }),
      ],
      "kn",
    ).filter((c) => c.book === "engine");
    expect(Object.fromEntries(eng.map((c) => [c.head, c.unit]))).toEqual({
      RPM: "rpm",
      OIL: "bar",
      OILT: "°C",
      ALT: "V",
    });
  });

  /**
   * A head whose cell already carries the mark says it once. A course prints "124", a position
   * prints its own degrees and hemisphere, and a head repeating that is a page saying the same
   * thing twice in a column two figures wide.
   */
  it("leaves the unit off a column whose cells carry their own mark", () => {
    const full = row({
      lat: 43.5,
      lon: 7.02,
      sog: 4.1,
      cog: 2.0,
      heading_true: 1.9,
      air_temp_k: 295,
      depth: 18.2,
    });
    const by = Object.fromEntries(logbookColumns([full], "kn").map((c) => [c.key, c.unit]));
    expect(by).toMatchObject({ sog: "kn", air: "°C", depth: "m" });
    for (const key of ["ts", "lat", "lon", "cog", "hdg"]) expect(by[key], key).toBeUndefined();
  });

  it("names the wind column after the unit in force", () => {
    const windy = [row({ wind_speed_true: 6.0 })];
    expect(logbookColumns(windy, "kn").find((c) => c.key === "wind")?.head).toBe("TWS");
    expect(logbookColumns(windy, "bft").find((c) => c.key === "wind")?.head).toBe("BFT");
  });

  /**
   * A drawn column still prints gaps: the boat measured this, and did not measure it here.
   * That dot is a hole in a real series, which is the opposite of the dot this change removes.
   */
  it("prints a gap inside a column the page earned", () => {
    const page = [row({ depth: 4.2 }), row()];
    const depth = logbookColumns(page, "kn").find((c) => c.key === "depth")!;
    expect(depth.cell(page[0])).toBe("4.2");
    expect(depth.cell(page[1])).toBe("·");
  });

  it("prints what the row said, in the units the header promises", () => {
    const s = row({ sog: 4.1, heading_true: Math.PI, wind_speed_true: 10.3, air_pressure_pa: 101_325, depth: 18.24 });
    const at = (k: string, unit: "kn" | "bft" = "kn") =>
      logbookColumns([s], unit).find((c) => c.key === k)!.cell(s);
    expect(at("sog")).toBe("8.0");
    expect(at("hdg")).toBe("180°");
    expect(at("wind")).toBe("20");
    expect(at("wind", "bft")).toBe("5");
    expect(at("baro")).toBe("1013");
    expect(at("depth")).toBe("18.2");
    expect(at("ts")).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("the two books", () => {
  /**
   * A logbook is kept twice on a ship: the chief officer's, and the engineer's. The screen had
   * only the first, so a boat reporting three engines put none of them in her log at all.
   */
  it("files the navigation columns under the bridge book", () => {
    const cols = logbookColumns([row({ sog: 4.1, depth: 18.2 })], "kn");
    expect(cols.every((c) => c.book === "bridge")).toBe(true);
  });

  it("earns an engine column from a gauge the boat actually reported", () => {
    const cols = logbookColumns(
      [row({ path_values: { "propulsion.port.revolutions": 26.0 } })],
      "kn"
    );
    const eng = cols.filter((c) => c.book === "engine");
    expect(eng.map((c) => c.head)).toEqual(["RPM"]);
    expect(eng[0].cell(row({ path_values: { "propulsion.port.revolutions": 26.0 } }))).toBe("1560");
  });

  /**
   * The rule the whole screen keeps, applied to the second book: a boat with one engine is not
   * offered three tachometer columns, and never was offered them by a list somebody wrote down.
   */
  it("offers one engine's columns to a boat with one engine, and three to a boat with three", () => {
    // A lone machine's columns drop her initial: the prefix exists to tell machines apart,
    // and "E0 RPM · E0 TEMP" down a whole header names a distinction the boat does not have.
    const single = logbookColumns(
      [row({ path_values: { "propulsion.0.revolutions": 24.0, "propulsion.0.temperature": 355 } })],
      "kn"
    );
    expect(single.filter((c) => c.book === "engine").map((c) => c.head)).toEqual([
      "RPM",
      "TEMP",
    ]);

    const triple = logbookColumns(
      [
        row({
          path_values: {
            "propulsion.port.revolutions": 26.0,
            "propulsion.center.revolutions": 26.1,
            "propulsion.starboard.revolutions": 25.9,
          },
        }),
      ],
      "kn"
    );
    expect(triple.filter((c) => c.book === "engine").map((c) => c.head)).toEqual([
      "P RPM",
      "C RPM",
      "S RPM",
    ]);
  });

  it("keeps a generator apart from an engine in the same book", () => {
    const cols = logbookColumns(
      [row({ path_values: { "electrical.generators.0.voltage": 230.1 } })],
      "kn"
    );
    expect(cols.filter((c) => c.book === "engine").map((c) => c.head)).toEqual(["VOLT"]);
    expect(cols.filter((c) => c.book === "engine").map((c) => c.tab)).toEqual(["generator"]);
  });

  /**
   * Seen on a live boat: her engine reports a burn rate and the derived plugin a distance per
   * volume, and both shortened to FUEL - two columns headed the same on screen and in the CSV.
   * The burn rate keeps the word; the L/nm column is headed by its unit, which is the one
   * short name that states its direction.
   */
  it("heads a lone engine's burn rate FUEL and its fuel-per-mile by the unit", () => {
    const cols = logbookColumns(
      [row({ path_values: { "propulsion.main.fuel.rate": 8.4e-6, "propulsion.main.fuel.economy": 1_848_605 } })],
      "kn"
    );
    expect(cols.filter((c) => c.book === "engine").map((c) => c.head)).toEqual(["FUEL", "L/NM"]);
  });

  /**
   * A boat stopped with her engine running burns fuel over no distance, and the derived plugin
   * publishes an economy of exactly zero. The inverse of that is no figure at all, and the
   * gauge prints the dot for it; the log column printed the word NaN under L/nm.
   */
  it("prints the gap, not NaN, for a fuel-per-mile of zero", () => {
    const rest = row({ path_values: { "propulsion.main.fuel.economy": 0 } });
    const [col] = logbookColumns([rest], "kn").filter((c) => c.book === "engine");
    expect(col!.cell(rest)).toBe("·");
  });

  /**
   * The tanks earn columns too: their level path carries no sub (the gauge screen's choice),
   * and the book used to drop them for it - eight tanks aboard and none in the log. Two
   * families of tanks must also stay apart by more than one initial: "Fuel 0" and
   * "Fresh water 0" both shortened to F0.
   */
  it("earns a level column per tank, headed apart across tank families", () => {
    const cols = logbookColumns(
      [
        row({
          path_values: {
            "tanks.fuel.0.currentLevel": 0.8,
            "tanks.freshWater.0.currentLevel": 0.6,
          },
        }),
      ],
      "kn"
    );
    expect(cols.filter((c) => c.book === "engine").map((c) => c.head)).toEqual([
      "F0 LEVEL",
      "FW0 LEVEL",
    ]);
  });

  /** A path no reading describes is not given a column headed with a guess. */
  it("draws no column for a path it cannot name", () => {
    const cols = logbookColumns([row({ path_values: { "sensors.foo.bar": 1 } })], "kn");
    expect(cols.filter((c) => c.book === "engine")).toEqual([]);
  });

  /**
   * Two columns headed the same thing are worse than one column missing: the reader picks
   * "P GEARBOX" out of a list of forty and gets whichever of the two came first. It happened
   * on the first boat with a gearbox, where oil temperature and oil pressure both shortened to
   * their first word.
   */
  it("heads no two gauges of one boat the same way", () => {
    const paths: Record<string, number> = {};
    for (const id of ["port", "center", "starboard"]) {
      for (const m of [
        "revolutions",
        "temperature",
        "oilPressure",
        "oilTemperature",
        "alternatorVoltage",
        "engineLoad",
        "boostPressure",
        "runTime",
        "transmission.oilTemperature",
        "transmission.oilPressure"
      ]) {
        paths[`propulsion.${id}.${m}`] = 1;
      }
      paths[`propulsion.${id}.fuel.rate`] = 1;
      paths[`propulsion.${id}.fuel.used`] = 1;
    }
    for (const g of ["0", "1"]) {
      for (const m of ["revolutions", "voltage", "current", "runTime"]) {
        paths[`electrical.generators.${g}.${m}`] = 1;
      }
    }
    for (const t of ["fuel.0", "fuel.1", "freshWater.0", "blackWater.0", "greyWater.0", "lubrication.0"]) {
      paths[`tanks.${t}.currentLevel`] = 0.5;
    }
    const heads = logbookColumns([row({ path_values: paths })], "kn")
      .filter((c) => c.book === "engine")
      .map((c) => c.head);
    expect(heads.length).toBeGreaterThan(30);
    expect(new Set(heads).size).toBe(heads.length);
  });

  it("completes the bridge book the mockup drew: course, apparent wind, air and sea", () => {
    const cols = logbookColumns(
      [row({ cog: 1.9, wind_angle_apparent: 0.7, air_temp_k: 295, water_temp_k: 292 })],
      "kn"
    );
    expect(cols.map((c) => c.head)).toEqual(["UTC", "COG", "AWA", "AIR", "SEA"]);
  });
});
