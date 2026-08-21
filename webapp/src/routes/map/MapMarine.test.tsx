/**
 * What the chart says when it cannot show the boat, and what the AIS switch says about what it
 * found.
 *
 * Both failures here were silences. With no fix the map opened on its default centre - a
 * stretch of water off Monaco - drew no vessel and explained nothing, so a reader could take
 * the empty chart for a broken map or, worse, for a boat that was actually there. And the
 * engine had been counting AIS targets and returning the number for as long as it had existed,
 * while the screen never asked: "AIS on, nothing within range" and "AIS on, four ships around
 * us" were the same button.
 *
 * The engine is stubbed because it owns a MapLibre instance and a WebGL context, neither of
 * which belongs in a headless suite; everything asserted below is the component's own.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Snapshot } from "../../lib/api";

const engine: {
  aisOn: boolean;
  aisCount: number;
  aisAvailable: boolean;
  latest: Snapshot | null;
  chartNote: string | null;
} = { aisOn: true, aisCount: 0, aisAvailable: true, latest: null, chartNote: null };

vi.mock("./useMapEngine", () => ({
  useMapEngine: () => ({
    containerRef: { current: null },
    aisOn: engine.aisOn,
    setAisOn: () => {},
    aisCount: engine.aisCount,
    aisAvailable: engine.aisAvailable,
    boatName: "Test",
    aisMaxNm: 12,
    setAisMaxNm: () => {},
    aisLimit: 50,
    setAisLimit: () => {},
    latest: engine.latest,
    chartNote: engine.chartNote,
    recenter: () => {},
  }),
}));

function fix(over: Partial<Snapshot> = {}): Snapshot {
  return {
    ts: 1_770_000_000_000,
    lat: 43.5, lon: 7.02, sog: 4.1, cog: 1.9,
    heading_mag: null, heading_true: 1.87, rate_of_turn: null,
    magnetic_variation: null, magnetic_deviation: null, nav_state: "under way using engine",
    wind_speed_apparent: null, wind_angle_apparent: null, wind_speed_true: null,
    wind_gust: null, wind_direction_true: null, air_temp_k: null,
    air_pressure_pa: null, depth: null, water_temp_k: null,
    gps_satellites: null, ais_class: null,
    ...over,
  } as Snapshot;
}

async function draw(state: Partial<typeof engine>): Promise<string> {
  Object.assign(
    engine,
    { aisOn: true, aisCount: 0, aisAvailable: true, latest: null, chartNote: null },
    state
  );
  const { default: MapMarine } = await import("./MapMarine");
  return renderToStaticMarkup(<MapMarine />);
}

describe("a chart that cannot place the boat", () => {
  it("says why, rather than showing empty water", async () => {
    const html = await draw({ latest: fix({ lat: null, lon: null }) });
    expect(html).toMatch(/Awaiting fix/i);
  });

  /**
   * Before the first frame the screen does not know whether there is a fix. "Awaiting fix" then
   * is a guess about a boat it has not heard from, and the difference matters: one is a GPS
   * problem, the other is a page that has not loaded.
   */
  it("holds its tongue until a frame has actually arrived", async () => {
    expect(await draw({ latest: null })).not.toMatch(/Awaiting fix/i);
  });

  it("says nothing about a fix once it has one", async () => {
    const html = await draw({ latest: fix() });
    expect(html).not.toMatch(/Awaiting fix/i);
    expect(html).toContain("43°30");
  });

  /**
   * No fix and no chart tiles are independent failures and can stand together. Reporting one
   * and hiding the other sends the reader after the wrong problem.
   */
  it("carries both notes at once when both are true", async () => {
    const html = await draw({
      latest: fix({ lat: null, lon: null }),
      chartNote: "Chart tiles unreachable - position and track only",
    });
    expect(html).toMatch(/Awaiting fix/i);
    expect(html).toMatch(/Chart tiles unreachable/i);
  });
});

describe("the AIS switch and what it found", () => {
  it("shows how many targets are in range", async () => {
    expect(await draw({ aisOn: true, aisCount: 4, latest: fix() })).toMatch(/AIS.*>4</s);
  });

  /** The silence that was on screen: AIS on, nothing found, and no way to know which. */
  it("shows a zero rather than leaving 'nothing in range' unsaid", async () => {
    expect(await draw({ aisOn: true, aisCount: 0, latest: fix() })).toMatch(/AIS.*>0</s);
  });

  /** A zero beside a switch that is off is the switch saying it is off twice. */
  it("shows no count while AIS is off", async () => {
    const html = await draw({ aisOn: false, aisCount: 0, latest: fix() });
    expect(html).toContain("AIS");
    expect(html).not.toMatch(/AIS.*>0</s);
  });

  /**
   * The switch was drawn on every boat, including ones with no AIS receiver at all, where it
   * could only ever say zero. Everywhere else this product refuses to draw a box for data the
   * boat does not send, and this was the exception.
   */
  it("offers no AIS controls on a boat that has never carried a receiver", async () => {
    const html = await draw({ aisAvailable: false, aisCount: 0, latest: fix() });
    // The switch itself, not the word: the stylesheet this screen inlines names AIS too.
    expect(html).not.toMatch(/>AIS</);
    expect(html).not.toContain("Range");
    expect(html).not.toContain("mp-ctrl");
  });

  /**
   * And the cure is not "hide it when the count is zero". A boat with a receiver and an empty
   * horizon reads zero too, and she is the one whose skipper reaches for the switch.
   */
  it("keeps them on a boat whose horizon is simply empty", async () => {
    const html = await draw({ aisAvailable: true, aisCount: 0, latest: fix() });
    expect(html).toMatch(/AIS.*>0</s);
    expect(html).toContain("Range");
  });
});
