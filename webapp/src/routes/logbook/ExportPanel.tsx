/**
 * The window a reader takes away with him: which days, at what interval, and in which of the
 * two things a log can be once it leaves the screen.
 *
 * A panel over the table rather than a dialog, the same shape the column picker takes and for
 * the same reason: on a phone this is the whole screen's business for a moment, and a floating
 * layer over a table that scrolls is a fight nobody wins.
 *
 * Two verbs, because they are two different intentions and a reader knows which one he has.
 * View puts the window on the screen he is already looking at, where he can read it, scroll it
 * and change his mind about the columns. Save writes it out. Neither is a preview of the other:
 * what View draws and what Save writes are the same rows, drawn by the same table.
 *
 * The format decides what Save means, and the difference is worth stating plainly because it is
 * visible to the reader. CSV is a file, made here and handed to the browser. PDF is the page
 * itself, handed to the printer that every browser has and that every one of them can write to
 * a PDF; the stylesheet already dresses this app for paper. Carrying a PDF engine in the bundle
 * to do the same job a second time is a quarter of a megabyte for a page printed twice a
 * season, and it would be a second layout to keep in step with the table.
 */
import { useState } from "react";
import { dateToInput } from "../../lib/format";
import { STAT_LABEL, type Stat } from "../../lib/buckets";
import { INTERVAL_NAME, type Granularity } from "./useLogbookData";

export type ExportFormat = "csv" | "pdf";

/** How a PDF page is dressed: the screen's own dark ink, or white for a printer. */
export type PdfStyle = "screen" | "paper";

const GRANS: Granularity[] = ["1m", "1h", "6h", "1d"];

const FORMATS: { v: ExportFormat; name: string; note: string }[] = [
  { v: "csv", name: "CSV", note: "a file for a spreadsheet" },
  { v: "pdf", name: "PDF", note: "the page, through your printer" },
];

const STYLES: { v: PdfStyle; name: string }[] = [
  { v: "screen", name: "Screen" },
  { v: "paper", name: "Paper" },
];

/**
 * What each row of the file carries.
 *
 * A logbook page holds the reading that stood when the hour closed, and for a hundred years
 * that was the record because a mate wrote it down once an hour. The boat does better: she
 * summarises every hour she keeps - the mean of its samples, the extremes it reached, how far
 * she ran - and until this panel offered them, none of it left her. A reader working out a
 * season's fuel curve or the sea state she actually met needs the summary, not one reading in
 * sixty.
 *
 * Last stays the default, because it is what the file has always held and what the table
 * beside it shows.
 */
const FIGURES: Stat[] = ["last", "avg", "min", "max"];

/**
 * How many figures a destination can hold, in the two places that have to agree about it.
 *
 * A file holds as many as the reader ticks: one block of columns each, side by side. A page
 * holds one, because a page is one table and a table cell is one number. Both rules are here
 * rather than inline because they are the same rule read twice - once when a chip is pressed
 * and once when the request leaves - and a panel that lights two chips and exports one, or
 * lights one and exports two, is lying in one direction or the other.
 */
export function toggleFigure(format: ExportFormat, current: Stat[], pressed: Stat): Stat[] {
  if (format === "pdf") return [pressed];
  return current.includes(pressed) ? current.filter((s) => s !== pressed) : [...current, pressed];
}

/**
 * The figures that actually leave this panel. A reader who ticked Average and Maximum for a
 * file and then asked for a page would otherwise hand the page two, and the page would quietly
 * draw the first of them without saying which it chose.
 */
export function figuresFor(format: ExportFormat, stats: Stat[]): Stat[] {
  return format === "pdf" ? [stats[0] ?? "last"] : stats;
}

/** A week back, which is the window somebody opens this to look at without saying so. */
function weekAgo(): string {
  return dateToInput(new Date(Date.now() - 7 * 86400_000));
}

export interface ExportRequest {
  from: string;
  to: string;
  gran: Granularity;
  format: ExportFormat;
  /** Which figures of each window go in the file. Empty is refused, not silently defaulted. */
  stats: Stat[];
  /** The window's own numbers rather than a reading: how far she ran, how many samples. */
  distance: boolean;
  samples: boolean;
  /** PDF only: which of the two dresses the page wears. CSV carries no ink to choose. */
  style: PdfStyle;
}

export default function ExportPanel({
  initial,
  onView,
  onSave,
  onCancel,
}: {
  initial?: Partial<ExportRequest>;
  onView: (r: ExportRequest) => void;
  onSave: (r: ExportRequest) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState(initial?.from ?? weekAgo());
  const [to, setTo] = useState(initial?.to ?? dateToInput());
  const [gran, setGran] = useState<Granularity>(initial?.gran ?? "1h");
  const [format, setFormat] = useState<ExportFormat>(initial?.format ?? "csv");
  const [stats, setStats] = useState<Stat[]>(initial?.stats ?? ["last"]);
  const [distance, setDistance] = useState(initial?.distance ?? false);
  const [samples, setSamples] = useState(initial?.samples ?? false);
  const [style, setStyle] = useState<PdfStyle>(initial?.style ?? "screen");

  // A window that ends before it begins is the one mistake two date fields make on their own,
  // and it is worth catching here rather than as an empty table: an empty table is what a quiet
  // week looks like too, and the reader cannot tell the two apart.
  const backwards = to < from;
  const req: ExportRequest = {
    from, to, gran, format,
    stats: figuresFor(format, stats),
    distance, samples, style,
  };

  // A minute is a sample, not a window: it has no mean and no extremes, so at that interval
  // there is nothing to choose and the choice is not shown.
  const summarised = gran !== "1m";
  // A file can hold four figures side by side, a block of columns each. A page cannot: it is
  // one table, and a table cell holds one number. So the page takes one figure and the file
  // takes as many as the reader wants - and the figures themselves are the same figures, read
  // out of the same summaries the boat keeps.
  const oneFigure = format === "pdf";
  // Nothing to put in the rows. Held rather than written, for the same reason a backwards
  // window is: a file of timestamps and nothing else is not what anybody pressed this for.
  const empty = summarised && !oneFigure && stats.length === 0 && !distance && !samples;
  const toggle = (v: Stat) => setStats((cur) => toggleFigure(format, cur, v));
  // What is lit is what would leave: a page lights the one figure it would carry, even when
  // the reader ticked several for a file before switching.
  const leaving = figuresFor(format, stats);
  const chosen = (v: Stat) => leaving.includes(v);

  return (
    <div className="lb-pick lb-exp">
      <div className="lbp-books">
        <div className="lbp-book">
          <div className="lbp-h">
            <span className="lbp-n">Window</span>
            <span className="lbp-s">local days, both ends included</span>
          </div>
          <div className="lbe-dates">
            <label>
              <span>From</span>
              <input
                type="date"
                className="dt"
                value={from}
                max={dateToInput()}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              <span>To</span>
              <input
                type="date"
                className="dt"
                value={to}
                max={dateToInput()}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
        </div>
        <div className="lbp-book">
          <div className="lbp-h">
            <span className="lbp-n">Interval</span>
            <span className="lbp-s">one row per</span>
          </div>
          <div className="lbp-chips">
            {GRANS.map((g) => (
              <button
                key={g}
                className={`lbp-c${gran === g ? " on" : ""}`}
                onClick={() => setGran(g)}
              >
                {INTERVAL_NAME[g]}
              </button>
            ))}
          </div>
        </div>
        <div className="lbp-book">
          <div className="lbp-h">
            <span className="lbp-n">Save as</span>
            <span className="lbp-s">{FORMATS.find((f) => f.v === format)?.note}</span>
          </div>
          <div className="lbp-chips">
            {FORMATS.map((f) => (
              <button
                key={f.v}
                className={`lbp-c${format === f.v ? " on" : ""}`}
                onClick={() => setFormat(f.v)}
              >
                {f.name}
              </button>
            ))}
          </div>
        </div>
        {format === "pdf" && (
          <div className="lbp-book">
            <div className="lbp-h">
              <span className="lbp-n">Style</span>
              <span className="lbp-s">
                {style === "screen" ? "the app's own dark ink" : "white, for a printer"}
              </span>
            </div>
            <div className="lbp-chips">
              {STYLES.map((s) => (
                <button
                  key={s.v}
                  className={`lbp-c${style === s.v ? " on" : ""}`}
                  onClick={() => setStyle(s.v)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {summarised && (
        <div className="lbp-book lbp-figs">
          <div className="lbp-h">
            <span className="lbp-n">Figures</span>
            {/* The same chips take one press or several depending on where the figures are
                going, and nothing in a chip says which. The line beside the heading does. */}
            <span className="lbp-s">
              {oneFigure ? "one: a table cell holds one number" : "one or more: a column each"}
            </span>
          </div>
          <div className="lbp-chips">
            {FIGURES.map((f) => (
              <button
                key={f}
                className={`lbp-c${chosen(f) ? " on" : ""}`}
                onClick={() => toggle(f)}
              >
                {STAT_LABEL[f]}
              </button>
            ))}
            {/* A window's own numbers, not a reading of it. They are columns in a file; on the
                page the masthead and the band already say what window this is. */}
            {!oneFigure && (
              <>
                <button
                  className={`lbp-c${distance ? " on" : ""}`}
                  onClick={() => setDistance(!distance)}
                >
                  Distance
                </button>
                <button
                  className={`lbp-c${samples ? " on" : ""}`}
                  onClick={() => setSamples(!samples)}
                >
                  Samples
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {backwards && <div className="lbe-warn">That window ends before it begins.</div>}
      {empty && <div className="lbe-warn">Choose at least one figure to put in the file.</div>}
      <div className="lbp-act">
        <button onClick={onCancel}>Cancel</button>
        <button disabled={backwards} onClick={() => onView(req)}>
          View
        </button>
        <button className="lbp-go" disabled={backwards || empty} onClick={() => onSave(req)}>
          Save {format.toUpperCase()}
        </button>
      </div>
    </div>
  );
}
