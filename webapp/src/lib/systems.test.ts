import { describe, expect, it } from "vitest";
import type { LiveSnapshot } from "./api";
import { systemPanels } from "../routes/bridge/useSystems";
import { quietFor } from "../routes/bridge/SystemsMarine";

/**
 * The boat draws the panels her own frame justifies.
 *
 * The frames below are not invented: the paths and values are the ones a real boat wrote to her
 * store, read back out of it. Two engines, one generator, four tanks.
 */
const frame = (paths: Record<string, number | string>, ages?: Record<string, number>) =>
  ({ paths, path_ages: ages } as unknown as LiveSnapshot);

const REAL_BOAT = {
  "propulsion.port.revolutions": 24.752888022931806,
  "propulsion.port.temperature": 357.8611369001284,
  "propulsion.port.oilPressure": 405518.8850890495,
  "propulsion.port.fuel.rate": 9.74720196392515e-6,
  "propulsion.port.fuel.used": 12.400387666111111,
  "propulsion.port.runTime": 4312857.103,
  "propulsion.starboard.revolutions": 24.573668332447216,
  "propulsion.starboard.temperature": 359.44951406750437,
  "electrical.generators.0.revolutions": 24.881563448464178,
  "electrical.generators.0.runTime": 1204257.103,
  "tanks.fuel.0.currentLevel": 0.7058961192975498,
  "tanks.fuel.1.currentLevel": 0.6620645873875111,
  "tanks.freshWater.0.currentLevel": 0.5428189299742673,
  "tanks.blackWater.0.currentLevel": 0.31026706886315614,
};

describe("systemPanels", () => {
  it("draws a real boat's panels, and reads every gauge the way a person says it", () => {
    const panels = systemPanels(frame(REAL_BOAT));
    expect(panels.map((p) => p.name)).toEqual(["Engine", "Generator", "Tanks"]);

    const cell = (path: string) =>
      panels.flatMap((p) => p.gauges).find((g) => g.path === path);
    expect(cell("propulsion.port.revolutions")?.value).toBe("1485 rpm");
    expect(cell("propulsion.port.temperature")?.value).toBe("84.7 °C");
    expect(cell("propulsion.port.oilPressure")?.value).toBe("4.1 bar");
    expect(cell("propulsion.port.fuel.rate")?.value).toBe("35.1 L/h");
    expect(cell("propulsion.port.fuel.used")?.value).toBe("12400 L");
    expect(cell("propulsion.port.runTime")?.value).toBe("1198 h");
    expect(cell("tanks.fuel.0.currentLevel")?.value).toBe("71%");
    expect(cell("tanks.blackWater.0.currentLevel")?.value).toBe("31%");
  });

  it("labels an engine by its own id and a tank by family and number", () => {
    const panels = systemPanels(frame(REAL_BOAT));
    const engine = panels.find((p) => p.key === "engine")!;
    expect(engine.gauges.filter((g) => g.label === "Port").length).toBeGreaterThan(0);
    expect(engine.gauges.filter((g) => g.label === "Starboard").length).toBeGreaterThan(0);
    expect(engine.gauges.find((g) => g.sub === "Oil pressure")?.label).toBe("Port");

    const tanks = panels.find((p) => p.key === "tanks")!;
    expect(tanks.gauges.map((g) => g.label)).toEqual([
      "Fuel 0",
      "Fuel 1",
      "Fresh water 0",
      "Black water 0",
    ]);
    // A tank's label already says what it is, so the metric is not repeated under it.
    expect(tanks.gauges.every((g) => g.sub === null)).toBe(true);
  });

  it("draws no panel for a system the boat does not have", () => {
    // A sailing boat with no generator. An empty Generator tab would read as a broken product;
    // she simply has no Generator tab, which reads as what it is.
    const sailing = systemPanels(frame({ "tanks.freshWater.0.currentLevel": 0.8 }));
    expect(sailing.map((p) => p.key)).toEqual(["tanks"]);

    // And a boat that reports nothing dynamic at all gets no panels, not three empty ones.
    expect(systemPanels(frame({}))).toEqual([]);
    expect(systemPanels(null)).toEqual([]);
    expect(systemPanels({ paths: undefined } as unknown as LiveSnapshot)).toEqual([]);
  });

  it("counts nothing: three engines, two generators and nine tanks all just appear", () => {
    const big: Record<string, number> = {};
    for (const e of ["port", "centre", "starboard"]) big[`propulsion.${e}.revolutions`] = 24;
    for (const g of [0, 1]) big[`electrical.generators.${g}.runTime`] = 3600;
    for (const t of [0, 1, 2, 3, 4, 5]) big[`tanks.fuel.${t}.currentLevel`] = 0.5;
    big["tanks.freshWater.0.currentLevel"] = 0.5;
    big["tanks.wasteWater.0.currentLevel"] = 0.5;
    big["tanks.blackWater.0.currentLevel"] = 0.5;

    const panels = systemPanels(frame(big));
    expect(panels.find((p) => p.key === "engine")!.gauges.map((g) => g.label)).toEqual([
      "Port",
      "Centre",
      "Starboard",
    ]);
    expect(panels.find((p) => p.key === "generator")!.gauges).toHaveLength(2);
    expect(panels.find((p) => p.key === "tanks")!.gauges).toHaveLength(9);
    // Grey water, because Signal K's word for it is wasteWater and nobody says that.
    expect(panels.find((p) => p.key === "tanks")!.gauges.map((g) => g.label)).toContain(
      "Grey water 0",
    );
  });

  it("carries each gauge's own age, and says nothing rather than guessing when it has none", () => {
    // The frame's own age stays near zero while the GPS talks, so a frozen instrument is only
    // visible per gauge. A boat on an older plugin sends no ages at all; that is not zero.
    const panels = systemPanels(
      frame(
        { "propulsion.port.revolutions": 24, "propulsion.port.temperature": 355.15 },
        { "propulsion.port.revolutions": 0, "propulsion.port.temperature": 240 },
      ),
    );
    const g = panels[0]!.gauges;
    expect(g.find((x) => x.sub === "Revolutions")?.ageS).toBe(0);
    expect(g.find((x) => x.sub === "Temperature")?.ageS).toBe(240);

    const noAges = systemPanels(frame({ "propulsion.port.revolutions": 24 }));
    expect(noAges[0]!.gauges[0]!.ageS).toBeNull();
  });

  it("passes a string state through and drops a gauge no panel claims", () => {
    const panels = systemPanels(
      frame({
        "propulsion.port.state": "started",
        "propulsion.port.fuel.economyRate": 8.5e-6, // suppressed: no honest name left
        "electrical.batteries.0.voltage": 12.7, // not a family this reads
      }),
    );
    expect(panels).toHaveLength(1);
    expect(panels[0]!.gauges).toHaveLength(1);
    expect(panels[0]!.gauges[0]!.value).toBe("started");
  });
});

/**
 * Every boundary, not the middle of a band: a test sitting at "5 minutes" stays green while the
 * tier it is testing moves underneath it. Each pair below is the last second of one unit and
 * the first of the next.
 */
describe("how long a gauge has been quiet", () => {
  it("counts from the second the threshold fires, without rounding up to it", () => {
    // 90s is the threshold itself. Rounding said "2 MIN AGO" for a gauge quiet for ninety
    // seconds, which overstates by a third at the exact moment a person first reads it.
    expect(quietFor(90)).toBe("1 MIN AGO");
    expect(quietFor(119)).toBe("1 MIN AGO");
    expect(quietFor(120)).toBe("2 MIN AGO");
  });

  it("turns minutes into hours at the hour, not at sixty minutes", () => {
    expect(quietFor(3599)).toBe("59 MIN AGO");
    expect(quietFor(3600)).toBe("1 H AGO");
  });

  it("turns hours into days at the day, so a boat laid up does not report in hundreds", () => {
    expect(quietFor(86399)).toBe("23 H AGO");
    expect(quietFor(86400)).toBe("1 D AGO");
    // A path is never evicted once seen, so this is reachable, and it is the reason for the tier.
    expect(quietFor(13_000_000)).toBe("150 D AGO");
  });
});
