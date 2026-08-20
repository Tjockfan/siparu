/* Logbook - snapshot history (Swiss redesign).
 * Brutalist data table: Live|Day + granularity, UTC·SOG·HDG·TWS·BARO·DEP rows.
 * Data flow (useLogbookLive / useLogbookDay) preserved; only the presentation changed. */
import { useState, type CSSProperties } from "react";
import { type Snapshot } from "../../lib/api";
import { dateToInput } from "../../lib/format";
import { logbookColumns, type LogColumn, type WindUnit } from "./columns";
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

  const shared = { mode, setMode, windUnit, toggleWind };
  return (
    <div className="lb">
      {mode === "live" ? <LiveView {...shared} /> : <DayView {...shared} />}
    </div>
  );
}

interface ViewProps {
  mode: Mode;
  setMode: (m: Mode) => void;
  windUnit: WindUnit;
  toggleWind: () => void;
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

function LiveView({ mode, setMode, windUnit, toggleWind }: ViewProps) {
  const { granularity, changeGran, snaps, err, busy, hasMore, loadMore } = useLogbookLive();
  const cols = logbookColumns(snaps, windUnit);
  return (
    <>
      <div className="lb-ctrl">
        <ModeSeg mode={mode} setMode={setMode} />
        <div className="seg">
          {GRANS.map((g) => (
            <button key={g} className={granularity === g ? "on" : ""} onClick={() => changeGran(g)}>{g}</button>
          ))}
        </div>
        <span className="lb-count">{snaps.length}</span>
      </div>
      <Cols cols={cols} toggleWind={toggleWind} />
      <div className="lb-day"><span>{GRAN_LABEL[granularity]}</span><b>{snaps.length}</b></div>
      {err && <div className="lb-err">{err}</div>}
      {!busy && !err && snaps.length === 0 ? (
        <NoRows what={`Nothing was logged in this window (${GRAN_LABEL[granularity].toLowerCase()}).`} />
      ) : (
        <Rows
          snaps={snaps}
          cols={cols}
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

function DayView({ mode, setMode, windUnit, toggleWind }: ViewProps) {
  const { dateStr, setDateStr, isToday, snaps, err, busy, prevDay, nextDay, goToday } = useLogbookDay();
  const cols = logbookColumns(snaps, windUnit);
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
      </div>
      <Cols cols={cols} toggleWind={toggleWind} />
      <div className="lb-day"><span>{dayLabel}</span><b>{snaps.length}</b></div>
      {err && <div className="lb-err">{err}</div>}
      {!busy && snaps.length === 0 ? (
        <NoRows what="No telemetry was logged for this day." />
      ) : (
        <Rows snaps={snaps} cols={cols} footer={null} />
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
