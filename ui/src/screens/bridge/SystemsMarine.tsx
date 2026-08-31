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
import {
  toSummary,
  type SystemCluster,
  type SystemGauge,
  type SystemMatrix,
  type SystemClusterPanel,
  type SystemSummary,
} from "./useSystems";
import { quietFor, quietSince } from "../../lib/age";

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
  const quiet = quietSince(g.ageS);
  return (
    <div className={`sm-cell${quiet !== null ? " quiet" : ""}`}>
      <span className="sm-v">{g.value}</span>
      {quiet !== null && <span className="sm-age">{quietFor(quiet)}</span>}
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
 * The glance: one line per engine or generator, the same three readings on each.
 *
 * What this replaces is a wall. Three engines reporting a dozen parameters each is 36 figures
 * at one weight, and an owner opening the screen to ask "is she running right" had to read all
 * of them to find out. The rest is not gone, it is behind the disclosure below - the matrix is
 * still the whole truth, and the readings that are not on this line are the ones nobody checks
 * first.
 *
 * A silent instance keeps its gap rather than borrowing a neighbour's figure, the same rule
 * the matrix follows.
 */
function SummaryRow({ label, cells, params }: { label: string; cells: (SystemGauge | undefined)[]; params: string[] }) {
  const t = tone(label);
  return (
    <div className="sms-row">
      <div className={`sms-l${t ? ` sm-${t}` : ""}`}>{headLabel(label)}</div>
      {cells.map((g, i) => {
        const quiet = g ? quietSince(g.ageS) : null;
        return (
          <div className={`sms-c${quiet !== null ? " quiet" : ""}`} key={params[i]}>
            {g ? (
              <>
                <span className="sms-v">{g.value}</span>
                <span className="sms-k">{params[i]}</span>
                {/* The parameter name stays: it is the only thing naming this column, and a
                    cell that swapped it for an age would leave the reader working out which
                    reading had gone quiet. The age goes underneath, as it does in the
                    matrix. */}
                {quiet !== null && <span className="sms-age">{quietFor(quiet)}</span>}
              </>
            ) : (
              /* This instance does not report this parameter. The column keeps its place so the
                 rows still read across, and nothing is invented to fill it. */
              <span className="sms-k" aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Summary({ s }: { s: SystemSummary }) {
  return (
    <>
      {/* The parameter count is the boat's, so it reaches CSS as a variable rather than a
          written-down number, exactly as the matrix column count does. */}
      <div className="sm-summary" style={{ "--sms-cols": s.params.length } as CSSProperties}>
        {s.rows.map((r) => (
          <SummaryRow key={r.label} label={r.label} cells={r.cells} params={s.params} />
        ))}
      </div>
      {/*
        Closed by default, and that is the point of the whole panel: the summary is what the
        screen answers with, the matrix is what it answers with when asked. A native disclosure
        rather than a state flag, because it comes with the keyboard and the screen reader
        already knowing what it is.
      */}
      {s.rest.rows.length > 0 && (
        <details className="sm-more">
          <summary>
            {s.rest.rows.length} more {s.rest.rows.length === 1 ? "reading" : "readings"}
          </summary>
          <Matrix m={s.rest} />
        </details>
      )}
    </>
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
  const quiet = quietSince(g.ageS);
  return (
    <div className={`tk${quiet !== null ? " quiet" : ""}${low ? " low" : ""}`}>
      <div className="tk-l">{g.label}</div>
      <div className="tk-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="tk-pct">{g.value}</div>
    </div>
  );
}

function Cell({ g }: { g: SystemGauge }) {
  const quiet = quietSince(g.ageS);
  return (
    <div className={`c sy-c${quiet !== null ? " quiet" : ""}`}>
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
      {quiet !== null && <div className="sy-age">{quietFor(quiet)}</div>}
    </div>
  );
}

function Panel({ p }: { p: SystemClusterPanel }) {
  // Tanks read as fill bars: a level is a proportion, and a bar shows it the way a figure alone
  // does not. Only the level metric (its sub is null - the label already says the tank) becomes a
  // bar; anything else a tank reports (a capacity, a temperature) keeps its cell, so no reading is
  // dropped on the way to the nicer shape. Engines and generators lead with the summary instead.
  if (p.key === "tanks") {
    const levels = p.gauges.filter((g) => g.sub === null);
    const rest = p.gauges.filter((g) => g.sub !== null);
    return (
      <>
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
      </>
    );
  }
  return <Summary s={toSummary(p.gauges)} />;
}

/**
 * One cluster of the boat's systems, under the heading a person reads it by.
 *
 * The badge is the reason the heading is more than a word. Most of what is under it is behind
 * the disclosure, so a gauge that stopped talking down there would have nobody to say so; the
 * count of quiet gauges is the one thing the heading knows that the readings on screen do not.
 * It says how many have gone silent and nothing about what any of them READS - that would need
 * thresholds, and none are invented here.
 */
export default function SystemsMarine({ cluster }: { cluster: SystemCluster }) {
  const quiet = cluster.quiet;
  return (
    <section className={`sp-sec sp-sec-${cluster.key}`}>
      <h2 className="sp-sec-h">
        <span className="sp-sec-n">{cluster.name}</span>
        {cluster.note && <span className="sp-sec-note">{cluster.note}</span>}
        <span className={`sp-sec-badge${quiet > 0 ? " quiet" : ""}`}>
          {quiet > 0 ? `${quiet} quiet` : "All reporting"}
        </span>
      </h2>
      <div className="sy-wrap">
        {cluster.panels.map((p) => (
          <Fragment key={p.key}>
            {/* Named only where the cluster holds more than one kind: on a boat with engines and
                generators the two blocks have to be told apart, and on one with engines alone the
                heading above has already counted them. */}
            {cluster.panels.length > 1 && <div className="sy-sub">{p.note}</div>}
            <Panel p={p} />
          </Fragment>
        ))}
      </div>
    </section>
  );
}
