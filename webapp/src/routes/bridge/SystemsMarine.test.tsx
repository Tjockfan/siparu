/**
 * What an engine panel answers with before it is asked anything.
 *
 * The matrix that used to be the whole panel is not wrong, it is just not an answer: three
 * engines reporting a dozen parameters each is 36 figures at one weight, and the question an
 * owner opens this screen with ("is she running right") had to be assembled out of all of
 * them. These pin the shape that replaced it - a line per unit, the rest behind a
 * disclosure - and, more importantly, the two ways that shape could quietly go wrong: the
 * summary showing a boat readings she does not report, and the disclosure claiming a number
 * of hidden readings that is not what it opens.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SystemsMarine from "./SystemsMarine";
import { systemClusters } from "./useSystems";
import type { LiveSnapshot } from "../../lib/api";

const draw = (
  paths: Record<string, number>,
  cluster: "machinery" | "tanks" = "machinery",
  ages?: Record<string, number>
) => {
  const c = systemClusters({ paths, path_ages: ages } as unknown as LiveSnapshot).find(
    (x) => x.key === cluster
  );
  if (!c) throw new Error(`no ${cluster} cluster in this frame`);
  return renderToStaticMarkup(<SystemsMarine cluster={c} />);
};

/** A three-engine boat reporting five parameters each. */
const THREE_ENGINES: Record<string, number> = {};
for (const [id, rpm] of [
  ["port", 26.0],
  ["center", 26.1],
  ["starboard", 25.9],
] as const) {
  THREE_ENGINES[`propulsion.${id}.revolutions`] = rpm;
  THREE_ENGINES[`propulsion.${id}.temperature`] = 355.15;
  THREE_ENGINES[`propulsion.${id}.oilPressure`] = 420000;
  THREE_ENGINES[`propulsion.${id}.engineLoad`] = 0.63;
  THREE_ENGINES[`propulsion.${id}.runTime`] = 4312800;
}

describe("the engine panel", () => {
  it("leads with one line per engine", () => {
    const html = draw(THREE_ENGINES);
    // As the panel writes them; the uppercase is the stylesheet's doing, not the markup's.
    for (const label of ["Port", "Center", "Stbd"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("1560 rpm");
    expect(html).toContain("82.0 °C");
    expect(html).toContain("4.2 bar");
  });

  it("keeps the rest closed, and says how many it is holding", () => {
    const html = draw(THREE_ENGINES);
    // Two parameters are not on the summary lines, and the disclosure says so in those words.
    expect(html).toMatch(/2 more readings/);
    // Closed: the summary IS the answer. A <details> with no open attribute is shut.
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it("opens onto exactly what it said it was holding, and nothing it already showed", () => {
    const html = draw(THREE_ENGINES);
    const inside = html.slice(html.indexOf("<details"));
    expect(inside).toContain("Engine load");
    expect(inside).toContain("Run time");
    // The three on the summary lines are not repeated underneath: that repetition is what
    // made "2 more readings" open a table of five.
    expect(inside).not.toContain("Oil pressure");
  });

  /** The rule the whole screen keeps: a reading the boat does not send is not drawn. */
  it("draws no disclosure for a boat with nothing more to say", () => {
    const html = draw({
      "propulsion.port.revolutions": 26.0,
      "propulsion.port.temperature": 355.15,
    });
    expect(html).toContain("1560 rpm");
    expect(html).not.toContain("more readings");
    expect(html).not.toContain("<details");
  });

  /**
   * A gauge that has stopped talking keeps its last figure and says how long ago it spoke, the
   * same as every cell on the bridge. What it must not do is drop the parameter name to make
   * room: it is the only thing naming that column.
   */
  it("marks a quiet reading without giving up what it reads", () => {
    const html = draw(
      {
        "propulsion.port.revolutions": 26.0,
        "propulsion.port.temperature": 355.15,
        "propulsion.port.oilPressure": 420000,
      },
      "machinery",
      { "propulsion.port.temperature": 300 }
    );
    expect(html).toContain("82.0 °C");
    expect(html).toContain("Temperature");
    expect(html).toContain("5 MIN AGO");
    // Only the gauge that went quiet is marked.
    expect(html.match(/sms-c quiet/g) ?? []).toHaveLength(1);
  });
});

describe("the cluster heading", () => {
  it("names the cluster and counts what she carries", () => {
    const html = draw({
      "propulsion.port.revolutions": 26.0,
      "propulsion.starboard.revolutions": 25.9,
      "electrical.generators.0.voltage": 230.1,
    });
    expect(html).toContain(">Machinery<");
    // Counted on the blocks, since this cluster holds two kinds.
    expect(html).toContain(">2 engines<");
    expect(html).toContain(">1 generator<");
  });

  /**
   * The badge exists because the disclosure hides most of the readings: a gauge that stopped
   * talking down there has nobody else to say so.
   */
  it("says all is reporting, and says how many are not", () => {
    const fresh = draw(
      { "propulsion.port.revolutions": 26.0 },
      "machinery",
      { "propulsion.port.revolutions": 2 }
    );
    expect(fresh).toContain("All reporting");
    expect(fresh).not.toContain("sp-sec-badge quiet");

    const stale = draw(
      { "propulsion.port.revolutions": 26.0, "propulsion.port.temperature": 355.15 },
      "machinery",
      { "propulsion.port.revolutions": 400, "propulsion.port.temperature": 2 }
    );
    expect(stale).toContain("1 quiet");
    expect(stale).toContain("sp-sec-badge quiet");
  });

  /** Two kinds under one heading have to be told apart; one kind has already been named. */
  it("names the blocks only where the cluster holds more than one kind", () => {
    const both = draw({
      "propulsion.port.revolutions": 26.0,
      "electrical.generators.0.voltage": 230.1,
    });
    expect(both).toContain('class="sy-sub">1 engine<');
    expect(both).toContain('class="sy-sub">1 generator<');

    // One kind: the heading has already counted them and there is nothing to tell apart.
    const engineOnly = draw({ "propulsion.port.revolutions": 26.0 });
    expect(engineOnly).not.toContain("sy-sub");
    expect(engineOnly).toContain('class="sp-sec-note">1 engine<');
  });
});

describe("the generator panel", () => {
  it("reads a generator by volts and amps rather than an engine's three", () => {
    const html = draw(
      {
        "electrical.generators.0.revolutions": 25.0,
        "electrical.generators.0.voltage": 230.1,
        "electrical.generators.0.current": 23.4,
        "electrical.generators.0.runTime": 1206000,
      },
      "machinery"
    );
    expect(html).toContain("Voltage");
    expect(html).toContain("Current");
    expect(html).toMatch(/1 more reading[^s]/);
  });
});
