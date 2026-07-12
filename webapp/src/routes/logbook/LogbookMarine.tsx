/* Logbook - snapshot history (Swiss redesign).
 * Brutalist data table: Live|Day + granularity, UTC·SOG·HDG·TWS·BARO·DEP rows.
 * Data flow (useLogbookLive / useLogbookDay) preserved; only the presentation changed. */
import { useState } from "react";
import { type Snapshot } from "../../lib/api";
import {
  dateToInput,
  fmtNum,
  knotToBeaufort,
  msToKnots,
  paToHPa,
  radToDeg,
  sogKnFiltered,
} from "../../lib/format";
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

type WindUnit = "kn" | "bft";

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

function Cols({ windUnit, toggleWind }: { windUnit: WindUnit; toggleWind: () => void }) {
  return (
    <div className="lb-cols">
      <span>UTC</span><span>SOG</span><span>HDG</span>
      <span className="tap" onClick={toggleWind} title="Tap: knots ⇄ Beaufort">
        {windUnit === "kn" ? "TWS" : "BFT"}
      </span>
      <span>BARO</span><span>DEP</span>
    </div>
  );
}

function LiveView({ mode, setMode, windUnit, toggleWind }: ViewProps) {
  const { granularity, changeGran, snaps, err, busy, hasMore, loadMore } = useLogbookLive();
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
      <Cols windUnit={windUnit} toggleWind={toggleWind} />
      <div className="lb-day"><span>{GRAN_LABEL[granularity]}</span><b>{snaps.length}</b></div>
      {err && <div className="lb-err">{err}</div>}
      <Rows
        snaps={snaps}
        windUnit={windUnit}
        footer={
          hasMore ? (
            <button className="lb-more" onClick={loadMore} disabled={busy}>
              {busy ? "Loading…" : `Load ${ROWS_LIMIT[granularity]} more`}
            </button>
          ) : null
        }
      />
    </>
  );
}

function DayView({ mode, setMode, windUnit, toggleWind }: ViewProps) {
  const { dateStr, setDateStr, isToday, snaps, err, busy, prevDay, nextDay, goToday } = useLogbookDay();
  const dayLabel = isToday
    ? `Today · ${new Date(dateStr).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}`
    : new Date(dateStr).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }).replace(/,/g, "");

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
      <Cols windUnit={windUnit} toggleWind={toggleWind} />
      <div className="lb-day"><span>{dayLabel}</span><b>{snaps.length}</b></div>
      {err && <div className="lb-err">{err}</div>}
      {!busy && snaps.length === 0 ? (
        <div className="sp-empty">
          <div className="em-t">No snapshots</div>
          <div className="em-s">No telemetry was logged for this day.</div>
        </div>
      ) : (
        <Rows snaps={snaps} windUnit={windUnit} footer={null} />
      )}
    </>
  );
}

function Rows({ snaps, footer, windUnit }: { snaps: Snapshot[]; footer: React.ReactNode; windUnit: WindUnit }) {
  return (
    <div className="lb-rows">
      {snaps.map((s) => <Row key={s.ts} s={s} windUnit={windUnit} />)}
      {footer}
    </div>
  );
}

function Row({ s, windUnit }: { s: Snapshot; windUnit: WindUnit }) {
  const d = new Date(s.ts);
  const p = (n: number) => String(n).padStart(2, "0");
  const sog = sogKnFiltered(s.sog);
  const hdg = radToDeg(s.heading_true ?? s.heading_mag);
  const tws = msToKnots(s.wind_speed_true);
  const wind =
    tws === null ? "·" : windUnit === "kn" ? String(Math.round(tws)) : String(knotToBeaufort(tws) ?? "·");
  const baro = paToHPa(s.air_pressure_pa);
  return (
    <div className="lb-row">
      <span className="tm">{p(d.getHours())}:{p(d.getMinutes())}</span>
      <span className="v">{fmtNum(sog, 1)}</span>
      <span className="v">{hdg === null ? "·" : Math.round(hdg) + "°"}</span>
      <span className="v">{wind}</span>
      <span className="v dim">{baro === null ? "·" : Math.round(baro)}</span>
      <span className="v">{s.depth === null ? "·" : s.depth.toFixed(1)}</span>
    </div>
  );
}
