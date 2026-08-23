/**
 * What the bridge says about a reading that has stopped arriving.
 *
 * The systems panel had this from the start: a gauge quiet past the threshold keeps its last
 * figure, loses its confidence and says when it last spoke. The bridge did not. It read one age
 * off the frame - the position's - and drew every other instrument as current, so a wind sensor
 * that died at breakfast still showed a crisp 12.4 knots at dinner. Nothing on the screen was
 * false and the whole screen was a lie, which is the worst failure this product has: a boat's
 * bridge is read to decide whether the water ahead is deep enough.
 *
 * These render the real cells rather than the helper behind them. A pure function that says
 * "quiet for two hours" and a panel that never asks it is exactly the shape of the dead depth
 * diagnosis this repo already carries, green at every assertion and invisible on the glass. So
 * the assertions here are made against markup: renderToStaticMarkup needs no DOM, and this suite
 * has none.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BridgeInstruments } from "./BridgeMarine";
import type { BridgeData } from "./useBridgeData";
import type { LiveSnapshot } from "../../lib/api";

const NOW = 1_770_000_000_000;

/**
 * A boat under way reporting a full bridge. `ts` is NOW, so the frame itself is current and the
 * only thing under test is the age of the individual readings inside it.
 */
function bridge(over: Partial<BridgeData> = {}, snapOver: Partial<LiveSnapshot> = {}): BridgeData {
  const snap = {
    ts: NOW,
    lat: 43.5,
    lon: 7.02,
    sog: 4.1,
    cog: 1.9,
    heading_true: 1.87,
    nav_state: "UNDERWAY",
    wind_speed_true: 6.4,
    wind_direction_true: 3.1,
    wind_angle_apparent: 0.7,
    air_temp_k: 295,
    air_pressure_pa: 101_300,
    water_temp_k: 292,
    depth: 18.2,
    depth_datum: "belowTransducer",
    field_ages: {},
    ...snapOver,
  } as unknown as LiveSnapshot;

  return {
    snap,
    now: NOW,
    ageSec: 2,
    frameAgeSec: 0,
    live: true,
    hasFix: true,
    hdgTrue: 107,
    sogKn: 8.0,
    cogDeg: 109,
    twsKn: 12.4,
    twdDeg: 178,
    awaDeg: 40,
    bft: 4,
    baroHPa: 1013,
    baroDelta: -0.4,
    airC: 21.9,
    waterC: 18.8,
    depth: 18.2,
    sealing: null,
    navState: "UNDERWAY",
    utcClock: "12:00:00",
    gustMax: null,
    gustHours: 6,
    setGustHours: () => {},
    gustSeries: [],
    baroSeries: [],
    ...over,
  } as unknown as BridgeData;
}

const draw = (d: BridgeData) => renderToStaticMarkup(<BridgeInstruments d={d} onBaro={() => {}} />);

/**
 * The depth cell follows the same rule as every other: drawn when the boat puts a value behind
 * it. It briefly had a second rule, for a micro-diagnosis that turned out to be unreachable
 * (see lib/depthDiag.ts). These pin what is left, including the case the diagnosis was written
 * for - a boat that has never reported a depth simply has no depth cell, which is the answer,
 * not a gap where an answer should be.
 */
describe("the depth cell", () => {
  it("draws the reading and the plane it was measured from", () => {
    const html = draw(bridge({ depth: 18.2 }));
    expect(html).toContain("c-depth");
    expect(html).toContain("18.2");
    expect(html).toContain("BELOW TRANSDUCER");
  });

  it("is not drawn at all on a boat that reports no depth", () => {
    const html = draw(bridge({ depth: null }));
    expect(html).not.toContain("c-depth");
  });

  /**
   * A sounder that stops is not a special case any more: it keeps its last reading and fades
   * like every other instrument, because the live frame holds the last known value and the
   * frame carries its age. This is the sentence the removed diagnosis was reaching for.
   */
  it("says when a stopped sounder last spoke, the same way every other cell does", () => {
    const html = draw(bridge({}, { field_ages: { depth: 7200 } }));
    expect(html).toContain("c-depth quiet");
    expect(html).toContain("18.2");
    expect(html).toContain("2 H AGO");
  });
});

describe("a bridge reading that has gone quiet", () => {
  it("says how long ago the instrument last spoke, and keeps the reading", () => {
    const html = draw(bridge({}, { field_ages: { wind_speed_true: 7200 } }));
    expect(html).toContain("2 H AGO");
    // The last figure stays. Blanking it throws away the only thing the boat knows, and a
    // sensor asleep at anchor is not a fault.
    expect(html).toContain("12.4");
  });

  it("marks the cell that went quiet and no other", () => {
    const html = draw(bridge({}, { field_ages: { wind_speed_true: 7200, depth: 3 } }));
    expect(html).toMatch(/class="c c-windtrue quiet"/);
    expect(html).toMatch(/class="c c-depth"/);
    expect(html).not.toMatch(/c-depth quiet/);
  });

  /**
   * Each instrument answers for itself. The frame is rebuilt on every poll whether or not
   * anything was measured, so a live GPS keeps the frame young while everything else on the bus
   * has stopped - which is precisely the case a per-field age exists to catch.
   */
  it("reads every core instrument's own age, not the position's", () => {
    const cases: [string, keyof NonNullable<LiveSnapshot["field_ages"]>, string][] = [
      ["c-sog", "sog", "8.0"],
      ["c-cog", "cog", "109"],
      ["c-hdg", "heading_true", "107"],
      ["c-windtrue", "wind_speed_true", "12.4"],
      ["c-windfrom", "wind_direction_true", "178"],
      ["c-awa", "wind_angle_apparent", "40"],
      ["c-baro", "air_pressure_pa", "1013"],
      ["c-air", "air_temp_k", "21.9"],
      ["c-sea", "water_temp_k", "18.8"],
      ["c-depth", "depth", "18.2"],
    ];
    for (const [cell, field, reading] of cases) {
      const html = draw(bridge({}, { field_ages: { [field]: 5400 } }));
      expect(html, `${cell} should fade when ${field} stops`).toContain(`${cell} quiet`);
      expect(html, `${cell} should keep its reading`).toContain(reading);
      expect(html, `${cell} should say when it last spoke`).toContain("1 H AGO");
    }
  });

  /**
   * The threshold from both sides, at the cell rather than in the helper: an off-by-one here is
   * a gauge that cries wolf on every frame that arrives a second late, and the sixty-second
   * standing cadence puts a great many frames near this line.
   */
  it("holds its tongue right up to the threshold", () => {
    expect(draw(bridge({}, { field_ages: { depth: 89 } }))).not.toContain("quiet");
    expect(draw(bridge({}, { field_ages: { depth: 90 } }))).toContain("c-depth quiet");
  });

  /**
   * An older plugin sends no ages at all. The screen it draws must be the screen it drew before
   * this mechanism existed - unqualified readings - rather than one that quietly promises every
   * gauge is current.
   */
  it("says nothing about a boat that sends no ages", () => {
    const html = draw(bridge({}, { field_ages: undefined }));
    expect(html).not.toContain("quiet");
    expect(html).not.toContain("AGO");
    expect(html).toContain("12.4");
  });

  /**
   * The other half of the same question, and the half that was missing.
   *
   * The ages inside a frame are measured aboard at the moment it is built, so they freeze the
   * instant frames stop arriving - and the poller deliberately keeps the last frame through a
   * failed fetch, and restores one from cache on load. A screen reading those ages alone tells
   * an owner his whole bridge is current over a boat that went off the air an hour ago. The
   * portal ashore has always added the frame's own age; this is the bridge doing the same.
   */
  it("ages every reading by the frame carrying it, so a frozen frame goes quiet", () => {
    const fresh = { wind_speed_true: 1, depth: 1, air_temp_k: 1 };
    expect(draw(bridge({ frameAgeSec: 2 }, { field_ages: fresh }))).not.toContain("quiet");
    const stale = draw(bridge({ frameAgeSec: 3600 }, { field_ages: fresh }));
    for (const cell of ["c-windtrue", "c-depth", "c-air"]) expect(stale).toContain(`${cell} quiet`);
    // The readings stay: an hour-old picture is still the last thing she said.
    expect(stale).toContain("12.4");
  });

  it("crosses the threshold on the sum, not on either half", () => {
    // Neither age reaches 90 alone; together they do.
    expect(draw(bridge({ frameAgeSec: 45 }, { field_ages: { depth: 44 } }))).not.toContain("quiet");
    expect(draw(bridge({ frameAgeSec: 45 }, { field_ages: { depth: 45 } }))).toContain("c-depth quiet");
  });

  /**
   * Baro is the one cell whose figure does not have to come from the frame: with no live
   * pressure path it falls back to the last hour of history. There is no age for that number,
   * and inventing one from the pressure field's absence would put an age on a figure it does
   * not describe.
   */
  it("leaves the barometer alone when its figure came from history", () => {
    const html = draw(bridge({ baroHPa: 1009 }, { air_pressure_pa: null, field_ages: { depth: 4 } }));
    expect(html).toContain("1009");
    expect(html).not.toContain("c-baro quiet");
  });
});

/**
 * The nav state is set to fit its cell rather than picked from a list of states someone
 * remembered to size. It used to be a table of three, each carrying a soft hyphen so it could
 * break in two on a phone; a state outside the table (Signal K's set is open, and a motor yacht
 * sends "motoring" all day) fell through to a bare overflow-wrap and broke mid-word as
 * "Motorin/g". The cell now gets the width the word needs and CSS sizes the type to it.
 */
describe("the nav state cell", () => {
  it("carries the width of its longest word, whatever state she sends", () => {
    expect(draw(bridge({ navState: "MOTORING" }))).toContain("--nav-w:8");
    expect(draw(bridge({ navState: "MOORED" }))).toContain("--nav-w:6");
  });

  it("measures the longest word, not the whole phrase, so a space can take the break", () => {
    // Two words: the line may break at the space, so only "command" has to fit.
    expect(draw(bridge({ navState: "NOT UNDER COMMAND" }))).toContain("--nav-w:7");
  });

  it("puts no break inside the word", () => {
    const html = draw(bridge({ navState: "MOTORING" }));
    expect(html).toContain("Motoring");
    expect(html).not.toContain("­"); // soft hyphen: the old table's break point
  });
});
