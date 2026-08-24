/* Logbook - snapshot history (Swiss redesign).
 * Brutalist data table: Live|Day + granularity, UTC·SOG·HDG·TWS·BARO·DEP rows.
 * Data flow (useLogbookLive / useLogbookDay) preserved; only the presentation changed. */
import { useState, type CSSProperties } from "react";
import { type Snapshot } from "../../lib/api";
import { dateToInput } from "../../lib/format";
import { useElementWidth } from "../../lib/useElementWidth";
import ColumnPicker from "./ColumnPicker";
import { logbookColumns, type LogColumn, type WindUnit } from "./columns";
import { fittedColumns } from "./fitColumns";
import {
  loadSelection,
  saveSelection,
  visibleColumns,
  type ColumnSelection,
} from "./columnSelection";
import {
  useLogbookLive,
  useLogbookDay,
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
  };
  return (
    <div className="lb" ref={tableRef}>
      {mode === "live" ? <LiveView {...shared} /> : <DayView {...shared} />}
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
}

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
 */
function gridVar(cols: LogColumn[]): CSSProperties {
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

function Cols({ cols, toggleWind }: { cols: LogColumn[]; toggleWind: () => void }) {
  return (
    <div className="lb-cols" style={gridVar(cols)}>
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
}: ViewProps) {
  const { granularity, changeGran, snaps, err, busy, hasMore, loadMore } = useLogbookLive();
  const earned = logbookColumns(snaps, windUnit);
  const cols = visibleColumns(earned, selection);
  const drawn = fittedColumns(cols, width);
  return (
    <>
      <div className="lb-ctrl">
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
        <span className="lb-count">{snaps.length}</span>
      </div>
      {picking && (
        <ColumnPicker
          cols={earned}
          applied={selection}
          onApply={applySelection}
          onCancel={() => setPicking(false)}
        />
      )}
      <Cols cols={drawn} toggleWind={toggleWind} />
      <div className="lb-day"><span>{GRAN_LABEL[granularity]}</span><b>{snaps.length}</b></div>
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
}: ViewProps) {
  const { dateStr, setDateStr, isToday, snaps, err, busy, prevDay, nextDay, goToday } = useLogbookDay();
  const earned = logbookColumns(snaps, windUnit);
  const cols = visibleColumns(earned, selection);
  const drawn = fittedColumns(cols, width);
  // timeZone: UTC throughout - dateStr names a UTC day, and rendering it in the
  // reader's zone would label it a day early west of Greenwich.
  const dayLabel = isToday
    ? `Today · ${new Date(dateStr).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })}`
    : new Date(dateStr)
        .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })
        .replace(/,/g, "");

  return (
    <>
      <div className="lb-ctrl">
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
      </div>
      {picking && (
        <ColumnPicker
          cols={earned}
          applied={selection}
          onApply={applySelection}
          onCancel={() => setPicking(false)}
        />
      )}
      <Cols cols={drawn} toggleWind={toggleWind} />
      <div className="lb-day"><span>{dayLabel}</span><b>{snaps.length}</b></div>
      {err && <div className="lb-err">{err}</div>}
      {!busy && snaps.length === 0 ? (
        <NoRows what="No telemetry was logged for this day." />
      ) : (
        <Rows snaps={snaps} cols={drawn} footer={null} />
      )}
    </>
  );
}

function Rows({ snaps, cols, footer }: { snaps: Snapshot[]; cols: LogColumn[]; footer: React.ReactNode }) {
  return (
    <div className="lb-rows">
      {snaps.map((s) => <Row key={s.ts} s={s} cols={cols} />)}
      {footer}
    </div>
  );
}

function Row({ s, cols }: { s: Snapshot; cols: LogColumn[] }) {
  return (
    <div className="lb-row" style={gridVar(cols)}>
      {cols.map((c, i) => (
        <span key={c.key} className={i === 0 ? "tm" : c.dim ? "v dim" : "v"}>
          {c.cell(s)}
        </span>
      ))}
    </div>
  );
}
