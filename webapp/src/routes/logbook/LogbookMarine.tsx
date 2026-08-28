/* Logbook - snapshot history (Swiss redesign).
 * Brutalist data table: Live|Day + granularity, UTC·SOG·HDG·TWS·BARO·DEP rows.
 * Data flow (useLogbookLive / useLogbookDay) preserved; only the presentation changed. */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, type Snapshot } from "../../lib/api";
import { bucketsCsv, downloadText, exportFilename, snapshotsCsv } from "../../lib/export";
import { bucketHours, bucketRow, type BucketGran } from "../../lib/buckets";
import { dateInputToMs, dateToInput } from "../../lib/format";
import { useElementWidth } from "../../lib/useElementWidth";
import ColumnPicker from "./ColumnPicker";
import ExportPanel, { type ExportRequest } from "./ExportPanel";
import Reveal from "./Reveal";
import { logbookColumns, type LogColumn, type WindUnit } from "./columns";
import { fittedColumns, lanesThatFit } from "./fitColumns";
import {
  loadSelection,
  saveSelection,
  visibleColumns,
  type ColumnSelection,
} from "./columnSelection";
import {
  useLogbookLive,
  useLogbookDay,
  useLogbookRange,
  INTERVAL_NAME,
  RANGE_LIMIT,
  ROWS_LIMIT,
  type Granularity,
  type Mode,
} from "./useLogbookData";

const GRANS: Granularity[] = ["1m", "1h", "6h", "1d"];
const GRAN_LABEL: Record<Granularity, string> = {
  "1m": "Last hour",
  "1h": "Last 2 days",
  "6h": "Last 10 days",
  "1d": "Last month",
};

export default function LogbookMarine() {
  const [mode, setMode] = useState<Mode>("live");
  // Wind unit: knots <-> Beaufort. Toggles on header tap, the selection persists.
  const [windUnit, setWindUnit] = useState<WindUnit>(
    () => (localStorage.getItem("lb:windUnit") as WindUnit) || "kn",
  );
  const toggleWind = () =>
    setWindUnit((u) => {
      const n: WindUnit = u === "kn" ? "bft" : "kn";
      localStorage.setItem("lb:windUnit", n);
      return n;
    });

  // Which columns are drawn, and the panel that changes them. Held here rather than in each
  // view so switching Live/Day does not reopen the picker or forget the choice.
  const [selection, setSelection] = useState<ColumnSelection>(loadSelection);
  const [picking, setPicking] = useState(false);
  const applySelection = (sel: ColumnSelection) => {
    setSelection(sel);
    saveSelection(sel);
    setPicking(false);
  };

  // What the table has to lay out in. Measured rather than assumed, because the same screen is
  // read on a phone and beside a chart table, and the number of columns that can be read at
  // once is the one thing that genuinely differs between them.
  const [tableRef, width] = useElementWidth<HTMLDivElement>();

  // The window a reader asked for, the panel that asks for it, and whether one of them is on
  // its way to the printer. The request outlives the panel: it is what the range view draws,
  // and reopening the panel starts from what he chose last rather than from a week ago again.
  const [exporting, setExporting] = useState(false);
  const [request, setRequest] = useState<ExportRequest | null>(null);
  const [printing, setPrinting] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // The panel stays open. View is the verb a reader presses more than once - a week at six
  // hours, then the same week daily, then a narrower window - and closing the panel each time
  // made him reopen it and re-enter what he had just chosen. Save closes it, because saving is
  // the end of the errand.
  const onView = (r: ExportRequest) => {
    setRequest(r);
    setMode("range");
    setSaveErr(null);
  };

  /**
   * Saving, which is two different acts behind one button.
   *
   * PDF goes through the range view: the page IS the document, so the rows have to be on the
   * screen before the printer is called. The view fetches them and calls print itself once
   * they are there (see RangeView), which is also why the reader sees what he is about to get.
   *
   * CSV does not need the screen and does not touch it. It asks for the window directly and
   * hands the file over, so a reader can take a month of minutes away without waiting for a
   * month of minutes to be drawn. What goes in it is every column he has turned on, not the
   * ones this screen has room for: the narrow screen holds columns back (fitColumns), and a
   * file that quietly did the same would be a different document on a phone.
   */
  const onSave = async (r: ExportRequest) => {
    setExporting(false);
    setSaveErr(null);
    if (r.format === "pdf") {
      setRequest(r);
      setMode("range");
      setPrinting(true);
      return;
    }
    try {
      const from = dateInputToMs(r.from);
      const to = dateInputToMs(r.to) + 86400_000 - 1;
      if (r.gran === "1m") {
        // A minute is the sample itself. There is nothing to summarise and no window to carry
        // a distance, so this is the page as it stands - the boat's own record, as far back as
        // she still keeps it, and her hourly summary for whatever lies before that.
        const { rows } = await api.logbook.minutes({
          from,
          to,
          limit: RANGE_LIMIT,
          order: "desc",
        });
        const cols = visibleColumns(logbookColumns(rows, windUnit), selection);
        downloadText(exportFilename("logbook", from, "csv"), "text/csv", snapshotsCsv(rows, cols));
        return;
      }
      // The boat's own summaries, one block of columns per figure asked for. Each block
      // derives its columns from its own rows, which is what drops the ones that cannot carry
      // that figure - there is no mean of a heading, so no HDG column in the block of means.
      const hours = await api.logbook.rollupHours(from, to);
      const buckets = bucketHours(hours, r.gran as BucketGran);
      const blocks = r.stats
        .map((stat) => ({
          stat,
          cols: visibleColumns(logbookColumns(buckets.map((b) => bucketRow(b, stat)), windUnit), selection),
        }))
        .filter((b) => b.cols.length > 1);
      downloadText(
        exportFilename("logbook", from, "csv"),
        "text/csv",
        bucketsCsv(buckets, blocks, { distance: r.distance, samples: r.samples }),
      );
    } catch (e) {
      setSaveErr((e as Error).message);
    }
  };

  const shared = {
    mode,
    setMode,
    windUnit,
    toggleWind,
    selection,
    picking,
    setPicking,
    applySelection,
    width,
    exporting,
    setExporting,
    request,
    onView,
    onSave,
    saveErr,
  };
  return (
    <div className="lb" ref={tableRef}>
      {mode === "live" ? (
        <LiveView {...shared} />
      ) : mode === "day" ? (
        <DayView {...shared} />
      ) : (
        <RangeView
          {...shared}
          req={request}
          printing={printing}
          donePrinting={() => setPrinting(false)}
        />
      )}
    </div>
  );
}

interface ViewProps {
  mode: Mode;
  setMode: (m: Mode) => void;
  windUnit: WindUnit;
  toggleWind: () => void;
  selection: ColumnSelection;
  picking: boolean;
  setPicking: (v: boolean) => void;
  applySelection: (sel: ColumnSelection) => void;
  /** Width of the table, or null before it has been measured. */
  width: number | null;
  exporting: boolean;
  setExporting: (v: boolean) => void;
  /** The window last asked for, so reopening the panel starts where the reader left off. */
  request: ExportRequest | null;
  onView: (r: ExportRequest) => void;
  onSave: (r: ExportRequest) => void;
  /** What went wrong writing a file out, which is not the same as what went wrong reading. */
  saveErr: string | null;
}

/**
 * Live, Day, and the window in between them.
 *
 * Range has no button of its own: it cannot be entered by pressing one, because a window needs
 * two dates before it means anything, and they are chosen in the export panel. What the segment
 * does in that mode is show neither of its two lit, which is honest - the reader is in neither
 * - and offer the way back out.
 */
function ModeSeg({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="seg">
      <button className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}>Live</button>
      <button className={mode === "day" ? "on" : ""} onClick={() => setMode("day")}>Day</button>
    </div>
  );
}

/**
 * Nothing recorded, and why that is not a fault.
 *
 * The day view has said this since it was written; the live view showed an empty page under a
 * header and left the reader to guess whether the boat was silent, the plugin was broken or the
 * request had failed. A boat alongside with her instruments off records nothing, which is the
 * common case and the one an empty screen reads worst.
 */
/**
 * The width the page's blocks are drawn in, which is not the width of what is inside them.
 *
 * The lanes decide both, and a window that returned nothing has no lanes: the bar, the panel
 * and the table's frame all collapsed to a single lane - 254px on a 1920px screen - and a
 * reader who had just been looking at nine columns watched the page fold into a column while
 * the panel he was working in folded with it. Nothing about the screen changed; only the
 * answer did.
 *
 * So an empty answer keeps the room the screen has. The head and the rows still draw the lanes
 * they actually have (they take laneVar, not this), which for an empty window is the time
 * column alone; the blocks around them stay the size they were.
 */
/**
 * Where the minutes on the screen stop being minutes, said in the reader's own dates.
 *
 * The boat keeps her raw record for a window of days and summarises everything older into one
 * row per hour. Asked for a window that begins before it, the page draws minutes above hours -
 * which is the best answer there is, and looks like a fault while the bar overhead still says
 * EVERY MINUTE.
 *
 * It used to be worked out here, from the calendar: minutes were today's and nothing else, so
 * midnight was the line. The line is the boat's to draw - a window of days, shortened by
 * whatever her disk still holds - and she reports it with the rows. Nothing here changes what
 * is fetched; it names what arrived.
 *
 * It is two facts, and only the first is about the boat. Where her minutes begin is worth
 * saying whenever the reader asked for more than them. What lies before that reads hourly is
 * only worth saying if such a row is actually on the page: a window long enough to reach past
 * the minutes is usually long enough to hit the row ceiling as well, the ceiling takes the
 * oldest rows away first, and those are exactly the hourly ones. Promising them over a page
 * that carries none sends a reader to the bottom of it to look for what is not there.
 */
function minutesNote(minutesFrom: number | null, r: ExportRequest, snaps: Snapshot[]): string | null {
  if (minutesFrom === null || dateInputToMs(r.from) >= minutesFrom) return null;
  const day = new Date(minutesFrom).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const oldest = snaps[snaps.length - 1];
  const hourly = oldest !== undefined && oldest.ts < minutesFrom;
  return `Minutes reach back to ${day}.${hourly ? " Earlier days in this window read one row per hour." : ""}`;
}

/**
 * Why a window comes back empty, which is not always because nothing happened in it.
 *
 * Rows are stamped at the end of the interval they cover, so a window that reaches into today
 * holds no hourly row until the hour is out and no daily row until the day is. Asked for today
 * at ten past midnight, the log is genuinely empty at every interval but the minute - and the
 * boat has been logging all along. "Nothing was logged between these dates" is a statement
 * about the boat, and saying it there would be a lie the reader has no way to catch.
 */
function emptyRangeNote(r: ExportRequest): string {
  const endsAhead = dateInputToMs(r.to) + 86400_000 - 1 >= Date.now();
  if (endsAhead && r.gran !== "1m")
    return "No row has closed at this interval yet. A shorter interval shows today's.";
  return "Nothing was logged between these dates.";
}

function blockVar(drawn: LogColumn[], width: number | null): CSSProperties {
  if (drawn.length > 1 || width === null) return laneVar(drawn);
  return { "--lb-cols": lanesThatFit(width) } as CSSProperties;
}

function NoRows({ what }: { what: string }) {
  return (
    <div className="sp-empty">
      <div className="em-t">No snapshots</div>
      <div className="em-s">{what}</div>
    </div>
  );
}

/**
 * The width of the table, handed to CSS as a variable rather than baked into the stylesheet.
 * The count is the boat's now, and a fixed `repeat(5, 1fr)` would keep laying out five tracks
 * for a bare boat that fills two.
 *
 * It goes on the head, on the scroller holding the rows and on the band that captions them,
 * because all three are that same table and the stylesheet sizes all three from it. The rows
 * inherit it from the scroller rather than carrying a copy each.
 *
 * It also goes on the two windows the page is drawn in - the bar of controls and the frame the
 * table sits in - because what decides how wide those windows are is the same thing: the lanes
 * inside them. A bar wider than the table it belongs to reads as two separate pages.
 */
function laneVar(cols: LogColumn[]): CSSProperties {
  return { "--lb-cols": cols.length - 1 } as CSSProperties;
}

/**
 * The button that opens the picker, and its count.
 *
 * The count excludes the time column, which is not a choice: a person reading "Columns 7" and
 * finding six he can turn off has been given a number that is not about anything he can do.
 *
 * "5 of 9" is the narrow screen saying so out loud. The selection is still nine; the phone has
 * room to draw five of them, and a reader who is not told that is left hunting for a column he
 * turned on and cannot see.
 */
function ColumnsButton({
  shown,
  chosen,
  open,
  onOpen,
}: {
  shown: number;
  chosen: number;
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <button className={`lb-colbtn${open ? " on" : ""}`} onClick={onOpen}>
      Columns · <b>{shown < chosen ? `${shown} of ${chosen}` : chosen}</b>
    </button>
  );
}

/**
 * Opens the panel that decides which window leaves this screen and in what shape.
 *
 * It sits with the controls rather than off on its own because it belongs to them: what a
 * reader takes away is a window of time at an interval, which is the same pair of questions
 * the bar answers for the live view.
 */
function ExportButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return (
    <button className={`lb-colbtn${open ? " on" : ""}`} onClick={onOpen}>
      Export · <b>{"\u2026"}</b>
    </button>
  );
}

function Cols({ cols, toggleWind }: { cols: LogColumn[]; toggleWind: () => void }) {
  return (
    <div className="lb-cols" style={laneVar(cols)}>
      {cols.map((c) =>
        c.tappable ? (
          <span key={c.key} className="tap" onClick={toggleWind} title="Tap: knots ⇄ Beaufort">
            {c.head}
          </span>
        ) : (
          <span key={c.key}>{c.head}</span>
        ),
      )}
    </div>
  );
}

function LiveView({
  mode,
  setMode,
  windUnit,
  toggleWind,
  selection,
  picking,
  setPicking,
  applySelection,
  width,
  exporting,
  setExporting,
  request,
  onView,
  onSave,
  saveErr,
}: ViewProps) {
  const { granularity, changeGran, snaps, err, busy, hasMore, loadMore } = useLogbookLive();
  const earned = logbookColumns(snaps, windUnit);
  const cols = visibleColumns(earned, selection);
  const drawn = fittedColumns(cols, width);
  const block = blockVar(drawn, width);
  return (
    <>
      <div className="lb-ctrl" style={block}>
        <ModeSeg mode={mode} setMode={setMode} />
        <div className="seg">
          {GRANS.map((g) => (
            <button key={g} className={granularity === g ? "on" : ""} onClick={() => changeGran(g)}>{g}</button>
          ))}
        </div>
        <ColumnsButton
          shown={drawn.length - 1}
          chosen={cols.length - 1}
          open={picking}
          onOpen={() => setPicking(!picking)}
        />
        <ExportButton open={exporting} onOpen={() => setExporting(!exporting)} />
      </div>
      <Reveal open={picking} style={block}>
        <ColumnPicker
          cols={earned}
          applied={selection}
          onApply={applySelection}
          onCancel={() => setPicking(false)}
        />
      </Reveal>
      <Reveal open={exporting} style={block}>
        <ExportPanel
          initial={request ?? undefined}
          onView={onView}
          onSave={onSave}
          onCancel={() => setExporting(false)}
        />
      </Reveal>
      {saveErr && <div className="lb-err">{saveErr}</div>}
      <div className="lb-frame" style={block}>
        <PrintHead window={GRAN_LABEL[granularity]} interval={INTERVAL_NAME[granularity]} />
        <Cols cols={drawn} toggleWind={toggleWind} />
        <div className="lb-day" style={laneVar(drawn)}><span>{GRAN_LABEL[granularity]}</span><b>{snaps.length}</b></div>
        {err && <div className="lb-err">{err}</div>}
        {!busy && !err && snaps.length === 0 ? (
          <NoRows what={`Nothing was logged in this window (${GRAN_LABEL[granularity].toLowerCase()}).`} />
        ) : (
          <Rows
            snaps={snaps}
            cols={drawn}
            footer={
              hasMore ? (
                <button className="lb-more" onClick={loadMore} disabled={busy}>
                  {busy ? "Loading…" : `Load ${ROWS_LIMIT[granularity]} more`}
                </button>
              ) : null
            }
          />
        )}
      </div>
    </>
  );
}

function DayView({
  mode,
  setMode,
  windUnit,
  toggleWind,
  selection,
  picking,
  setPicking,
  applySelection,
  width,
  exporting,
  setExporting,
  request,
  onView,
  onSave,
  saveErr,
}: ViewProps) {
  const { dateStr, setDateStr, isToday, snaps, err, busy, prevDay, nextDay, goToday } = useLogbookDay();
  const earned = logbookColumns(snaps, windUnit);
  const cols = visibleColumns(earned, selection);
  const drawn = fittedColumns(cols, width);
  const block = blockVar(drawn, width);
  // timeZone: UTC throughout - dateStr names a UTC day, and rendering it in the
  // reader's zone would label it a day early west of Greenwich.
  const dayLabel = isToday
    ? `Today · ${new Date(dateStr).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })}`
    : new Date(dateStr)
        .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })
        .replace(/,/g, "");

  return (
    <>
      <div className="lb-ctrl" style={block}>
        <ModeSeg mode={mode} setMode={setMode} />
        <div className="lb-date">
          <button onClick={prevDay} aria-label="Previous day">‹</button>
          <input
            type="date"
            className="dt"
            value={dateStr}
            max={dateToInput()}
            onChange={(e) => setDateStr(e.target.value)}
            style={{ border: "1.5px solid var(--rule)", background: "var(--cell)", color: "var(--text)", fontFamily: "var(--sp-font)", fontSize: 12, padding: "5px 7px" }}
          />
          <button onClick={nextDay} disabled={isToday} aria-label="Next day">›</button>
          <button onClick={goToday} disabled={isToday}>Now</button>
        </div>
        <ColumnsButton
          shown={drawn.length - 1}
          chosen={cols.length - 1}
          open={picking}
          onOpen={() => setPicking(!picking)}
        />
        <ExportButton open={exporting} onOpen={() => setExporting(!exporting)} />
      </div>
      <Reveal open={picking} style={block}>
        <ColumnPicker
          cols={earned}
          applied={selection}
          onApply={applySelection}
          onCancel={() => setPicking(false)}
        />
      </Reveal>
      <Reveal open={exporting} style={block}>
        <ExportPanel
          initial={request ?? undefined}
          onView={onView}
          onSave={onSave}
          onCancel={() => setExporting(false)}
        />
      </Reveal>
      {saveErr && <div className="lb-err">{saveErr}</div>}
      <div className="lb-frame" style={block}>
        <PrintHead window={dayLabel} interval={INTERVAL_NAME["1h"]} />
        <Cols cols={drawn} toggleWind={toggleWind} />
        <div className="lb-day" style={laneVar(drawn)}><span>{dayLabel}</span><b>{snaps.length}</b></div>
        {err && <div className="lb-err">{err}</div>}
        {!busy && snaps.length === 0 ? (
          <NoRows what="No telemetry was logged for this day." />
        ) : (
          <Rows snaps={snaps} cols={drawn} footer={null} />
        )}
      </div>
    </>
  );
}

/**
 * The heading a printed page carries and a screen does not.
 *
 * On screen the bar above says which window this is and can be pressed to change it. On paper
 * there is no bar - it is one of the first things the print stylesheet takes away - and a table
 * of figures with no window named on it is not a record of anything. Every mode draws one, so
 * it does not matter which of them the reader happened to have open when he printed.
 */
function PrintHead({ window: w, interval }: { window: string; interval: string }) {
  return (
    <div className="lb-print-hd">
      <span className="b">Logbook · {w}</span>
      <span className="d">{interval} · UTC</span>
    </div>
  );
}

/** "3 Aug - 10 Aug 2026", and just the one date when both ends are the same day. */
function windowLabel(from: string, to: string): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  return from === to ? fmt(to, true) : `${fmt(from, false)} - ${fmt(to, true)}`;
}

/**
 * A window with an end on it: the days a reader asked for, at the interval he asked for.
 *
 * It is the third mode rather than a variant of the day view, because what it answers is a
 * different question. Live and Day both follow a boat that is still logging and refresh
 * themselves; a closed window does not move, and rows that shifted under a reader mid-page
 * would be a bug in a record.
 *
 * It is also the page that goes to paper. When the reader asked for a PDF, the printer is
 * called from here and not from the button he pressed: the page IS the document, so the rows
 * have to exist before the print dialog opens. `loaded` rather than `!busy` is what that waits
 * on - before the first fetch is even issued nothing is busy either, and the dialog would open
 * over an empty table.
 */
function RangeView({
  req,
  setMode,
  windUnit,
  toggleWind,
  selection,
  picking,
  setPicking,
  applySelection,
  width,
  exporting,
  setExporting,
  request,
  onView,
  onSave,
  saveErr,
  printing,
  donePrinting,
}: ViewProps & { req: ExportRequest | null; printing: boolean; donePrinting: () => void }) {
  const fallback: ExportRequest = {
    from: dateToInput(),
    to: dateToInput(),
    gran: "1h",
    format: "csv",
    stats: ["last"],
    distance: false,
    samples: false,
  };
  const r = req ?? fallback;
  const { snaps, err, busy, truncated, loaded, minutesFrom } = useLogbookRange(r.from, r.to, r.gran);
  const earned = logbookColumns(snaps, windUnit);
  const cols = visibleColumns(earned, selection);
  const drawn = fittedColumns(cols, width);
  const block = blockVar(drawn, width);

  const finish = useCallback(() => donePrinting(), [donePrinting]);
  useEffect(() => {
    if (!printing || !loaded || busy) return;
    // Cleared before the call, not after: print() blocks until the dialog closes, and a reader
    // who cancels it must not find the page trying again on the next render.
    finish();
    window.print();
  }, [printing, loaded, busy, finish]);

  const label = windowLabel(r.from, r.to);
  const interval = INTERVAL_NAME[r.gran];
  return (
    <>
      <div className="lb-ctrl" style={block}>
        <ModeSeg mode="range" setMode={setMode} />
        <button className="lb-colbtn on" onClick={() => setExporting(!exporting)}>
          {label} · <b>{interval}</b>
        </button>
        <ColumnsButton
          shown={drawn.length - 1}
          chosen={cols.length - 1}
          open={picking}
          onOpen={() => setPicking(!picking)}
        />
      </div>
      <Reveal open={picking} style={block}>
        <ColumnPicker
          cols={earned}
          applied={selection}
          onApply={applySelection}
          onCancel={() => setPicking(false)}
        />
      </Reveal>
      <Reveal open={exporting} style={block}>
        <ExportPanel
          initial={request ?? undefined}
          onView={onView}
          onSave={onSave}
          onCancel={() => setExporting(false)}
        />
      </Reveal>
      {saveErr && <div className="lb-err">{saveErr}</div>}
      <div className="lb-frame" style={block}>
        <PrintHead window={label} interval={interval} />
        <Cols cols={drawn} toggleWind={toggleWind} />
        <div className="lb-day" style={laneVar(drawn)}>
          <span>{label} · {interval}</span>
          <b>{truncated ? `${snaps.length} of more` : snaps.length}</b>
        </div>
        {err && <div className="lb-err">{err}</div>}
        {truncated && (
          <div className="lb-note">
            This window holds more than {RANGE_LIMIT} rows. The most recent {RANGE_LIMIT} are
            here; a longer interval covers the same days in fewer.
          </div>
        )}
        {minutesNote(minutesFrom, r, snaps) && (
          <div className="lb-note">{minutesNote(minutesFrom, r, snaps)}</div>
        )}
        {!busy && snaps.length === 0 ? (
          <NoRows what={emptyRangeNote(r)} />
        ) : (
          <Rows snaps={snaps} cols={drawn} footer={null} />
        )}
      </div>
    </>
  );
}

function Rows({ snaps, cols, footer }: { snaps: Snapshot[]; cols: LogColumn[]; footer: React.ReactNode }) {
  return (
    <div className="lb-rows" style={laneVar(cols)}>
      {snaps.map((s) => <Row key={s.ts} s={s} cols={cols} />)}
      {footer}
    </div>
  );
}

function Row({ s, cols }: { s: Snapshot; cols: LogColumn[] }) {
  return (
    <div className="lb-row">
      {cols.map((c, i) => (
        <span key={c.key} className={i === 0 ? "tm" : c.dim ? "v dim" : "v"}>
          {c.cell(s)}
        </span>
      ))}
    </div>
  );
}
