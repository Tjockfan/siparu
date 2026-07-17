/**
 * The engine, generator and tank panels, drawn from whatever the boat is reporting.
 *
 * There is no layout here in the sense of a picture. The cells wrap: a boat with two gauges
 * gets two, a boat with thirty gets thirty, and neither is a case written down. That is not a
 * simplification, it is the requirement - some boats carry three engines, some carry one
 * generator and some carry none, and a screen that knows how many there are is a screen that is
 * wrong on the next boat.
 *
 * Flex rather than grid, and deliberately. Grid has no per-item grow, so when the number of
 * cells is not a multiple of the column count the tracks the last row does not fill show the
 * container behind them, which reads as a broken screen rather than as empty space. That was
 * measured on the shore's version and reverted there. Here the cells grow to fill their row.
 */
import { systemPanels, type SystemGauge } from "./useSystems";
import { ageOf } from "../../lib/age";
import type { LiveSnapshot } from "../../lib/api";

/** How stale a gauge has to be before the screen stops presenting it as current. */
const QUIET_AFTER_S = 90;

/**
 * How long a gauge has been quiet, in the panel's own voice.
 *
 * The tiers are in lib/age now, where the chart popup and the pairing band read them too:
 * this panel is where the floor and the day tier were worked out, and keeping them here
 * meant the other two screens went on answering the same question differently.
 *
 * Upper case, and the string carries it rather than a text-transform, which is what the
 * rest of swiss.css would do. Left as it is: the reserve this sits in was measured against
 * the widest string this returns, and moving the case into CSS is a change to that
 * measurement's terms rather than to the duplication this is fixing.
 */
export function quietFor(s: number): string {
  const { value, unit } = ageOf(s);
  return `${value} ${unit.toUpperCase()} AGO`;
}

function Cell({ g }: { g: SystemGauge }) {
  const quiet = g.ageS !== null && g.ageS >= QUIET_AFTER_S;
  return (
    <div className={`c sy-c${quiet ? " quiet" : ""}`}>
      <div className="t">
        {g.label}
        {g.sub !== null && (
          <>
            {" · "}
            <span className="sub">{g.sub}</span>
          </>
        )}
      </div>
      <div className="n sy-n">{g.value}</div>
      {/* An instrument that has gone quiet says so and keeps its last reading. Blanking it would
          throw away the only thing it knows, and a boat at anchor with a cold engine is not a
          fault. */}
      {quiet && <div className="sy-age">{quietFor(g.ageS!)}</div>}
    </div>
  );
}

export default function SystemsMarine({ snap, tab }: { snap: LiveSnapshot | null; tab: string }) {
  const panel = systemPanels(snap).find((p) => p.key === tab);

  // The tab row only offers a panel this boat has, so this is the case where she stopped
  // reporting between the row being drawn and this rendering: say so rather than draw nothing.
  if (!panel) {
    return (
      <div className="sy-wrap">
        <div className="sy-none">No readings from this system right now.</div>
      </div>
    );
  }

  return (
    <div className="sy-wrap">
      <div className="sy-grid">
        {panel.gauges.map((g) => (
          <Cell key={g.path} g={g} />
        ))}
      </div>
    </div>
  );
}
