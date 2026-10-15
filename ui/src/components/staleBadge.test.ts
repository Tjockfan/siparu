import { describe, expect, it } from "vitest";
import { joinBase } from "../data/routes";
import { liveRouteOf, STALE_AFTER_MS, staleOn } from "./staleBadge";

/**
 * The badge on the chart. It was computed for the telemetry screen alone, so the chart said
 * LIVE for as long as it stayed open, boat off or not. The rule is judged here on its own:
 * each live screen against its own poll, the chart against the freshest of its two feeds.
 */
const NOW = 1_000_000;
// The join the shell really uses: under a base the root is the base itself, no trailing slash.
const at = (p: string) => joinBase("/boats/b1", p);

describe("which screens carry the badge", () => {
  it("names the two live screens and nothing else", () => {
    expect(liveRouteOf("/boats/b1", at)).toBe("/");
    expect(liveRouteOf("/boats/b1/map", at)).toBe("/map");
    expect(liveRouteOf("/boats/b1/logbook", at)).toBeNull();
    expect(liveRouteOf("/boats/b1/map/x", at)).toBeNull();
  });

  it("names them at the root too, where the boat's own display runs", () => {
    const root = (p: string) => joinBase("", p);
    expect(liveRouteOf("/", root)).toBe("/");
    expect(liveRouteOf("/map", root)).toBe("/map");
  });
});

describe("the telemetry screen", () => {
  it("goes stale ten seconds after the last successful poll", () => {
    expect(staleOn("/", NOW, NOW - 9_000, null)).toBe(false);
    expect(staleOn("/", NOW, NOW - 11_000, null)).toBe(true);
  });

  it("is not stale before anything was fetched", () => {
    expect(staleOn("/", NOW, null, null)).toBe(false);
  });

  it("is judged by its own poll, not by the map's", () => {
    expect(staleOn("/", NOW, NOW - 11_000, NOW)).toBe(true);
  });
});

describe("the chart", () => {
  it("goes stale when both of its feeds have missed two and a half polls", () => {
    const old = NOW - STALE_AFTER_MS["/map"] - 1;
    expect(staleOn("/map", NOW, old, old)).toBe(true);
    // The threshold itself is not yet stale: the line sits where the comment says it does.
    const edge = NOW - STALE_AFTER_MS["/map"];
    expect(staleOn("/map", NOW, edge, edge)).toBe(false);
    expect(STALE_AFTER_MS["/map"]).toBe(75_000);
    expect(staleOn("/map", NOW, old, NOW - 30_000)).toBe(false);
    expect(staleOn("/map", NOW, NOW - 30_000, old)).toBe(false);
  });

  it("does not go stale at the telemetry screen's ten seconds, which its own poll cannot keep", () => {
    expect(staleOn("/map", NOW, NOW - 40_000, NOW - 40_000)).toBe(false);
  });

  it("reads whichever feed has answered when the other never has", () => {
    const old = NOW - STALE_AFTER_MS["/map"] - 1;
    expect(staleOn("/map", NOW, null, old)).toBe(true);
    expect(staleOn("/map", NOW, old, null)).toBe(true);
    expect(staleOn("/map", NOW, null, null)).toBe(false);
  });
});

describe("every other screen", () => {
  it("never shows the badge as stale", () => {
    expect(staleOn(null, NOW, 0, 0)).toBe(false);
  });
});
