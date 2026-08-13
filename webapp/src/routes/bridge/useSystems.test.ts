import { describe, it, expect } from "vitest";
import { systemPanels, toMatrix, type SystemGauge } from "./useSystems";
import type { LiveSnapshot } from "../../lib/api";

function snap(paths: Record<string, number | string>): LiveSnapshot {
  return { paths } as LiveSnapshot;
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
