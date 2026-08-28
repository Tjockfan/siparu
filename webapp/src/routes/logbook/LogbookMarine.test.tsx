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
import type { Snapshot } from "../../lib/api";

const page: Snapshot[] = [];

// The hooks are replaced; everything else in that module is kept. A mock that listed the
// module's constants by hand held a second copy of each one, and the copy went stale the day
// the screen started reading a new one: the suite failed on a missing export rather than on
// anything about the table. What this file is here to stand in for is the fetching, and that
// is all it stands in for.
vi.mock("./useLogbookData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useLogbookData")>()),
  useLogbookLive: () => ({
    granularity: "1h",
    changeGran: () => {},
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
    expect(bridge).not.toContain("P RPM");

    const engine = await draw(rows, "engine");
    expect(engine).toContain("P RPM");
    expect(engine).toContain("1530");
    expect(engine).not.toContain("SOG");
    expect(engine).not.toContain("DEP");
    // The hour belongs to both: an engineer's page of bare numbers is not a log.
    expect(engine).toContain("UTC");
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
