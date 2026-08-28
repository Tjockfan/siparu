/**
 * What the engineer's table has to get right about a boat nobody wrote down.
 *
 * The cases below are boats: three engines and two generators and nine tanks, one engine, an
 * engine that reports a gauge her sisters do not. None of them is a shape this code knows - the
 * point of every assertion here is that the shape came out of the paths and not out of a list.
 */
import { describe, expect, it } from "vitest";
import { unitCell, unitGroups } from "./unitRows";
import type { Snapshot } from "../../lib/api";

function row(paths: Record<string, number>, ts = 1_770_000_000_000): Snapshot {
  return { ts, path_values: paths } as unknown as Snapshot;
}

/** The demo boat's engine room, in her own path order: port, centre, starboard. */
function engines(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const side of ["port", "center", "starboard"]) {
    out[`propulsion.${side}.revolutions`] = 25;
    out[`propulsion.${side}.temperature`] = 355;
    out[`propulsion.${side}.oilPressure`] = 400_000;
  }
  return out;
}

describe("unitGroups", () => {
  it("gives each family the boat reports its own group, and no others", () => {
    const g = unitGroups([
      row({
        ...engines(),
        "electrical.generators.0.voltage": 230,
        "tanks.fuel.0.currentLevel": 0.8,
      }),
    ]);
    // The tanks are absent, and not because this table dropped them: a tank path describes a
    // unit and no metric ("Fuel 0", sub null), so there is no reading to head a column with.
    // That is a gap in the log itself and is filed as one; it is not this table's to invent.
    expect(g.map((x) => x.tab)).toEqual(["engine", "generator"]);
    expect(g.map((x) => x.head)).toEqual(["ENGINES", "GENERATORS"]);
  });

  it("makes each engine a row and each reading a column", () => {
    const [eng] = unitGroups([row(engines())]);
    expect(eng!.units.map((u) => u.head)).toEqual(["PORT", "CENTER", "STARBOARD"]);
    expect(eng!.metrics.map((m) => m.head)).toEqual(["RPM", "TEMP", "OIL"]);
  });

  it("keeps the boat's order rather than an alphabet", () => {
    // Starboard first, port last: an engineer reading a table sorted A-Z would find centre
    // between them, which is not where she is.
    const [eng] = unitGroups([
      row({
        "propulsion.starboard.revolutions": 25,
        "propulsion.port.revolutions": 25,
        "propulsion.starboard.temperature": 355,
      }),
    ]);
    expect(eng!.units.map((u) => u.head)).toEqual(["STARBOARD", "PORT"]);
  });

  it("names a lone engine the way the boat numbers her", () => {
    const [eng] = unitGroups([
      row({
        "propulsion.0.revolutions": 25,
        "propulsion.0.temperature": 355,
        "propulsion.0.oilPressure": 400_000,
      }),
    ]);
    // A boat with one engine numbers it rather than naming a side, and the row says so: the
    // screen drops the machine's lane at this point, but the group still knows what it is.
    expect(eng!.units.map((u) => u.head)).toEqual(["ENGINE 0"]);
  });

  it("gives a generator its own group rather than folding it in with the engines", () => {
    const [eng, gen] = unitGroups([
      row({
        "propulsion.port.revolutions": 25,
        "electrical.generators.0.voltage": 230,
        "electrical.generators.1.voltage": 229,
      }),
    ]);
    // The two families share a reading name and nothing else; one table of both would head a
    // column RPM and leave it empty on every generator line.
    expect(eng!.units.map((u) => u.head)).toEqual(["PORT"]);
    expect(gen!.units.map((u) => u.head)).toEqual(["GENERATOR 0", "GENERATOR 1"]);
  });

  it("grows a column for a gauge only one machine carries", () => {
    const [eng] = unitGroups([
      row({
        "propulsion.port.revolutions": 25,
        "propulsion.port.boostPressure": 160_000,
        "propulsion.starboard.revolutions": 25,
      }),
    ]);
    expect(eng!.metrics.map((m) => m.head)).toEqual(["RPM", "BOOST"]);
    const [port, stbd] = eng!.units;
    expect(unitCell(row({ "propulsion.port.boostPressure": 160_000 }), port!, eng!.metrics[1]!)).toBe("1.6");
    // Starboard has no such gauge: the cell reads as the gap it is, not as a blank lane.
    expect(unitCell(row({ "propulsion.port.boostPressure": 160_000 }), stbd!, eng!.metrics[1]!)).toBe("·");
  });

  it("collects a gauge that only appears in a later row", () => {
    // Loading further back can add a reading, the way the column table already grows one.
    const [eng] = unitGroups([
      row({ "propulsion.port.revolutions": 25, "propulsion.starboard.revolutions": 25 }),
      row({ "propulsion.port.oilPressure": 400_000 }, 1_769_999_940_000),
    ]);
    expect(eng!.metrics.map((m) => m.head)).toEqual(["RPM", "OIL"]);
  });

  it("prints a reading in the units a person says", () => {
    const [eng] = unitGroups([row(engines())]);
    const s = row(engines());
    const [rpm, temp, oil] = eng!.metrics;
    const port = eng!.units[0]!;
    // 25 Hz is 1500 rpm, 355 K is 81.9 C, 400 kPa is 4 bar.
    expect(unitCell(s, port, rpm!)).toBe("1500");
    expect(unitCell(s, port, temp!)).toBe("81.9");
    expect(unitCell(s, port, oil!)).toBe("4");
  });

  it("says nothing about a boat that reports no machines at all", () => {
    expect(unitGroups([row({})])).toEqual([]);
  });
});
