/**
 * bridgeHasReading decides whether the bridge earns a section on the board. It is the same rule
 * the systems follow (drawn when reported, gone when not), applied to the bridge so a boat that
 * sends only an engine does not get an empty bridge above it. The failure it guards against is
 * quiet: a wrong answer here does not throw, it just paints a "no instruments, alongside" panel
 * over a boat whose engine is plainly running, so the reading set is pinned here.
 */
import { describe, expect, it } from "vitest";
import { bridgeHasReading, type BridgeData } from "./useBridgeData";

// Only the fields bridgeHasReading reads; the rest of BridgeData it ignores, so they stay off the
// fixture and the cast carries past them.
function bd(over: Record<string, unknown>): BridgeData {
  return {
    snap: null,
    sogKn: null,
    cogDeg: null,
    hdgTrue: null,
    twsKn: null,
    twdDeg: null,
    awaDeg: null,
    baroHPa: null,
    airC: null,
    waterC: null,
    depth: null,
    ...over,
  } as unknown as BridgeData;
}

describe("bridgeHasReading", () => {
  it("is false when the boat reports no nav or environment value", () => {
    expect(bridgeHasReading(bd({}))).toBe(false);
    // An engine-only snapshot carries system paths but none of the bridge's fields.
    expect(bridgeHasReading(bd({ snap: { paths: { "propulsion.port.revolutions": 25 } } }))).toBe(false);
  });

  it("is true on any single reading", () => {
    for (const field of [
      "sogKn",
      "cogDeg",
      "hdgTrue",
      "twsKn",
      "twdDeg",
      "awaDeg",
      "baroHPa",
      "airC",
      "waterC",
      "depth",
    ]) {
      expect(bridgeHasReading(bd({ [field]: 1 }))).toBe(true);
    }
  });

  it("reads position and nav state off the snapshot", () => {
    expect(bridgeHasReading(bd({ snap: { lat: 43.5 } }))).toBe(true);
    expect(bridgeHasReading(bd({ snap: { lon: 7.0 } }))).toBe(true);
    expect(bridgeHasReading(bd({ snap: { nav_state: "UNDERWAY" } }))).toBe(true);
  });
});
