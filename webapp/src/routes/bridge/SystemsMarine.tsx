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
import { Fragment, type CSSProperties } from "react";
import { systemPanels, toMatrix, type SystemGauge, type SystemMatrix } from "./useSystems";
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

/**
 * The running-light side an instance column takes its header colour from, or none.
 *
 * Read off the label the plugin already worked out ("Port", "Starboard", "Center"), not off the
 * path: the colour is a rendering choice and stays on this side, while units.ts stays about what
 * a gauge is. A generator or any instance that is not a side gets no colour, which is correct -
 * there is no port generator.
 */
function tone(label: string): "port" | "stbd" | "center" | "" {
  const l = label.toLowerCase();
  if (l === "port") return "port";
  if (l === "starboard" || l === "stbd") return "stbd";
  if (l === "center" || l === "centre") return "center";
  return "";
}

/**
 * The column header, shortened to what fits a narrow column without clipping.
 *
 * "Starboard" and "Generator 1" run past a phone column and get cut; the sea's own abbreviations
 * ("Stbd", "Gen 1") do not, and they are what a helm label says anyway. The full name stays on
 * the gauge itself (describePath, units.ts) - this is only how it is drawn in a heading.
 */
function headLabel(label: string): string {
  if (/^starboard$/i.test(label)) return "Stbd";
  return label.replace(/^Generator /i, "Gen ");
}

function MatrixCell({ g }: { g: SystemGauge | undefined }) {
  // A column silent on this parameter shows an empty square, not an invented reading.
  if (!g) return <div className="sm-cell sm-empty" aria-hidden="true" />;
  const quiet = g.ageS !== null && g.ageS >= QUIET_AFTER_S;
  return (
    <div className={`sm-cell${quiet ? " quiet" : ""}`}>
      <span className="sm-v">{g.value}</span>
      {quiet && <span className="sm-age">{quietFor(g.ageS!)}</span>}
    </div>
  );
}

function Matrix({ m }: { m: SystemMatrix }) {
  // The column count is the boat's, so it is handed to CSS as a variable rather than baked into an
  // inline template: the phone lets the tracks share the width (1fr) while the wide board sizes the
  // matrix to its content, and an inline grid-template would win over both. The label rail is auto
  // so a long parameter name is not clipped by a fixed width.
  return (
    <div className="sm-matrix" style={{ "--sm-cols": m.cols.length } as CSSProperties}>
      <div className="sm-corner" aria-hidden="true" />
      {m.cols.map((c) => {
        const t = tone(c);
        return (
          <div key={c} className={`sm-head${t ? ` sm-${t}` : ""}`}>
            {headLabel(c)}
          </div>
        );
      })}
      {m.rows.map((r) => (
        <Fragment key={r.sub}>
          <div className="sm-rl">{r.sub}</div>
          {m.cols.map((c) => (
            <MatrixCell key={c} g={r.cells[c]} />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * A tank as a fill bar and its percentage, the shape a level is read in.
 *
 * The width comes off the same string the cell would print ("74%"), so the bar and the figure
 * cannot disagree - there is one number. A fuel tank running low takes the accent, because range
 * is the reading a motorboat owner acts on; the other families (fresh, waste, lube) stay neutral,
 * since a low grey-water tank is good news and colouring it red would teach the crew to ignore
 * red. A tank that has gone quiet keeps its last level and loses its confidence, like every other
 * gauge.
 */
function TankBar({ g }: { g: SystemGauge }) {
  const n = parseFloat(g.value);
  const known = Number.isFinite(n);
  const pct = known ? Math.max(0, Math.min(100, n)) : 0;
  // A tank with no reading ("·") is not a low tank: only accent a fuel level we actually have,
  // or an absent gauge would light the low-fuel red on an empty bar.
  const low = known && g.path.includes(".fuel.") && pct < 20;
  const quiet = g.ageS !== null && g.ageS >= QUIET_AFTER_S;
  return (
    <div className={`tk${quiet ? " quiet" : ""}${low ? " low" : ""}`}>
      <div className="tk-l">{g.label}</div>
      <div className="tk-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="tk-pct">{g.value}</div>
    </div>
  );
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

  // Tanks read as fill bars: a level is a proportion, and a bar shows it the way a figure alone
  // does not. Only the level metric (its sub is null - the label already says the tank) becomes a
  // bar; anything else a tank reports (a capacity, a temperature) keeps its cell, so no reading is
  // dropped on the way to the nicer shape. Engines and generators pivot to the matrix instead.
  if (panel.key === "tanks") {
    const levels = panel.gauges.filter((g) => g.sub === null);
    const rest = panel.gauges.filter((g) => g.sub !== null);
    return (
      <div className="sy-wrap">
        {levels.length > 0 && (
          <div className="tk-list">
            {levels.map((g) => (
              <TankBar key={g.path} g={g} />
            ))}
          </div>
        )}
        {rest.length > 0 && (
          <div className="sy-grid">
            {rest.map((g) => (
              <Cell key={g.path} g={g} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="sy-wrap">
      <Matrix m={toMatrix(panel.gauges)} />
    </div>
  );
}
