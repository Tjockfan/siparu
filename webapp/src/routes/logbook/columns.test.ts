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
import type { Snapshot } from "../../lib/api";

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
