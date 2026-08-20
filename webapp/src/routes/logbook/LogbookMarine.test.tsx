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

vi.mock("./useLogbookData", () => ({
  ROWS_LIMIT: { "1m": 60, "1h": 48, "6h": 40, "1d": 30 },
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

async function draw(rows: Snapshot[]): Promise<string> {
  page.length = 0;
  page.push(...rows);
  const { default: LogbookMarine } = await import("./LogbookMarine");
  return renderToStaticMarkup(<LogbookMarine />);
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
