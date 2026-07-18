/* Bridge - Instruments (Swiss redesign).
 *
 * The bridge is laid out from what the boat reports. A reading she has never sent has no box
 * here: not an empty one, none. `null` on the snapshot means the plugin has not seen that
 * path since it started, and Signal K serves a path's last value forever - so one frame, ever,
 * is enough to earn a cell for good, and a boat with no wind instrument simply has no wind
 * cells. That is the whole rule, and it is why there is no picture of this screen anywhere.
 *
 * Two tiers. The band answers "where is she and what is she doing"; the matrix carries every
 * other reading, equal cells. A tier with no members is not rendered - see swiss.css, where
 * the survivor takes the glass.
 *
 * The dashboard is a panel, and on a wide screen there are two of them side by side: the
 * bridge and one system at once, each with its own tab row, each driven by a URL param
 * (?a=bridge&b=engine) so the pair survives a reload and can be shared ashore. A panel picks
 * its layout from its OWN width, not the window's, through a container query - so a half-width
 * pane on an iPad takes the narrow layout a phone would. Below the split threshold there is one
 * panel; the second param stays in the URL, so turning the iPad back brings the pair back.
 *
 * Live SignalK (2s) via useBridgeData; SOG/Depth animate, gust+baro sparklines, skeleton on
 * load. Loading is NOT absence: until the first frame lands every cell is drawn as a skeleton,
 * because "she has not told us yet" and "she does not have one" are different sentences and
 * only the second one may remove a box.
 */
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import AnimatedNumber from "../../components/AnimatedNumber";
import { Sparkline } from "siparu-ui";
import SystemsMarine from "./SystemsMarine";
import { systemPanels } from "./useSystems";
import { fmtCoordDM, formatTimeShort } from "../../lib/format";
import { depthDiagLabel } from "../../lib/depthDiag";
import { useBridgeData, type BridgeData, type GustHours } from "./useBridgeData";
import { useMediaQuery } from "../../lib/useMediaQuery";
import BaroPopup from "./BaroPopup";
import PairBand from "./PairBand";

const GUST_WINDOWS: GustHours[] = [1, 6, 12, 24];

// A wide screen carries two panels; below this it carries one. The pane, not the window, then
// decides each panel's density (see swiss.css, @container pane).
const SPLIT_QUERY = "(min-width: 1000px)";

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

// The band and matrix for the bridge tab, built from what the boat is saying. Pulled out of the
// panel so the same instruments can be drawn on either side of a split.
function BridgeInstruments({ d, onBaro }: { d: BridgeData; onBaro: () => void }) {
  const loading = d.snap === null;
  const trend = baroTrend(d.baroDelta);
  const lat = d.snap?.lat ?? null;
  const lon = d.snap?.lon ?? null;

  // `has` is the rule, in one place. Until the first frame lands nothing is absent - it is
  // unknown - so everything is drawn and shimmers; after that a cell exists exactly when the
  // boat has put a value behind it.
  const has = (v: unknown) => loading || v !== null;

  const band: ReactNode[] = [];
  if (has(d.sogKn)) {
    band.push(
      <div className="c c-sog" key="sog">
        <div className="t">SOG · <span className="sub">Knots</span></div>
        {loading ? (
          <div className="n skel">8.4</div>
        ) : (
          <AnimatedNumber className="n" value={d.sogKn} digits={1} />
        )}
      </div>,
    );
  }
  // Nav state carries the fix line, which is about the position rather than the state, so it
  // earns its cell on either.
  if (has(d.snap?.nav_state ?? null) || has(lat)) {
    band.push(
      <div className="c c-state" key="state">
        <div className="t">Nav state</div>
        <div className="s">{navDisplay(d.navState)}</div>
        <div className="meta">
          {d.snap === null || !d.hasFix
            ? "AWAITING FIX"
            : d.live
              ? `FIX ${d.ageSec}s · WGS84`
              : `STALE ${d.ageSec}s`}
        </div>
      </div>,
    );
  }
  // A latitude without a longitude is not a position. The plugin pairs them, and so does this.
  if (has(lat) && has(lon)) {
    band.push(
      <div className="c c-pos" key="pos">
        <div className="t">Position · <span className="sub">WGS84</span></div>
        <div className="coords">
          {fmtCoordDM(lat, ["N", "S"], 2)}<br />
          {fmtCoordDM(lon, ["E", "W"], 3)}
        </div>
      </div>,
    );
  }

  const matrix: ReactNode[] = [];
  if (has(d.cogDeg)) {
    matrix.push(
      <div className="c c-cog" key="cog">
        <div className="t">COG</div>
        <div className={`n${loading ? " skel" : ""}`}>{deg(d.cogDeg)}<span className="u">°</span></div>
      </div>,
    );
  }
  if (has(d.hdgTrue)) {
    matrix.push(
      <div className="c c-hdg" key="hdg">
        <div className="t">HDG · <span className="sub">True</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{deg(d.hdgTrue)}<span className="u">°</span></div>
      </div>,
    );
  }
  if (has(d.twsKn)) {
    matrix.push(
      <div className="c c-windtrue" key="windtrue">
        <div className="t">Wind true{d.bft !== null && <> · <span className="sub">Bft {d.bft}</span></>}</div>
        <div className={`n${loading ? " skel" : ""}`}>
          {d.twsKn === null ? "·" : d.twsKn.toFixed(1)}<span className="u">kn</span>
        </div>
      </div>,
    );
  }
  if (has(d.twdDeg)) {
    matrix.push(
      <div className="c c-windfrom" key="windfrom">
        <div className="t">Wind from · <span className="sub">True</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{deg(d.twdDeg)}<span className="u">°</span></div>
      </div>,
    );
  }
  // Gust is a max-hold the plugin computes, not a path the boat sends, so it exists when true
  // wind does - there is nothing else to ask.
  if (has(d.twsKn)) {
    matrix.push(
      <div className="c c-gust" key="gust">
        <div className="t">Gust</div>
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
      </div>,
    );
  }
  if (has(d.awaDeg)) {
    matrix.push(
      <div className="c c-awa" key="awa">
        <div className="t">AWA · <span className="sub">Apparent</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{awa(d.awaDeg)}</div>
      </div>,
    );
  }
  if (has(d.baroHPa)) {
    matrix.push(
      <div className="c c-baro tap" key="baro" onClick={onBaro} role="button" aria-label="Barometer detail">
        <div className="left">
          <div className="t">Baro · <span className="sub">hPa</span></div>
          <div className={`n${loading ? " skel" : ""}`}>{d.baroHPa === null ? "·" : Math.round(d.baroHPa)}</div>
          <div className={`trend ${trend.tone}`}>{trend.txt}</div>
        </div>
        <div className="sparkwrap">
          <Sparkline className="spark-b" data={d.baroSeries} color="var(--spark-baro)" height={38} top={4} />
          <div className="lab">3-hour trend · tap ⤢</div>
        </div>
      </div>,
    );
  }
  if (has(d.airC)) {
    matrix.push(
      <div className="c c-air" key="air">
        <div className="t">Air · <span className="sub">Outside</span></div>
        <div className={`n${loading ? " skel" : ""}`}>
          {d.airC === null ? "·" : d.airC.toFixed(1)}<span className="u">°C</span>
        </div>
      </div>,
    );
  }
  if (has(d.waterC)) {
    matrix.push(
      <div className="c c-sea" key="sea">
        <div className="t">Sea · <span className="sub">Water</span></div>
        <div className={`n${loading ? " skel" : ""}`}>
          {d.waterC === null ? "·" : d.waterC.toFixed(1)}<span className="u">°C</span>
        </div>
      </div>,
    );
  }
  // Depth keeps its micro-diagnosis: a sounder that HAS reported and went quiet is a different
  // sentence from a boat with no sounder, and only the second one loses the cell.
  if (has(d.depth)) {
    matrix.push(
      <div className="c c-depth" key="depth">
        <div className="t">Depth · <span className="sub">m</span></div>
        {loading ? <div className="n skel">32.4</div> : <AnimatedNumber className="n" value={d.depth} digits={1} />}
        {!loading && depthDiagLabel(d.depthDiag, d.now) && (
          <div className="meta">{depthDiagLabel(d.depthDiag, d.now)}</div>
        )}
      </div>,
    );
  }

  return (
    <div className="grid">
      {band.length > 0 && <div className="band">{band}</div>}
      {matrix.length > 0 && <div className="matrix">{matrix}</div>}
      {/* A boat reporting nothing at all is the one case the rule cannot answer by removing a
          box, because there is no box left to remove and an empty screen reads as a broken
          product rather than as a quiet boat. Seen on a real Signal K with no instruments on
          the bus: LIVE lit, clock running, nothing else. So the absence gets named, and named
          as normal - she is alongside with the panel off, which is what she should say. */}
      {!loading && band.length === 0 && matrix.length === 0 && (
        <div className="c c-quiet">
          <div className="t">No instruments reporting</div>
          <div className="meta">
            Signal K is connected and carries no position, speed, wind or depth for this
            vessel. Alongside with the instruments switched off, this is the expected reading.
          </div>
        </div>
      )}
    </div>
  );
}

// One panel: its own tab row, and beneath it the bridge or one system. A container query lives
// on .sp-pane (swiss.css), so the panel reads its layout off its own width.
function DashPanel({
  tab,
  tabs,
  d,
  onTab,
  onBaro,
}: {
  tab: string;
  tabs: { key: string; name: string }[];
  d: BridgeData;
  onTab: (key: string) => void;
  onBaro: () => void;
}) {
  return (
    <div className="sp-pane">
      {tabs.length > 1 && (
        <nav className="sy-tabs" aria-label="Instrument panels">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`sy-tab${tab === t.key ? " on" : ""}`}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => onTab(t.key)}
            >
              {t.name}
            </button>
          ))}
        </nav>
      )}
      {tab === "bridge" ? (
        <BridgeInstruments d={d} onBaro={onBaro} />
      ) : (
        <SystemsMarine snap={d.snap} tab={tab} />
      )}
    </div>
  );
}

export default function BridgeMarine() {
  const d = useBridgeData();
  const [baroOpen, setBaroOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const wide = useMediaQuery(SPLIT_QUERY);

  // The panels this boat justifies, worked out from what she is saying. Bridge is always here:
  // she has a position whether or not she has an engine. The rest appear because she reports
  // them, in the package's order, and there is no list of them anywhere to maintain.
  const panels = systemPanels(d.snap);
  const tabs = [{ key: "bridge", name: "Bridge" }, ...panels.map((p) => ({ key: p.key as string, name: p.name }))];
  const valid = (k: string | null) => (k && tabs.some((t) => t.key === k) ? k : null);

  const a = valid(params.get("a")) ?? "bridge";
  // The right panel exists only on a wide screen. An explicit b that no longer resolves (the
  // engine that stopped reporting this session) collapses the panel rather than falling back to
  // the bridge, because two bridges reads as a bug. With no b at all, a wide screen opens the
  // first system beside the bridge, so the dashboard is two-up by default where there is room.
  const bParam = params.get("b");
  const b = wide ? (bParam !== null ? valid(bParam) : (panels[0]?.key ?? null)) : null;
  const twoUp = b !== null;

  const setSide = (side: "a" | "b", key: string) => {
    const next = new URLSearchParams(params);
    next.set(side, key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <div className={`sp-dash${twoUp ? " split" : ""}`}>
        <DashPanel tab={a} tabs={tabs} d={d} onTab={(k) => setSide("a", k)} onBaro={() => setBaroOpen(true)} />
        {twoUp && (
          <DashPanel tab={b} tabs={tabs} d={d} onTab={(k) => setSide("b", k)} onBaro={() => setBaroOpen(true)} />
        )}
      </div>
      <PairBand />
      {baroOpen && <BaroPopup onClose={() => setBaroOpen(false)} current={d.baroHPa} delta={d.baroDelta} />}
    </>
  );
}
