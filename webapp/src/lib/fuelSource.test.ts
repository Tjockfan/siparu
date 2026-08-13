import { describe, it, expect } from "vitest";
import {
  fuelPathLabel,
  fuelSourceNotice,
  fuelSourceOffered,
  fuelSourceRows,
  fuelSourceSummary,
  fuelSourcesNotReporting,
} from "./fuelSource";

describe("fuelPathLabel", () => {
  it("names the propulsion instance", () => {
    expect(fuelPathLabel("propulsion.port.fuel.rate")).toBe("Port");
    expect(fuelPathLabel("propulsion.engine.fuel.rate")).toBe("Engine");
  });

  it("falls back to the whole path when it is shaped differently", () => {
    expect(fuelPathLabel("tanks.fuel.0.rate")).toBe("Tanks.fuel.0.rate");
  });
});

describe("fuelSourceOffered", () => {
  it("stays hidden on a boat with one engine and no narrowing", () => {
    expect(fuelSourceOffered({ available: ["propulsion.port.fuel.rate"], selected: [] })).toBe(false);
  });

  it("appears as soon as there is a choice to make", () => {
    expect(
      fuelSourceOffered({
        available: ["propulsion.port.fuel.rate", "propulsion.starboard.fuel.rate"],
        selected: [],
      }),
    ).toBe(true);
  });

  // The case that stranded a user: two paths were narrowed to one, then the
  // boat was tidied up until only one path reported. A selection that outlives
  // the paths it names must stay reachable, or voyage fuel reads empty with no
  // way to see why.
  it("stays reachable when a selection outlives the path it names", () => {
    expect(
      fuelSourceOffered({
        available: ["propulsion.port.fuel.rate"],
        selected: ["propulsion.engine.fuel.rate"],
      }),
    ).toBe(true);
  });
});

describe("fuelSourcesNotReporting", () => {
  it("is empty while every selected path still reports", () => {
    expect(
      fuelSourcesNotReporting({
        available: ["propulsion.port.fuel.rate", "propulsion.starboard.fuel.rate"],
        selected: ["propulsion.port.fuel.rate"],
      }),
    ).toEqual([]);
  });

  it("names a selected path the boat no longer reports", () => {
    expect(
      fuelSourcesNotReporting({
        available: ["propulsion.port.fuel.rate"],
        selected: ["propulsion.engine.fuel.rate"],
      }),
    ).toEqual(["propulsion.engine.fuel.rate"]);
  });

  it("says nothing when nothing is narrowed", () => {
    expect(fuelSourcesNotReporting({ available: [], selected: [] })).toEqual([]);
  });
});

describe("fuelSourceRows", () => {
  it("offers every reporting path", () => {
    expect(
      fuelSourceRows({
        available: ["propulsion.port.fuel.rate", "propulsion.starboard.fuel.rate"],
        selected: ["propulsion.port.fuel.rate"],
      }),
    ).toEqual([
      { path: "propulsion.port.fuel.rate", reporting: true },
      { path: "propulsion.starboard.fuel.rate", reporting: true },
    ]);
  });

  // Without this row the selection cannot be switched off: the sheet only ever
  // listed reporting paths, so a stale one stayed selected through an Apply.
  it("keeps a selected path in the list once it stops reporting", () => {
    expect(
      fuelSourceRows({
        available: ["propulsion.port.fuel.rate"],
        selected: ["propulsion.engine.fuel.rate"],
      }),
    ).toEqual([
      { path: "propulsion.port.fuel.rate", reporting: true },
      { path: "propulsion.engine.fuel.rate", reporting: false },
    ]);
  });

  it("does not repeat a path that is both selected and reporting", () => {
    const rows = fuelSourceRows({
      available: ["propulsion.port.fuel.rate"],
      selected: ["propulsion.port.fuel.rate"],
    });
    expect(rows).toHaveLength(1);
  });
});

describe("fuelSourceNotice", () => {
  it("stays quiet while nothing is narrowed", () => {
    expect(fuelSourceNotice({ available: ["propulsion.port.fuel.rate"], selected: [] })).toBeNull();
  });

  it("stays quiet while one of the selected engines still reports", () => {
    expect(
      fuelSourceNotice({
        available: ["propulsion.port.fuel.rate"],
        selected: ["propulsion.port.fuel.rate", "propulsion.engine.fuel.rate"],
      }),
    ).toBeNull();
  });

  it("explains an empty fuel figure when no selected engine reports", () => {
    expect(
      fuelSourceNotice({
        available: ["propulsion.port.fuel.rate"],
        selected: ["propulsion.engine.fuel.rate"],
      }),
    ).toBe("No fuel counted: Engine is selected but not reporting a rate.");
  });
});

describe("fuelSourceSummary", () => {
  it("reads All when every engine is counted", () => {
    expect(fuelSourceSummary({ available: ["propulsion.port.fuel.rate"], selected: [] })).toBe("All");
  });

  it("names a single narrowed engine", () => {
    expect(
      fuelSourceSummary({
        available: ["propulsion.port.fuel.rate", "propulsion.starboard.fuel.rate"],
        selected: ["propulsion.port.fuel.rate"],
      }),
    ).toBe("Port");
  });

  it("counts several", () => {
    expect(
      fuelSourceSummary({
        available: ["a.b.fuel.rate", "c.d.fuel.rate"],
        selected: ["a.b.fuel.rate", "c.d.fuel.rate"],
      }),
    ).toBe("2 engines");
  });

  // The affordance carries the diagnosis, because this is the state where the
  // voyage screen shows no fuel at all and the boat looks broken.
  it("says so when the narrowed engine has gone quiet", () => {
    expect(
      fuelSourceSummary({
        available: ["propulsion.port.fuel.rate"],
        selected: ["propulsion.engine.fuel.rate"],
      }),
    ).toBe("Engine · not reporting");
  });
});
