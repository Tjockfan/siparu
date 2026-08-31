import { describe, it, expect } from "vitest";
import {
  systemClusters,
  systemPanels,
  toMatrix,
  toSummary,
  type SystemGauge,
} from "./useSystems";
import type { LiveSnapshot } from "../../data/api";

function snap(paths: Record<string, number | string>): LiveSnapshot {
  return { paths } as LiveSnapshot;
}

/** The same frame with per-path ages attached, for the freshness cases below. */
function aged(s: LiveSnapshot, ages: Record<string, number>): LiveSnapshot {
  return { ...s, path_ages: ages } as LiveSnapshot;
}

describe("toMatrix", () => {
  it("turns a multi-engine panel into instance columns by parameter rows", () => {
    // Three engines, two metrics each, inserted in the boat's own path order.
    const s = snap({
      "propulsion.port.revolutions": 26.0,
      "propulsion.port.temperature": 355.15,
      "propulsion.center.revolutions": 26.1,
      "propulsion.center.temperature": 356.15,
      "propulsion.starboard.revolutions": 25.9,
      "propulsion.starboard.temperature": 357.15,
    });
    const engine = systemPanels(s).find((p) => p.key === "engine")!;
    const m = toMatrix(engine.gauges);

    // Columns are the distinct instances in the boat's order, one per engine.
    expect(m.cols).toEqual(["Port", "Center", "Starboard"]);
    // Rows are the distinct parameters, first-seen order.
    expect(m.rows.map((r) => r.sub)).toEqual(["Revolutions", "Temperature"]);
    // Same parameter for three engines lands on one row, one cell per column, so they
    // can be read side by side - the whole point of the matrix.
    const rpm = m.rows.find((r) => r.sub === "Revolutions")!;
    expect(rpm.cells["Port"]?.value).toBe("1560 rpm");
    expect(rpm.cells["Center"]?.value).toBe("1566 rpm");
    expect(rpm.cells["Starboard"]?.value).toBe("1554 rpm");
  });

  it("leaves a column empty where an instance does not report a parameter", () => {
    // Center reports no coolant temperature; its cell on that row is absent, not invented.
    const s = snap({
      "propulsion.port.revolutions": 26.0,
      "propulsion.port.temperature": 355.15,
      "propulsion.center.revolutions": 26.1,
    });
    const engine = systemPanels(s).find((p) => p.key === "engine")!;
    const m = toMatrix(engine.gauges);
    expect(m.cols).toEqual(["Port", "Center"]);
    const temp = m.rows.find((r) => r.sub === "Temperature")!;
    expect(temp.cells["Port"]?.value).toBe("82.0 °C");
    expect(temp.cells["Center"]).toBeUndefined();
  });

  it("keeps a gearbox oil reading on its own row, not merged with the engine's", () => {
    // An engine's own oil and its gearbox's oil both end in oilTemperature; describePath names them
    // apart ("Oil temperature" vs "Gearbox oil temperature") so the matrix cannot land them on one
    // row and silently drop one. This pins that: two distinct rows, both readings present.
    const s = snap({
      "propulsion.port.oilTemperature": 370.15,
      "propulsion.port.transmission.oilTemperature": 345.15,
    });
    const engine = systemPanels(s).find((p) => p.key === "engine")!;
    const m = toMatrix(engine.gauges);
    const subs = m.rows.map((r) => r.sub);
    expect(subs).toContain("Oil temperature");
    expect(subs).toContain("Gearbox oil temperature");
    expect(m.rows.find((r) => r.sub === "Oil temperature")!.cells["Port"]?.value).toBe("97.0 °C");
    expect(m.rows.find((r) => r.sub === "Gearbox oil temperature")!.cells["Port"]?.value).toBe("72.0 °C");
  });

  it("keeps a sub-less gauge visible, keyed by its own label", () => {
    // Defensive: nothing in engine/generator returns a null sub today, but a gauge that
    // does must become its own row rather than vanish from the matrix.
    const gauges: SystemGauge[] = [
      { path: "propulsion.port.revolutions", label: "Port", sub: "Revolutions", value: "1560 rpm", ageS: null },
      { path: "propulsion.port.state", label: "Port", sub: null, value: "started", ageS: null },
    ];
    const m = toMatrix(gauges);
    expect(m.cols).toEqual(["Port"]);
    expect(m.rows.map((r) => r.sub)).toEqual(["Revolutions", "Port"]);
    expect(m.rows[1].cells["Port"]?.value).toBe("started");
  });
});

/**
 * A gauge's age has two halves: how long ago the instrument spoke, measured aboard, and how
 * long ago the frame carrying that measurement was built. The panel judges on the sum. Reading
 * the first alone is how a boat that went off the air keeps a full set of confident engine
 * readings on screen - the frame stops arriving, its ages freeze, and the poller holds the
 * last one deliberately.
 */
describe("a gauge's age counts the frame it arrived in", () => {
  const frame = {
    ts: 1_770_000_000_000,
    paths: { "propulsion.port.revolutions": 1590 },
    path_ages: { "propulsion.port.revolutions": 4 },
  } as unknown as LiveSnapshot;

  const ageOfPort = (frameAgeS?: number) =>
    systemPanels(frame, frameAgeS).flatMap((p) => p.gauges).find((g) => g.path.endsWith("revolutions"))?.ageS;

  it("adds the frame's own age to the reading's", () => {
    expect(ageOfPort(0)).toBe(4);
    expect(ageOfPort(3600)).toBe(3604);
  });

  it("defaults to the age aboard when no frame age is given", () => {
    expect(ageOfPort()).toBe(4);
  });
});

describe("toSummary", () => {
  /**
   * The matrix draws every reading an engine has, all at one weight: three engines with a
   * dozen parameters each is 36 numbers on the screen before the eye has found the first
   * one. The summary is what a person actually checks - is she turning, is she hot, does
   * she have oil pressure - with the rest a click away.
   */
  it("gives each instance the three readings a person checks first", () => {
    const s = snap({
      // Deliberately in an order that is NOT the order they should be read in: the boat
      // reports how she is wired, and load arriving before oil pressure must not push oil
      // pressure out of the summary.
      "propulsion.port.engineLoad": 0.63,
      "propulsion.port.oilPressure": 420000,
      "propulsion.port.revolutions": 26.0,
      "propulsion.port.temperature": 355.15,
      "propulsion.port.runTime": 4312800,
    });
    const engine = systemPanels(s).find((p) => p.key === "engine")!;
    const sum = toSummary(engine.gauges);
    expect(sum.rows.map((r) => r.label)).toEqual(["Port"]);
    expect(sum.params).toEqual(["Revolutions", "Temperature", "Oil pressure"]);
  });

  it("counts what it is holding back, so the screen can say so", () => {
    const s = snap({
      "propulsion.port.revolutions": 26.0,
      "propulsion.port.temperature": 355.15,
      "propulsion.port.oilPressure": 420000,
      "propulsion.port.engineLoad": 0.63,
      "propulsion.port.runTime": 4312800,
      "propulsion.starboard.revolutions": 25.9,
      "propulsion.starboard.boostPressure": 170000,
    });
    const engine = systemPanels(s).find((p) => p.key === "engine")!;
    const sum = toSummary(engine.gauges);
    // Parameters, not cells: what opening the matrix adds is rows. The summary shows the
    // panel's first three (rpm, coolant, oil); engine load, run time and boost pressure are
    // what it is holding back, including one that only the starboard engine reports.
    expect(sum.rest.rows.map((r) => r.sub)).toEqual([
      "Engine load",
      "Run time",
      "Boost pressure",
    ]);
    // And the three already on the summary rows are not repeated underneath.
    expect(sum.rest.rows.some((r) => sum.params.includes(r.sub))).toBe(false);
  });

  /**
   * The rows share their parameters, so an instance that does not report one has a gap
   * rather than somebody else's reading shifted into its place.
   */
  it("leaves a gap where an instance is silent on a summary parameter", () => {
    const s = snap({
      "propulsion.port.revolutions": 26.0,
      "propulsion.port.temperature": 355.15,
      "propulsion.starboard.revolutions": 25.9,
    });
    const engine = systemPanels(s).find((p) => p.key === "engine")!;
    const sum = toSummary(engine.gauges);
    expect(sum.params).toEqual(["Revolutions", "Temperature"]);
    const stbd = sum.rows.find((r) => r.label === "Starboard")!;
    expect(stbd.cells[0]?.value).toBe("1554 rpm");
    expect(stbd.cells[1]).toBeUndefined();
  });

  /** A boat that reports nothing beyond the summary has nothing to open. */
  it("holds nothing back when the boat has nothing more to say", () => {
    const s = snap({
      "propulsion.port.revolutions": 26.0,
      "propulsion.port.temperature": 355.15,
    });
    const engine = systemPanels(s).find((p) => p.key === "engine")!;
    expect(toSummary(engine.gauges).rest.rows).toEqual([]);
  });

  /**
   * A generator is not an engine with a different name. Volts and amps are what a person
   * checks on one, and the same ranking has to reach them without a second list.
   */
  it("reads a generator by its own three", () => {
    const s = snap({
      "electrical.generators.0.runTime": 1206000,
      "electrical.generators.0.current": 23.4,
      "electrical.generators.0.voltage": 230.1,
      "electrical.generators.0.revolutions": 25.0,
    });
    const gen = systemPanels(s).find((p) => p.key === "generator")!;
    expect(toSummary(gen.gauges).params).toEqual(["Revolutions", "Voltage", "Current"]);
  });

  /**
   * A boat reporting only parameters nobody ranked still gets a summary. Falling back to her
   * own order is what keeps the screen from going blank on hardware we have not met.
   */
  it("falls back to the boat's own order for readings it does not rank", () => {
    const s = snap({
      "propulsion.port.boostPressure": 170000,
      "propulsion.port.engineLoad": 0.63,
      "propulsion.port.runTime": 4312800,
      "propulsion.port.alternatorVoltage": 28.3,
    });
    const engine = systemPanels(s).find((p) => p.key === "engine")!;
    const sum = toSummary(engine.gauges);
    expect(sum.params).toHaveLength(3);
    expect(sum.params[0]).toBe("Boost pressure");
  });
});

describe("systemClusters", () => {
  /**
   * Engines and generators are one thing to the person reading them - the machinery - and were
   * two panels because the plugin sorts paths into three families. That is a fact about paths,
   * not about how a boat is read.
   */
  it("puts engines and generators under one heading, tanks under their own", () => {
    const s = snap({
      "propulsion.port.revolutions": 26.0,
      "propulsion.starboard.revolutions": 25.9,
      "electrical.generators.0.voltage": 230.1,
      "tanks.fuel.0.currentLevel": 0.74,
    });
    const c = systemClusters(s);
    expect(c.map((x) => x.key)).toEqual(["machinery", "tanks"]);
    expect(c[0].name).toBe("Machinery");
    expect(c[0].panels.map((p) => p.key)).toEqual(["engine", "generator"]);
  });

  /**
   * What she carries is counted off the readings rather than configured, and it is said in
   * exactly one place: on the blocks where a cluster holds two kinds, on the heading where it
   * holds one. A heading that repeated the blocks below it would say the same thing twice.
   */
  it("counts the units, once", () => {
    const s = snap({
      "propulsion.port.revolutions": 26.0,
      "propulsion.starboard.revolutions": 25.9,
      "electrical.generators.0.voltage": 230.1,
      "tanks.fuel.0.currentLevel": 0.74,
      "tanks.freshWater.0.currentLevel": 0.58,
    });
    const c = systemClusters(s);
    expect(c[0].panels.map((p) => p.note)).toEqual(["2 engines", "1 generator"]);
    expect(c[0].note).toBe("");
    // Tanks are one kind, so the heading carries the count and there is no block to name.
    expect(c[1].note).toBe("2 tanks");
  });

  /**
   * The badge is the one thing a heading can say that the readings under it cannot, because the
   * disclosure hides most of them: whether anything in this cluster has stopped talking. It is
   * freshness and nothing else - no judgement about what a reading MEANS, which would need
   * thresholds this product refuses to invent.
   */
  it("names how many gauges have gone quiet, not what they read", () => {
    const s = snap({
      "propulsion.port.revolutions": 26.0,
      "propulsion.port.temperature": 355.15,
      "electrical.generators.0.voltage": 230.1,
    });
    const fresh = systemClusters(aged(s, { "propulsion.port.revolutions": 2 }), 0);
    expect(fresh[0].quiet).toBe(0);

    const stale = systemClusters(
      aged(s, {
        "propulsion.port.revolutions": 400,
        "propulsion.port.temperature": 2,
        "electrical.generators.0.voltage": 900,
      }),
      0
    );
    // One engine gauge and one generator gauge: the cluster counts across both panels.
    expect(stale[0].quiet).toBe(2);
    expect(stale[0].total).toBe(3);
  });

  /**
   * A frame that stopped arriving carries ages frozen at the moment it was built, so the frame's
   * own age has to be added before anything is called fresh - the same sum the panels make.
   */
  it("ages the whole cluster by the frame carrying it", () => {
    const s = snap({ "propulsion.port.revolutions": 26.0 });
    const a = aged(s, { "propulsion.port.revolutions": 10 });
    expect(systemClusters(a, 0)[0].quiet).toBe(0);
    expect(systemClusters(a, 600)[0].quiet).toBe(1);
  });
})
