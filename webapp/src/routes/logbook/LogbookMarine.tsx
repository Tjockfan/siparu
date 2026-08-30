/* Logbook - snapshot history (Swiss redesign).
 * Brutalist data table: Live|Day + granularity, UTC·SOG·HDG·TWS·BARO·DEP rows.
 * Data flow (useLogbookLive / useLogbookDay) preserved; only the presentation changed. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type Snapshot } from "../../lib/api";
import { bucketsCsv, downloadText, exportFilename, snapshotsCsv } from "../../lib/export";
import { bucketHours, bucketRow, STAT_LABEL, type BucketGran, type Stat } from "../../lib/buckets";
import { unitCell, unitGroups, type UnitGroup } from "./unitRows";
import { useCrossFade } from "./useCrossFade";
import { dateInputToMs, dateToInput } from "../../lib/format";
import { useElementWidth } from "../../lib/useElementWidth";
import ColumnPicker from "./ColumnPicker";
import ExportPanel, { type ExportRequest } from "./ExportPanel";
import Reveal from "./Reveal";
import { columnsFor, hhmm, logbookColumns, type LogBook, type LogColumn, type WindUnit } from "./columns";
import { fittedColumns, laneCount, lanesThatFit, fittedMetrics } from "./fitColumns";
import { BrandMark } from "siparu-ui";
import {
  isOn,
  loadSelection,
  saveSelection,
  visibleColumns,
  type ColumnSelection,
  type PickItem,
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

/**
 * How long the table takes to leave before it comes back as something else.
 *
 * Short enough that a reader running down the tabs is not waiting on it, long enough that the
 * eye reads a change rather than a flicker. The stylesheet holds the same number: --lb-fade-out
 * there is this, and a suite pins the two together.
 */
const FADE_MS = 180;

const GRANS: Granularity[] = ["1m", "1h", "6h", "1d"];
const GRAN_LABEL: Record<Granularity, string> = {
  "1m": "Last hour",
  "1h": "Last 2 days",
  "6h": "Last 10 days",
  "1d": "Last month",
};

/**
 * One book's log: the bridge's or the engineer's, told apart by the page it is on.
 *
 * A ship keeps two logs and this screen used to try to be both at once, with a picker moving
 * between them; a three-engine boat put thirty columns behind one button. The two are separate
 * pages now, and everything below reads the book it was opened as - the columns it draws, the
 * ones its picker offers, the file it writes out and the choice it remembers.
 */
export default function LogbookMarine({ book }: { book: LogBook }) {
  const [mode, setMode] = useState<Mode>("live");
  // The live view's interval. Held here rather than in the live data hook so it can ride the
  // fade with everything else - and so it survives a trip through the day view, which losing
  // it never earned.
  const [gran, setGran] = useState<Granularity>("1h");
  // Which family of machines the engineer's page is showing. Held here so switching Live/Day
  // does not send him back to the engines, and null until he picks one - the page then shows
  // the first family the boat reports, which on every boat that has engines is the engines.
  const [family, setFamily] = useState<string | null>(null);
  // Everything the table can be about, faded as one. A control lights the moment it is
  // pressed; the table it commands waits for the old one to go, whichever control it was -
  // the book, the mode, the interval or the family. FADE_MS is the leaving half, and the
  // stylesheet plays the arriving half over the tokens this same number is written into
  // (--lb-fade-out). Memoised so the crossfade sees one value until a part actually changes.
  const scene = useMemo(() => ({ book, mode, gran, family }), [book, mode, gran, family]);
  const [shown, leaving] = useCrossFade(scene, FADE_MS);
  const { book: shownBook, mode: shownMode, gran: shownGran, family: shownFamily } = shown;
  // The window control - the interval chips in Live, the date group in Day - names the window
  // the table is drawing, so it belongs to the table and leaves with it. Swapped on the frame
  // the mode is pressed it was rebuilt underneath a table that was still fading, which is one
  // half of what read as a flicker in that row.
  // On a change of MODE alone, not on `leaving`: that is also true when the interval or the
  // family changed, and fading the chips then would take away the one that had just lit.
  const modeLeaving = mode !== shownMode;

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

  // The families the boat has, held across a window that names none.
  //
  // They are read off the paths her rows carry, so a window holding no rows names no families
  // and the tabs go - and a window holding no rows is an ordinary one: Day opens on today, and
  // shortly after a UTC midnight today is empty until the hour that just closed has been rolled
  // up. A boat does not stop having generators at one in the morning. The control left the bar,
  // and the bar is centred, so everything else in it moved to close the gap - measured at 38px,
  // which is the shift this bar was squared up to stop.
  // For the tabs alone. What the table is made of still comes from the window's own rows: an
  // empty day draws an empty day, under the tabs of the boat that is keeping the log.
  const groupsHold = useRef<UnitGroup[]>([]);
  // And the count of columns the reader keeps, held for the same reason and read by the same
  // button. The columns come out of the window's rows too, so an empty window has none and the
  // button said "Columns · 0" - which reads as a selection that has been lost, over a picker
  // that opens with nothing in it. The selection is untouched; the day has nothing to put in
  // it. "0 of 9" is the sentence this button already uses for the narrow screen, where drawn
  // and chosen also part company, and it is the true one here.
  const chosenHold = useRef(0);

  // Which columns are drawn, and the panel that changes them. Held here rather than in each
  // view so switching Live/Day does not reopen the picker or forget the choice. Per book, and
  // re-read when the book changes: the two pages are two decisions. Keyed to the book on
  // screen, not the one pressed - the choice belongs to the table it is applied to.
  const [selection, setSelection] = useState<ColumnSelection>(() => loadSelection(shownBook));
  const [pageBook, setPageBook] = useState<LogBook>(shownBook);
  if (pageBook !== shownBook) {
    setPageBook(shownBook);
    setSelection(loadSelection(shownBook));
    // The other book's families are not this one's, and the bridge keeps none at all.
    groupsHold.current = [];
    chosenHold.current = 0;
  }
  const [picking, setPicking] = useState(false);
  const applySelection = (sel: ColumnSelection) => {
    setSelection(sel);
    saveSelection(shownBook, sel);
    setPicking(false);
  };

  // What the table has to lay out in. Measured rather than assumed, because the same screen is
  // read on a phone and beside a chart table, and the number of columns that can be read at
  // once is the one thing that genuinely differs between them.
  const [tableRef, width] = useElementWidth<HTMLDivElement>();
  // The lane count the screen last drew, held so a view arriving empty keeps that room
  // (see blockVar) instead of swelling to the screen's lanes for the beat its fetch takes.
  const lanesHold = useRef<number | null>(null);
  // The width hook takes a callback ref and keeps no node; the glide below needs the node.
  const rootEl = useRef<HTMLDivElement | null>(null);
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootEl.current = node;
      tableRef(node);
    },
    [tableRef],
  );

  // The scenes are not all the same width, and the swap changes the lane count while the
  // table is invisible. Left alone, the bar and the frame snap to the new width - the one hard
  // cut in an otherwise gradual change. So their widths are noted as the old table starts to
  // leave, and once the new one is in place each glides from the width it had to the width it
  // has, over the same clock as the arriving fade. Played on the rendered widths rather than
  // as a CSS transition of max-width: that max-width can stand far beyond what the parent
  // allows, and a transition between two calc values spends most of its run outside the
  // visible range, which is exactly the snap this is here to remove.
  const glideFrom = useRef<Map<HTMLElement, number> | null>(null);
  useLayoutEffect(() => {
    const root = rootEl.current;
    if (!root) return;
    const blocks = () => root.querySelectorAll<HTMLElement>(".lb-ctrl, .lb-pick, .lb-frame");
    if (leaving) {
      const m = new Map<HTMLElement, number>();
      blocks().forEach((el) => m.set(el, el.getBoundingClientRect().width));
      glideFrom.current = m;
      return;
    }
    const from = glideFrom.current;
    glideFrom.current = null;
    if (!from || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ms = parseFloat(getComputedStyle(root).getPropertyValue("--lb-fade-in")) || 0;
    blocks().forEach((el) => {
      const was = from.get(el);
      if (was === undefined || typeof el.animate !== "function") return;
      const now = el.getBoundingClientRect().width;
      if (Math.abs(now - was) < 1) return;
      el.animate([{ maxWidth: `${was}px` }, { maxWidth: `${now}px` }], {
        duration: ms,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      });
    });
  }, [leaving, shown]);

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
        const cols = visibleColumns(columnsFor(logbookColumns(rows, windUnit), shownBook), selection);
        downloadText(exportFilename(`logbook-${shownBook}`, from, "csv"), "text/csv", snapshotsCsv(rows, cols));
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
          cols: visibleColumns(
            columnsFor(logbookColumns(buckets.map((b) => bucketRow(b, stat)), windUnit), shownBook),
            selection
          ),
        }))
        .filter((b) => b.cols.length > 1);
      downloadText(
        exportFilename(`logbook-${shownBook}`, from, "csv"),
        "text/csv",
        bucketsCsv(buckets, blocks, { distance: r.distance, samples: r.samples }),
      );
    } catch (e) {
      setSaveErr((e as Error).message);
    }
  };

  const shared = {
    book: shownBook,
    mode,
    setMode,
    gran,
    setGran,
    shownGran,
    family,
    setFamily,
    shownFamily,
    leaving,
    modeLeaving,
    lanesHold,
    groupsHold,
    chosenHold,
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
    <div className="lb" ref={setRoot}>
      {/* The log runs wide - the engineer's full set is twenty lanes - so its printed pages
          turn sideways. @page cannot be scoped by selector, so the rule exists only while a
          logbook page is mounted; the voyage record keeps the stylesheet's portrait. */}
      <style>{"@media print { @page { size: A4 landscape; margin: 12mm; } }"}</style>
      {shownMode === "live" ? (
        <LiveView {...shared} />
      ) : shownMode === "day" ? (
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
  /** The book the table is drawing - trailing the address by a fade when it just changed. */
  book: LogBook;
  mode: Mode;
  setMode: (m: Mode) => void;
  /** The interval the reader has asked for (lights the chips) and the one still drawn. */
  gran: Granularity;
  setGran: (g: Granularity) => void;
  shownGran: Granularity;
  /** The family the reader has asked for, which is what the tabs light. */
  family: string | null;
  setFamily: (t: string) => void;
  /** The family the table is still drawing, which trails the one above by a fade. */
  shownFamily: string | null;
  /** The old table is on its way out; whatever arrives next arrives under the fade. */
  leaving: boolean;
  /** The mode itself is changing, so the window control leaves with the table it names. */
  modeLeaving: boolean;
  /** The lane count last drawn, kept across views so an empty beat holds its room. */
  lanesHold: { current: number | null };
  /** The boat's families, held across a window that names none - see where it is declared. */
  groupsHold: { current: UnitGroup[] };
  /** The reader's column count, held the same way and for the same reason. */
  chosenHold: { current: number };
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
 * The one place in the bar that names the window, whichever mode names it: interval chips in
 * Live, a date and its arrows in Day, the two dates it was given in Range.
 *
 * The three are not the same width, and a centred bar re-centres on each of them. The floor
 * that stops that is `.lb-win` in the stylesheet, with the measurements. It fades with the
 * table when the mode changes, for the reason in `modeLeaving`.
 */
function WindowSlot({ leaving, children }: { leaving: boolean; children: ReactNode }) {
  return <div className={`lb-win${leaving ? " leaving" : ""}`}>{children}</div>;
}

/**
 * Which of the boat's machines the page is showing.
 *
 * Offered only when there is a choice: a boat with engines and no generator gets no tabs, and
 * the space they would take goes to the table. What is on them is hers too - the families come
 * out of the paths she sends, so a boat that fits a generator next season grows the tab the
 * hour it first reports.
 */
function FamilySeg({
  groups,
  family,
  setFamily,
}: {
  groups: UnitGroup[];
  family: string | null;
  setFamily: (t: string) => void;
}) {
  if (groups.length < 2) return null;
  const on = groups.find((g) => g.tab === family) ?? groups[0]!;
  return (
    <div className="seg">
      {groups.map((g) => (
        <button
          key={g.tab}
          className={g.tab === on.tab ? "on" : ""}
          onClick={() => setFamily(g.tab)}
        >
          {g.head}
        </button>
      ))}
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
/**
 * What a summary page is NOT showing, said on the page itself.
 *
 * A figure narrows the table without being asked to. There is no mean of a heading and none of
 * "motoring", so an average page simply has no COG, HDG or AWA column - and a reader who chose
 * those columns watches three of them go, sees his count drop from eleven to eight, and opens
 * a picker that now offers eight. Three surfaces telling him his selection shrank, and until
 * this sentence, nothing telling him why. On paper it is worse: the bar is not printed, so all
 * that is left of the difference is three columns that are not there.
 *
 * The names come from the rows, not from a list kept here: the same window read as readings
 * and read as the figure, and the difference between the two sets of columns. A hand-written
 * list is wrong the day a boat reports something nobody thought of.
 *
 * The position is its own half of the sentence. It is drawn on an average page and it is not
 * an average - a mean of two fixes is a point in the water the boat was never at - so it is
 * the fix the window closed on, and the masthead's "AVERAGE" would otherwise cover it too.
 */
function summaryNote(figure: Stat, dropped: string[], snaps: Snapshot[]): string {
  const word = STAT_LABEL[figure].toLowerCase();
  const list =
    dropped.length === 1
      ? dropped[0]
      : `${dropped.slice(0, -1).join(", ")} and ${dropped[dropped.length - 1]}`;
  const hasFix = snaps.some((s) => s.lat !== null && s.lon !== null);
  const fix = hasFix ? " The position on each row is the fix that window closed on." : "";
  return `${list} ${dropped.length === 1 ? "has" : "have"} no ${word}, so ${
    dropped.length === 1 ? "it is" : "they are"
  } left off this page.${fix}`;
}

function emptyRangeNote(r: ExportRequest): string {
  const endsAhead = dateInputToMs(r.to) + 86400_000 - 1 >= Date.now();
  if (endsAhead && r.gran !== "1m")
    return "No row has closed at this interval yet. A shorter interval shows today's.";
  return "Nothing was logged between these dates.";
}

/**
 * The room an empty table keeps is the room the last full one had.
 *
 * A view arrives empty for a beat - it mounts, asks, and the rows land a moment later - and
 * an empty table has no lanes to size the blocks from. Sizing them from whatever fits the
 * screen made the frame swell to the screen's lanes for exactly that beat and settle back
 * when the rows arrived, which under the fade reads as the page stretching and snapping. The
 * lane count the screen last actually drew is the best guess for what is about to arrive, so
 * that is what a lull holds; the screen-fit count remains the answer only before anything has
 * ever been drawn.
 */
function blockVar(
  drawn: LogColumn[],
  width: number | null,
  hold: { current: number | null },
): CSSProperties {
  if (drawn.length > 1 || width === null) return laneVar(drawn);
  return { "--lb-cols": hold.current ?? lanesThatFit(width) } as CSSProperties;
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
 * What this view is drawing: a column per reading, or a row per machine.
 *
 * The bridge's book is column-major and always was - a boat has one log line at a time and the
 * readings on it are her own. The engineer's is not: her machines are three of a kind, and the
 * question he asks the page is what the starboard one is doing that the port one is not.
 *
 * The families are the boat's, so the tabs are too. A single-engine boat is offered no choice
 * and shown no tab, because there is nothing to choose between.
 */
interface TableShape {
  /** The families this book offers, empty on the bridge's. */
  groups: UnitGroup[];
  /** The family on screen, or null when the table is drawn a column per reading. */
  group: UnitGroup | null;
  /** Column-major only: the columns actually drawn at this width. */
  drawn: LogColumn[];
  /** What the picker offers for this table - columns or readings, whichever it is made of. */
  pick: PickItem[];
  /** The picker button's counts: lanes drawn at this width, lanes this window offers to choose
   *  from, and the reader's own standing count - which the other two both fall to zero under
   *  when a window has no rows, and which is what the button has to name there. */
  btn: { shown: number; chosen: number; kept: number };
  /** The lane count, for the head, the rows and the two windows they sit in. */
  block: CSSProperties;
  /** What the bar and the frame carry so their width matches the table inside them. */
  cls: string;
}

/**
 * The key a refusal of one family's reading is stored under.
 *
 * Namespaced by the family, because RPM is a word both the engines and the generators use: a
 * reader striking fuel rate off the engines' page has said nothing about theirs. The prefix
 * also keeps these clear of the column keys the same book stores when a family of one machine
 * is drawn a column per reading.
 */
const metricKey = (tab: string, key: string) => `u:${tab}:${key}`;

export function tableShape(
  snaps: Snapshot[],
  book: LogBook,
  windUnit: WindUnit,
  selection: ColumnSelection,
  width: number | null,
  family: string | null,
  hold: { current: number | null },
  /** The boat's families, kept across a window that names none. Read the note where it is
   *  declared: it dresses the tabs only, never the table. */
  familyHold: { current: UnitGroup[] },
  /** The reader's column count, kept across a window that names no columns. */
  chosenHold: { current: number },
  /** False in the range view: a closed window is a document, and a document carries every
   *  column the reader chose - the lanes shrink instead, the way the CSV already refuses to
   *  drop what the screen has no room for. */
  fit = true,
  /** True when the rows are a summary figure rather than readings. Such a window offers fewer
   *  columns than the boat has - there is no mean of a heading - and that narrower count is
   *  the figure's, not the reader's, so it is not what an empty window should fall back to. */
  summarised = false,
): TableShape {
  const named = book === "engine" ? unitGroups(snaps) : [];
  if (named.length > 0) familyHold.current = named;
  // The tabs the bar offers: this window's families, or the boat's last known ones when this
  // window has nothing to name them from. Held only for a window with NO ROWS - a window that
  // has rows and still names no family is a boat that has stopped sending them, and lighting a
  // tab there would filter a table by something the rows do not carry. Everything below reads
  // `named`, so the table is only ever this window's either way.
  const groups = named.length === 0 && snaps.length === 0 ? familyHold.current : named;
  const chosen = named.find((g) => g.tab === family) ?? named[0];
  // Turning a family on its side is what buys a wide table back, and a family of one machine
  // has no width to buy: her twelve gauges fit as twelve columns, headed by the readings alone
  // (one machine has no initial worth repeating down the header). Rows there would print her
  // name on every line and head the readings with nothing.
  if (chosen && chosen.units.length > 1) {
    const pick = chosen.metrics.map((m) => ({ key: metricKey(chosen.tab, m.key), head: m.head }));
    const kept = chosen.metrics.filter((m) => isOn({ key: metricKey(chosen.tab, m.key) }, selection));
    const metrics = fit ? fittedMetrics(kept, width, true) : kept;
    const group = { ...chosen, metrics };
    hold.current = Math.max(1, metrics.length);
    if (kept.length > 0 && !summarised) chosenHold.current = kept.length;
    return {
      groups,
      group,
      drawn: [],
      pick,
      btn: { shown: metrics.length, chosen: kept.length, kept: chosenHold.current },
      block: { "--lb-cols": Math.max(1, metrics.length) } as CSSProperties,
      cls: " u",
    };
  }
  const all = columnsFor(logbookColumns(snaps, windUnit), book);
  // On the engineer's page the tabs still divide the table, so a column table shows the family
  // he is on rather than every machine aboard at once.
  const earned = chosen ? all.filter((c) => c.key === "ts" || c.tab === chosen.tab) : all;
  const cols = visibleColumns(earned, selection);
  const drawn = fit ? fittedColumns(cols, width) : cols;
  if (drawn.length > 1) hold.current = laneCount(drawn.slice(1));
  if (cols.length > 1 && !summarised) chosenHold.current = cols.length - 1;
  return {
    groups,
    group: null,
    drawn,
    pick: earned,
    btn: { shown: drawn.length - 1, chosen: cols.length - 1, kept: chosenHold.current },
    block: blockVar(drawn, width, hold),
    cls: "",
  };
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
/** The lane count for the engineer's table, which is a lane per reading and none for the hour. */
function metricVar(group: UnitGroup): CSSProperties {
  return { "--lb-cols": Math.max(1, group.metrics.length) } as CSSProperties;
}

/** Lanes, not columns: a position asks for two of them (see LogColumn.lanes). */
function laneVar(cols: LogColumn[]): CSSProperties {
  return { "--lb-cols": laneCount(cols.slice(1)) } as CSSProperties;
}

/** The class that spends a column's extra lanes. One lane needs none. */
function laneClass(c: LogColumn): string {
  return (c.lanes ?? 1) > 1 ? ` w${c.lanes}` : "";
}

/**
 * What the page says it holds, over the rows and in the masthead that goes to paper.
 *
 * A table of means that does not say so is a table of readings as far as anyone reading it can
 * tell - the numbers give nothing away, and the difference is the whole point of having asked
 * for the figure. So the figure stands beside the interval wherever the interval is written.
 * "Last" needs no word: the reading that stood when the window closed is what a logbook page
 * has always held, and naming it would suggest the others were the ordinary case.
 */
export function windowInterval(gran: Granularity, figure: Stat): string {
  return figure === "last"
    ? INTERVAL_NAME[gran]
    : `${INTERVAL_NAME[gran]} · ${STAT_LABEL[figure]}`;
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
 *
 * A window with no rows needs the opposite of "of". The columns come out of the rows, so an
 * empty day has none to draw AND none to offer, and both counts fell to zero: the button read
 * a bare "0", in the accent this screen keeps for figures worth reading, over a picker that
 * opened with nothing in it. Three surfaces telling a reader his selection had gone, at one in
 * the morning, when nothing had happened but a day turning over.
 *
 * So it names his standing count instead, the one he chose and still has. Not "0 of 9": "of"
 * is here to explain a table that is drawing SOME of his columns, and an empty day is not
 * drawing a partial table, it is drawing no table, which the body says in its own words. The
 * button does not open - there is nothing behind it to choose from until the day has rows -
 * and the figure goes quiet, because an empty day is not a fault and does not belong in red.
 */
export function columnsCount(shown: number, chosen: number, kept: number): string {
  // Nothing to choose from: the window has no rows, so it named no columns. Say what the
  // reader has, not what this window could not find.
  if (chosen === 0) return String(kept);
  // Fewer drawn than kept: the screen is too narrow for all of them, and he is told so.
  if (shown < chosen) return `${shown} of ${chosen}`;
  return String(chosen);
}

function ColumnsButton({
  shown,
  chosen,
  kept,
  open,
  onOpen,
}: {
  shown: number;
  chosen: number;
  kept: number;
  open: boolean;
  onOpen: () => void;
}) {
  const empty = chosen === 0;
  return (
    <button
      className={`lb-colbtn${open ? " on" : ""}${empty ? " quiet" : ""}`}
      onClick={onOpen}
      disabled={empty}
    >
      Columns · <b>{columnsCount(shown, chosen, kept)}</b>
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

/**
 * The heads over the table, in whichever of its two shapes is on screen.
 *
 * The engineer's leads with two: the hour and the machine. Neither is a reading, and neither is
 * set like one - the machine's name is a label on the line, not a figure taken off it.
 */
function Cols({
  cols,
  group,
  toggleWind,
}: {
  cols: LogColumn[];
  group: UnitGroup | null;
  toggleWind: () => void;
}) {
  if (group) {
    const named = group.units.length > 1;
    return (
      <div className={`lb-cols${named ? " u" : ""}`} style={metricVar(group)}>
        <span>UTC</span>
        {named && <span className="un">Unit</span>}
        {group.metrics.map((m) => (
          <span key={m.key}>
            {m.head}
            <Unit of={m.unit} />
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="lb-cols" style={laneVar(cols)}>
      {cols.map((c) =>
        c.tappable ? (
          <span
            key={c.key}
            className={`tap${laneClass(c)}`}
            onClick={toggleWind}
            title="Tap: knots ⇄ Beaufort"
          >
            {c.head}
            <Unit of={c.unit} />
          </span>
        ) : (
          <span key={c.key} className={laneClass(c).trim()}>
            {c.head}
            <Unit of={c.unit} />
          </span>
        ),
      )}
    </div>
  );
}

/**
 * The unit under a column's head.
 *
 * On its own line rather than beside the head, which is what the room decides: measured across
 * the engineer's thirteen heads, every one of them fits its unit alongside in a desk lane and
 * six of the thirteen do not in a phone's. Set beside the head it would be a unit a desk reader
 * gets and a phone reader does not, on the same table, for no reason he can see.
 *
 * A head with no unit still draws the line, empty. Without it the heads that have one sit a row
 * lower than the heads that do not, and the rule under them stops being straight.
 */
function Unit({ of }: { of?: string }) {
  return <b className="lb-u">{of === undefined || of === "" ? " " : of}</b>;
}

function LiveView({
  book,
  mode,
  setMode,
  gran,
  setGran,
  shownGran,
  family,
  setFamily,
  shownFamily,
  leaving,
  modeLeaving,
  lanesHold,
  groupsHold,
  chosenHold,
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
  const { snaps, err, busy, hasMore, loadMore } = useLogbookLive(shownGran);
  const { groups, group, drawn, pick, btn, block, cls } = tableShape(
    snaps, book, windUnit, selection, width, shownFamily, lanesHold, groupsHold, chosenHold,
  );
  return (
    <>
      <div className={`lb-ctrl${cls}`} style={block}>
        <ModeSeg mode={mode} setMode={setMode} />
        <WindowSlot leaving={modeLeaving}>
          <div className="seg">
            {GRANS.map((g) => (
              <button key={g} className={gran === g ? "on" : ""} onClick={() => setGran(g)}>{g}</button>
            ))}
          </div>
        </WindowSlot>
        <FamilySeg groups={groups} family={family} setFamily={setFamily} />
        <div className="lb-acts">
          <ColumnsButton
            shown={btn.shown}
            chosen={btn.chosen}
            kept={btn.kept}
            open={picking}
            onOpen={() => setPicking(!picking)}
          />
          <ExportButton open={exporting} onOpen={() => setExporting(!exporting)} />
        </div>
      </div>
      <Reveal open={picking} style={block} cls={cls}>
        <ColumnPicker
          cols={pick}
          applied={selection}
          onApply={applySelection}
          onCancel={() => setPicking(false)}
        />
      </Reveal>
      <Reveal open={exporting} style={block} cls={cls}>
        <ExportPanel
          initial={request ?? undefined}
          onView={onView}
          onSave={onSave}
          onCancel={() => setExporting(false)}
        />
      </Reveal>
      {saveErr && <div className="lb-err">{saveErr}</div>}
      <div className={`lb-frame${cls}${leaving ? " leaving" : ""}`} style={block}>
        <PrintHead book={book} window={GRAN_LABEL[shownGran]} interval={INTERVAL_NAME[shownGran]} />
        <Cols cols={drawn} group={group} toggleWind={toggleWind} />
        <div className="lb-day" style={laneVar(drawn)}><span>{GRAN_LABEL[shownGran]}</span><b>{snaps.length}</b></div>
        {err && <div className="lb-err">{err}</div>}
        {!busy && !err && snaps.length === 0 ? (
          <NoRows what={`Nothing was logged in this window (${GRAN_LABEL[shownGran].toLowerCase()}).`} />
        ) : (
          <Rows
            snaps={snaps}
            cols={drawn}
            group={group}
            footer={
              hasMore ? (
                <button className="lb-more" onClick={loadMore} disabled={busy}>
                  {busy ? "Loading…" : `Load ${ROWS_LIMIT[shownGran]} more`}
                </button>
              ) : null
            }
          />
        )}
        <PrintFoot />
      </div>
    </>
  );
}

function DayView({
  book,
  mode,
  setMode,
  family,
  setFamily,
  shownFamily,
  leaving,
  modeLeaving,
  lanesHold,
  groupsHold,
  chosenHold,
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
  const { groups, group, drawn, pick, btn, block, cls } = tableShape(
    snaps, book, windUnit, selection, width, shownFamily, lanesHold, groupsHold, chosenHold,
  );
  // timeZone: UTC throughout - dateStr names a UTC day, and rendering it in the
  // reader's zone would label it a day early west of Greenwich.
  const dayLabel = isToday
    ? `Today · ${new Date(dateStr).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })}`
    : new Date(dateStr)
        .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })
        .replace(/,/g, "");

  return (
    <>
      <div className={`lb-ctrl${cls}`} style={block}>
        <ModeSeg mode={mode} setMode={setMode} />
        <WindowSlot leaving={modeLeaving}>
          <div className="lb-date">
            <button className="lb-step" onClick={prevDay} aria-label="Previous day">‹</button>
            <input
              type="date"
              className="dt"
              value={dateStr}
              max={dateToInput()}
              onChange={(e) => setDateStr(e.target.value)}
            />
            <button className="lb-step" onClick={nextDay} disabled={isToday} aria-label="Next day">›</button>
            <button onClick={goToday} disabled={isToday}>Now</button>
          </div>
        </WindowSlot>
        <FamilySeg groups={groups} family={family} setFamily={setFamily} />
        <div className="lb-acts">
          <ColumnsButton
            shown={btn.shown}
            chosen={btn.chosen}
            kept={btn.kept}
            open={picking}
            onOpen={() => setPicking(!picking)}
          />
          <ExportButton open={exporting} onOpen={() => setExporting(!exporting)} />
        </div>
      </div>
      <Reveal open={picking} style={block} cls={cls}>
        <ColumnPicker
          cols={pick}
          applied={selection}
          onApply={applySelection}
          onCancel={() => setPicking(false)}
        />
      </Reveal>
      <Reveal open={exporting} style={block} cls={cls}>
        <ExportPanel
          initial={request ?? undefined}
          onView={onView}
          onSave={onSave}
          onCancel={() => setExporting(false)}
        />
      </Reveal>
      {saveErr && <div className="lb-err">{saveErr}</div>}
      <div className={`lb-frame${cls}${leaving ? " leaving" : ""}`} style={block}>
        <PrintHead book={book} window={dayLabel} interval={INTERVAL_NAME["1h"]} />
        <Cols cols={drawn} group={group} toggleWind={toggleWind} />
        <div className="lb-day" style={laneVar(drawn)}><span>{dayLabel}</span><b>{snaps.length}</b></div>
        {err && <div className="lb-err">{err}</div>}
        {!busy && snaps.length === 0 ? (
          <NoRows what="No telemetry was logged for this day." />
        ) : (
          <Rows snaps={snaps} cols={drawn} group={group} footer={null} />
        )}
        <PrintFoot />
      </div>
    </>
  );
}

/** "29 Aug 2026 · 17:42 UTC", the moment the page went to paper. */
function generatedStamp(): string {
  const d = new Date();
  const day = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const p = (n: number) => String(n).padStart(2, "0");
  return `${day.toUpperCase()} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** Which officer keeps this book, for the masthead's byline. */
const BOOK_KEEPER: Record<LogBook, string> = {
  bridge: "CHIEF OFFICER",
  engine: "CHIEF ENGINEER",
};

/**
 * The masthead a printed page carries and a screen does not.
 *
 * On screen the bar above says which window this is and can be pressed to change it. On paper
 * there is no bar - it is one of the first things the print stylesheet takes away - and a table
 * of figures with no window named on it is not a record of anything. Every mode draws one, so
 * it does not matter which of them the reader happened to have open when he printed. The mark
 * and the wordmark sit where they sit on every other Siparu surface; the right side says when
 * the page was made and what it holds.
 */
function PrintHead({ book, window: w, interval }: { book: LogBook; window: string; interval: string }) {
  return (
    <div className="lb-print-hd">
      <div className="ph-id">
        <span className="sp-lockup">
          <BrandMark className="sp-glyph" />
          <span className="ph-wm">Siparu</span>
        </span>
        <span className="ph-book">
          LOGBOOK · <b>{book.toUpperCase()}</b> · {BOOK_KEEPER[book]}
        </span>
      </div>
      <div className="ph-meta">
        <div><span className="l">GENERATED</span><b>{generatedStamp()}</b></div>
        <div><span className="l">WINDOW</span><b>{`${w} · ${interval} · UTC`.toUpperCase()}</b></div>
      </div>
    </div>
  );
}

/** The printed page's last line; the screen never shows it. */
function PrintFoot() {
  return (
    <div className="lb-print-ft">
      <span>siparu.app</span>
    </div>
  );
}

/** "SAT · 29 AUG 2026" - the line a page writes where the day turns. */
function utcDayLine(ts: number): string {
  return new Date(ts)
    .toLocaleDateString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    })
    .replace(/,\s*/, " · ")
    .toUpperCase();
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
  book,
  req,
  setMode,
  family,
  setFamily,
  shownFamily,
  leaving,
  modeLeaving,
  lanesHold,
  groupsHold,
  chosenHold,
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
    style: "screen",
  };
  const r = req ?? fallback;
  // The figure the page carries. The panel sends one for a page even when the reader has ticked
  // several for a file, but a default here too: this view also draws before anything has been
  // exported at all (the fallback above), and a table with no figure named is not a table.
  const figure: Stat = r.stats[0] ?? "last";
  const { snaps, err, busy, truncated, loaded, minutesFrom, plain } = useLogbookRange(
    r.from, r.to, r.gran, figure,
  );
  // Oldest first: a closed window is a document, and a document is read forwards. The live and
  // day views keep the newest on top because they follow a boat still logging; this one does
  // not move, and it is the page that goes to paper.
  const shown = useMemo(() => [...snaps].sort((a, b) => a.ts - b.ts), [snaps]);
  const { groups, group, drawn, pick, btn, block, cls } = tableShape(
    shown, book, windUnit, selection, width, shownFamily, lanesHold, groupsHold, chosenHold,
    false, figure !== "last",
  );

  const finish = useCallback(() => donePrinting(), [donePrinting]);
  useEffect(() => {
    if (!printing || !loaded || busy) return;
    // The screen dress is a class on the root for the print stylesheet to key on; it goes on
    // for the dialog and comes off when the dialog closes, so a later Cmd+P prints paper.
    if (r.style === "screen") document.documentElement.classList.add("pdf-screen");
    // Cleared before the call, not after: print() blocks until the dialog closes, and a reader
    // who cancels it must not find the page trying again on the next render.
    finish();
    window.print();
    document.documentElement.classList.remove("pdf-screen");
  }, [printing, loaded, busy, finish, r.style]);
  // A print interrupted by an unmount must not leave the whole app dressed for the dark page.
  useEffect(() => () => document.documentElement.classList.remove("pdf-screen"), []);

  const label = windowLabel(r.from, r.to);
  const interval = windowInterval(r.gran, figure);
  // Which of the reader's columns a summary cannot carry, asked of the rows rather than kept
  // as a list: the same window read both ways, and the difference is the answer. See the note
  // over `plain` in useLogbookData, and `summaryNote` for why the page has to say it.
  const dropped = useMemo(() => {
    if (plain.length === 0) return [];
    const heads = (rows: Snapshot[]) =>
      visibleColumns(columnsFor(logbookColumns(rows, windUnit), book), selection).map((c) => c.head);
    const drawn = new Set(heads(snaps));
    return heads(plain).filter((h) => !drawn.has(h));
  }, [plain, snaps, windUnit, book, selection]);
  return (
    <>
      <div className={`lb-ctrl${cls}`} style={block}>
        <ModeSeg mode="range" setMode={setMode} />
        <WindowSlot leaving={modeLeaving}>
          <button className="lb-colbtn on" onClick={() => setExporting(!exporting)}>
            {label} · <b>{interval}</b>
          </button>
        </WindowSlot>
        <FamilySeg groups={groups} family={family} setFamily={setFamily} />
        <div className="lb-acts">
          <ColumnsButton
            shown={btn.shown}
            chosen={btn.chosen}
            kept={btn.kept}
            open={picking}
            onOpen={() => setPicking(!picking)}
          />
        </div>
      </div>
      <Reveal open={picking} style={block} cls={cls}>
        <ColumnPicker
          cols={pick}
          applied={selection}
          onApply={applySelection}
          onCancel={() => setPicking(false)}
        />
      </Reveal>
      <Reveal open={exporting} style={block} cls={cls}>
        <ExportPanel
          initial={request ?? undefined}
          onView={onView}
          onSave={onSave}
          onCancel={() => setExporting(false)}
        />
      </Reveal>
      {saveErr && <div className="lb-err">{saveErr}</div>}
      <div className={`lb-frame${cls}${leaving ? " leaving" : ""}`} style={block}>
        <PrintHead book={book} window={label} interval={interval} />
        <Cols cols={drawn} group={group} toggleWind={toggleWind} />
        <div className="lb-day" style={laneVar(drawn)}>
          <span>{label} · {interval}</span>
          <b>{truncated ? `${snaps.length} of more` : snaps.length}</b>
        </div>
        {err && <div className="lb-err">{err}</div>}
        {dropped.length > 0 && (
          <div className="lb-note">{summaryNote(figure, dropped, snaps)}</div>
        )}
        {truncated && (
          <div className="lb-note">
            This window holds more than {RANGE_LIMIT} rows. The most recent {RANGE_LIMIT} are
            here; a longer interval covers the same days in fewer.
          </div>
        )}
        {minutesNote(minutesFrom, r, snaps) && (
          <div className="lb-note">{minutesNote(minutesFrom, r, snaps)}</div>
        )}
        {!busy && shown.length === 0 ? (
          <NoRows what={emptyRangeNote(r)} />
        ) : (
          <Rows snaps={shown} cols={drawn} group={group} footer={null} dated />
        )}
        <PrintFoot />
      </div>
    </>
  );
}

function Rows({
  snaps,
  cols,
  group,
  footer,
  dated = false,
}: {
  snaps: Snapshot[];
  cols: LogColumn[];
  group: UnitGroup | null;
  footer: React.ReactNode;
  /** Range view only: a dated line above the first row and wherever the UTC day turns, so a
   *  week of hours never leaves the reader guessing which day an hour belongs to. */
  dated?: boolean;
}) {
  const items: React.ReactNode[] = [];
  let prevDay: string | null = null;
  for (const s of snaps) {
    if (dated) {
      const day = utcDayLine(s.ts);
      if (day !== prevDay) {
        items.push(<div className="lb-sep" key={`sep-${s.ts}`}>{day}</div>);
        prevDay = day;
      }
    }
    items.push(
      group ? <UnitBlock key={s.ts} s={s} group={group} /> : <Row key={s.ts} s={s} cols={cols} />,
    );
  }
  return (
    <div className="lb-rows" style={group ? metricVar(group) : laneVar(cols)}>
      {items}
      {footer}
    </div>
  );
}

/**
 * One moment, and the machines under it.
 *
 * The hour is written on the first line and left off the rest, which is how it is written in
 * ink: three lines carrying the same four digits read as three readings until you notice they
 * are one. The lines are held together by the rule above the block rather than by repetition.
 */
function UnitBlock({ s, group }: { s: Snapshot; group: UnitGroup }) {
  const named = group.units.length > 1;
  return (
    <>
      {group.units.map((u, i) => (
        <div
          key={u.key}
          className={`lb-row${named ? " u" : ""}${i > 0 ? " cont" : ""}`}
        >
          <span className="tm">{hhmm(s.ts)}</span>
          {named && <span className="un">{u.head}</span>}
          {group.metrics.map((m) => (
            <span key={m.key} className="v">
              {unitCell(s, u, m)}
            </span>
          ))}
        </div>
      ))}
    </>
  );
}

function Row({ s, cols }: { s: Snapshot; cols: LogColumn[] }) {
  return (
    <div className="lb-row">
      {cols.map((c, i) => (
        <span
          key={c.key}
          className={i === 0 ? "tm" : `${c.dim ? "v dim" : "v"}${laneClass(c)}`}
        >
          {c.cell(s)}
        </span>
      ))}
    </div>
  );
}
