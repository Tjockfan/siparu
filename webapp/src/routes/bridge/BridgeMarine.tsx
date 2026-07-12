/* Bridge - Telemetry (Swiss redesign).
 * Brutalist modular grid; header + tab bar shared by Layout. Live SignalK (2s)
 * via useBridgeData; SOG/Depth animate, gust+baro sparklines, skeleton on load. */
import { useState } from "react";
import AnimatedNumber from "../../components/AnimatedNumber";
import Sparkline from "../../components/swiss/Sparkline";
import { fmtCoordDM, formatTimeShort } from "../../lib/format";
import { depthDiagLabel } from "../../lib/depthDiag";
import { useBridgeData, type GustHours } from "./useBridgeData";
import BaroPopup from "./BaroPopup";
import PairBand from "./PairBand";

const GUST_WINDOWS: GustHours[] = [1, 6, 12, 24];

function deg(v: number | null): string {
  return v === null ? "·" : String(Math.round(v));
}

function awa(v: number | null): string {
  if (v === null) return "·";
  const side = v < 0 ? "P" : "S";
  return `${Math.round(Math.abs(v))}°${side}`;
}

function baroTrend(delta: number | null): { txt: string; tone: string } {
  if (delta === null) return { txt: "·", tone: "" };
  const arrow = delta < -0.1 ? "▼" : delta > 0.1 ? "▲" : "▬";
  const tone = delta <= -4 ? "alarm" : delta <= -1.6 ? "warn" : delta >= 1 ? "ok" : "";
  return { txt: `${arrow} ${Math.abs(delta).toFixed(1)} / 3h`, tone };
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

// Fit the nav state into the narrow status cell: a soft hyphen (U+00AD) lets it
// break into two lines on narrow screens as "Anchor-/ed", "Under-/way", "Moor-/ed".
const NAV_HYPHEN: Record<string, string> = {
  UNDERWAY: "Under­way",
  ANCHORED: "An­chored", // break at the correct syllable ("Anchor-ed" read wrong)
  MOORED: "Moored", // single syllable - no hyphen, 6 letters already fit
};
function navDisplay(s: string): string {
  if (s === "·") return "·";
  return NAV_HYPHEN[s] ?? titleCase(s);
}

export default function BridgeMarine() {
  const d = useBridgeData();
  const [baroOpen, setBaroOpen] = useState(false);
  const loading = d.snap === null;
  const trend = baroTrend(d.baroDelta);
  const lat = d.snap?.lat ?? null;
  const lon = d.snap?.lon ?? null;

  return (
    <>
    <div className="grid">
      {/* SOG - hero */}
      <div className="c c-sog">
        <div className="t">SOG · <span className="sub">Knots</span></div>
        {loading ? (
          <div className="n skel">8.4</div>
        ) : (
          <AnimatedNumber className="n" value={d.sogKn} digits={1} />
        )}
      </div>

      {/* Nav state - accent block */}
      <div className="c c-state">
        <div className="t">Nav state</div>
        <div className="s">{navDisplay(d.navState)}</div>
        <div className="meta">
          {d.snap === null ? "AWAITING FIX" : d.live ? `FIX ${d.ageSec}s · WGS84` : `STALE ${d.ageSec}s`}
        </div>
      </div>

      {/* HDG / COG */}
      <div className="c c-hdg">
        <div className="t">HDG · <span className="sub">True</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{deg(d.hdgTrue)}<span className="u">°</span></div>
      </div>
      <div className="c c-cog">
        <div className="t">COG</div>
        <div className={`n${loading ? " skel" : ""}`}>{deg(d.cogDeg)}<span className="u">°</span></div>
      </div>

      {/* Wind - dark band + gust sparkline */}
      <div className="c c-wind">
        <div className="left">
          <div className="t">Wind true{d.bft !== null && <> · <span className="sub">Bft {d.bft}</span></>}</div>
          <div className="n">{d.twsKn === null ? "·" : d.twsKn.toFixed(1)}<span className="u">kn</span></div>
        </div>
        <div className="mid">
          <span>TWD <b>{deg(d.twdDeg)}°</b></span>
          <span>AWA <b>{awa(d.awaDeg)}</b></span>
        </div>
        <div className="gust">
          <Sparkline className="spark" data={d.gustSeries} color="var(--spark-gust)" fill peak height={42} />
          <div className="lab">
            {d.gustMax ? <>GUST <b>{d.gustMax.kn.toFixed(1)} kn</b> · {formatTimeShort(d.gustMax.ts)}</> : "GUST -"}
          </div>
          <div className="gustseg" role="group" aria-label="Gust window">
            {GUST_WINDOWS.map((h) => (
              <button key={h} className={d.gustHours === h ? "on" : ""} onClick={() => d.setGustHours(h)}>
                {h}h
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Baro - cell band + sparkline; tap opens a detail popup */}
      <div className="c c-baro tap" onClick={() => setBaroOpen(true)} role="button" aria-label="Barometer detail">
        <div className="left">
          <div className="t">Baro · <span className="sub">hPa</span></div>
          <div className={`n${loading ? " skel" : ""}`}>{d.baroHPa === null ? "·" : Math.round(d.baroHPa)}</div>
          <div className={`trend ${trend.tone}`}>{trend.txt}</div>
        </div>
        <div className="sparkwrap">
          <Sparkline className="spark-b" data={d.baroSeries} color="var(--spark-baro)" height={38} top={4} />
          <div className="lab">3-hour trend · tap ⤢</div>
        </div>
      </div>

      {/* Depth - micro-diagnostic explaining a missing value (a bare "·" is confusing) */}
      <div className="c c-depth">
        <div className="t">Depth · <span className="sub">m</span></div>
        {loading ? <div className="n skel">32.4</div> : <AnimatedNumber className="n" value={d.depth} digits={1} />}
        {!loading && depthDiagLabel(d.depthDiag, d.now) && (
          <div className="meta">{depthDiagLabel(d.depthDiag, d.now)}</div>
        )}
      </div>

      {/* Position */}
      <div className="c c-pos">
        <div className="t">Position · <span className="sub">WGS84</span></div>
        <div className="coords">
          {fmtCoordDM(lat, ["N", "S"], 2)}<br />
          {fmtCoordDM(lon, ["E", "W"], 3)}
        </div>
      </div>
    </div>
    <PairBand />
    {baroOpen && <BaroPopup onClose={() => setBaroOpen(false)} current={d.baroHPa} delta={d.baroDelta} />}
    </>
  );
}
