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
 * On a phone this is one panel with a tab row: the bridge, or one system she reports, chosen by
 * a URL param (?a=engine) so the choice survives a reload and can be shared. That pane reads its
 * density off its OWN width through a container query, so a tablet in portrait, still below the
 * board threshold, gets the wider layout its width allows. On a wide screen the tabs are gone and
 * everything she reports is shown at once: the bridge full width across the top, then her systems
 * side by side beneath it. The sections are the panels she justifies, in their order, so a boat
 * with no generator has no generator section and nothing here lists them.
 *
 * Live SignalK (2s) via useBridgeData; SOG/Depth animate, gust+baro sparklines, skeleton on
 * load. Loading is NOT absence: until the first frame lands every cell is drawn as a skeleton,
 * because "she has not told us yet" and "she does not have one" are different sentences and
 * only the second one may remove a box.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import AnimatedNumber from "../../components/AnimatedNumber";
import { Sparkline } from "../../index";
import SystemsMarine from "./SystemsMarine";
import { systemClusters } from "./useSystems";
import { fmtCoordDM, formatTimeShort } from "../../lib/format";
import { depthDatumLabel } from "../../lib/depthDiag";
import { quietFor, quietSince } from "../../lib/age";
import type { MetricField } from "../../data/api";
import { useBridgeData, bridgeHasReading, type BridgeData, type GustHours } from "./useBridgeData";
import { useMediaQuery } from "../../data/useMediaQuery";
import BaroPopup from "./BaroPopup";
import PairAlerts from "./PairAlerts";
import TripComputer from "./TripComputer";
import { usePolling } from "../../data/usePolling";
import { useApi, type Voyage } from "../../data/api";

const GUST_WINDOWS: GustHours[] = [1, 6, 12, 24];

// A wide screen shows the whole dashboard at once (the board); below this it shows one panel with
// a tab row. Same threshold as the side rail in Layout, so the chrome and the content switch shape
// together.
const WIDE_QUERY = "(min-width: 1000px)";

// The open passage, asked for once a minute because that is how often the boat recomputes its
// metrics (VoyageLog replays the snapshots on a per-minute refresh). The duration cell still
// moves every second: it is drawn against the bridge's own 1s clock, not against this fetch.
const POLL_VOYAGE = 60_000;

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

function navDisplay(s: string): string {
  if (s === "·") return "·";
  return titleCase(s);
}

/**
 * How wide the state has to be set to fit its cell, in characters: its longest single word,
 * since a space is where a line may break and a letter is not.
 *
 * This replaced a table of three states carrying a soft hyphen apiece. Signal K's state is an
 * open set (motoring, sailing, aground, drifting, and whatever a gateway forwards next), so a
 * table only fits the states someone remembered to add and every other one fell through to a
 * bare overflow-wrap, which split "Motoring" across two lines as "Motorin/g" on a phone.
 * Measuring the word is one rule for every state, including the ones this build never saw.
 */
function navFitWidth(s: string): number {
  return s.split(/\s+/).reduce((w, word) => Math.max(w, word.length), 1);
}

/**
 * A cell whose instrument has stopped talking, and how long ago it last did.
 *
 * The reading stays. A boat at anchor with a cold engine is not a fault, and neither is a
 * depth sounder switched off alongside; blanking the figure would throw away the only thing
 * the boat knows and ask a question the fade already answers. This is the systems panel's
 * sentence, said the same way here because the two panels are tabs of one board.
 *
 * The position and nav-state cells are deliberately not in this scheme: they carry their own
 * freshness line ("FIX 12s", "STALE 400s"), which is older than this mechanism and says more
 * than an age does, because a fix is the one reading whose absence has its own word.
 */
function QuietAge({ s }: { s: number | null }) {
  if (s === null) return null;
  return <div className="c-age">{quietFor(s)}</div>;
}

// The band and matrix for the bridge tab, built from what the boat is saying. Pulled out of the
// panel so the same instruments render in the phone's tab and in the wide board's bridge section.
export function BridgeInstruments({ d, onBaro }: { d: BridgeData; onBaro: () => void }) {
  const loading = d.snap === null;
  const trend = baroTrend(d.baroDelta);
  const lat = d.snap?.lat ?? null;
  const lon = d.snap?.lon ?? null;

  // `has` is the rule, in one place. Until the first frame lands nothing is absent - it is
  // unknown - so everything is drawn and shimmers; after that a cell exists exactly when the
  // boat has put a value behind it.
  const has = (v: unknown) => loading || v !== null;

  // How long each instrument has been silent, asked one cell at a time, and counted from here
  // rather than from aboard.
  //
  // The frame's own age cannot answer this on its own: it is rebuilt on every poll whether or
  // not anything was measured, so a boat sailing on a live GPS reports a healthy frame while
  // her wind sensor has been dead for hours. Neither can the field's age on its own: those are
  // measured aboard when the frame is built, so a frame that stops arriving freezes them, and
  // a screen reading them alone would call a whole dead bridge current. The poller holds the
  // last frame through a failed fetch and restores one from cache on load, which is the right
  // behaviour and exactly what makes the second half matter.
  //
  // So: the age aboard plus the age of the frame carrying it. This is the sum the shore portal
  // has always used, and the two screens now answer the question the same way.
  const quiet = (f: MetricField) => {
    const aboard = d.snap?.field_ages?.[f];
    if (typeof aboard !== "number") return null;
    return quietSince(aboard + (d.frameAgeSec ?? 0));
  };
  const cell = (name: string, q: number | null) => `c ${name}${q !== null ? " quiet" : ""}`;

  const band: ReactNode[] = [];
  const qSog = quiet("sog");
  if (has(d.sogKn)) {
    band.push(
      <div className={cell("c-sog", qSog)} key="sog">
        <div className="t">SOG · <span className="sub">Knots</span></div>
        {loading ? (
          <div className="n skel">8.4</div>
        ) : (
          <AnimatedNumber className="n" value={d.sogKn} digits={1} />
        )}
        <QuietAge s={qSog} />
      </div>,
    );
  }
  // Nav state carries the fix line, which is about the position rather than the state, so it
  // earns its cell on either.
  if (has(d.snap?.nav_state ?? null) || has(lat)) {
    band.push(
      <div className="c c-state" key="state">
        <div className="t">Nav state</div>
        <div className="s" style={{ "--nav-w": navFitWidth(navDisplay(d.navState)) } as CSSProperties}>
          {navDisplay(d.navState)}
        </div>
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
  const qCog = quiet("cog");
  if (has(d.cogDeg)) {
    matrix.push(
      <div className={cell("c-cog", qCog)} key="cog">
        <div className="t">COG</div>
        <div className={`n${loading ? " skel" : ""}`}>{deg(d.cogDeg)}<span className="u">°</span></div>
        <QuietAge s={qCog} />
      </div>,
    );
  }
  const qHdg = quiet("heading_true");
  if (has(d.hdgTrue)) {
    matrix.push(
      <div className={cell("c-hdg", qHdg)} key="hdg">
        <div className="t">HDG · <span className="sub">True</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{deg(d.hdgTrue)}<span className="u">°</span></div>
        <QuietAge s={qHdg} />
      </div>,
    );
  }
  const qTws = quiet("wind_speed_true");
  if (has(d.twsKn)) {
    matrix.push(
      <div className={cell("c-windtrue", qTws)} key="windtrue">
        <div className="t">Wind true{d.bft !== null && <> · <span className="sub">Bft {d.bft}</span></>}</div>
        <div className={`n${loading ? " skel" : ""}`}>
          {d.twsKn === null ? "·" : d.twsKn.toFixed(1)}<span className="u">kn</span>
        </div>
        <QuietAge s={qTws} />
      </div>,
    );
  }
  const qTwd = quiet("wind_direction_true");
  if (has(d.twdDeg)) {
    matrix.push(
      <div className={cell("c-windfrom", qTwd)} key="windfrom">
        <div className="t">Wind from · <span className="sub">True</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{deg(d.twdDeg)}<span className="u">°</span></div>
        <QuietAge s={qTwd} />
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
  const qAwa = quiet("wind_angle_apparent");
  if (has(d.awaDeg)) {
    matrix.push(
      <div className={cell("c-awa", qAwa)} key="awa">
        <div className="t">AWA · <span className="sub">Apparent</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{awa(d.awaDeg)}</div>
        <QuietAge s={qAwa} />
      </div>,
    );
  }
  // The barometer is the one figure that need not come off the frame: with no live pressure
  // path it falls back to the last hours of recorded history, and there is no field age behind
  // that number. quiet() is null there by construction - the plugin sends an age only for a
  // field it has a value for - so the fallback figure is drawn unqualified, which is right: an
  // age taken from the missing live path would describe a different number than the one shown.
  const qBaro = quiet("air_pressure_pa");
  if (has(d.baroHPa)) {
    matrix.push(
      <div className={`${cell("c-baro", qBaro)} tap`} key="baro" onClick={onBaro} role="button" aria-label="Barometer detail">
        <div className="t">
          Baro · <span className="sub">hPa</span>
          {/* The one mark that says the cell opens. It replaces a caption reading "3-hour trend
              tap" that took a third of the cell to say it, and sat where the trend line should
              have been. What the line covers is the popup's to state, on the axis it draws. */}
          <span className="zoom" aria-hidden="true">⤢</span>
        </div>
        <div className="baro-read">
          <div className={`n${loading ? " skel" : ""}`}>{d.baroHPa === null ? "·" : Math.round(d.baroHPa)}</div>
          <div className={`trend ${trend.tone}`}>{trend.txt}</div>
        </div>
        <Sparkline className="spark-b" data={d.baroSeries} color="var(--spark-baro)" height={38} top={4} />
        <QuietAge s={qBaro} />
      </div>,
    );
  }
  const qAir = quiet("air_temp_k");
  if (has(d.airC)) {
    matrix.push(
      <div className={cell("c-air", qAir)} key="air">
        <div className="t">Air · <span className="sub">Outside</span></div>
        <div className={`n${loading ? " skel" : ""}`}>
          {d.airC === null ? "·" : d.airC.toFixed(1)}<span className="u">°C</span>
        </div>
        <QuietAge s={qAir} />
      </div>,
    );
  }
  const qSea = quiet("water_temp_k");
  if (has(d.waterC)) {
    matrix.push(
      <div className={cell("c-sea", qSea)} key="sea">
        <div className="t">Sea · <span className="sub">Water</span></div>
        <div className={`n${loading ? " skel" : ""}`}>
          {d.waterC === null ? "·" : d.waterC.toFixed(1)}<span className="u">°C</span>
        </div>
        <QuietAge s={qSea} />
      </div>,
    );
  }
  // Depth keeps its micro-diagnosis: a sounder that HAS reported and went quiet is a different
  // sentence from a boat with no sounder, and only the second one loses the cell.
  const qDepth = quiet("depth");
  if (has(d.depth)) {
    matrix.push(
      <div className={cell("c-depth", qDepth)} key="depth">
        <div className="t">Depth · <span className="sub">m</span></div>
        {loading ? <div className="n skel">32.4</div> : <AnimatedNumber className="n" value={d.depth} digits={1} />}
        {/* The plane this number is measured from, named only beside a number: a datum
            without its reading dates nothing, and a reading without its datum is the lie
            this field exists to end. The label changes the moment the plugin switches
            planes, which is the switch nothing on this screen could show before. */}
        {!loading && d.depth !== null && (
          <div className="meta">{depthDatumLabel(d.snap?.depth_datum)}</div>
        )}
        <QuietAge s={qDepth} />
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
  voyage,
  onTab,
  onBaro,
  clusters,
}: {
  tab: string;
  tabs: { key: string; name: string }[];
  d: BridgeData;
  voyage: Voyage | null;
  onTab: (key: string) => void;
  onBaro: () => void;
  clusters: ReturnType<typeof systemClusters>;
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
      ) : tab === "trip" ? (
        <TripComputer voyage={voyage} now={d.now} />
      ) : (
        clusters
          .filter((c) => c.key === tab)
          .map((c) => <SystemsMarine key={c.key} cluster={c} />)
      )}
    </div>
  );
}

export default function BridgeMarine() {
  const api = useApi();
  const d = useBridgeData();
  const [baroOpen, setBaroOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const wide = useMediaQuery(WIDE_QUERY);
  const openBaro = () => setBaroOpen(true);

  // The sections this boat justifies, worked out from what she is saying. The systems come from
  // the plugin's own path families; the bridge is one more section on the same footing, present
  // when she reports any nav or environment reading and absent when she does not, so a boat that
  // sends only an engine has no empty bridge. The one exception is a boat reporting nothing at
  // all: the bridge stays as the single section so the screen can name why (see BridgeInstruments'
  // quiet cell) rather than going blank. There is no list of any of this to maintain.
  const clusters = systemClusters(d.snap, d.frameAgeSec ?? 0);
  const loading = d.snap === null;
  const showBridge = loading || bridgeHasReading(d) || clusters.length === 0;

  // The trip computer is one more section on the same footing as the systems: present when she
  // is on a passage, absent when she is not. `/voyages/current` answers null unless a voyage is
  // open, so there is no flag to keep and nothing to switch off - a boat alongside simply has no
  // trip to compute.
  const { data: voyage } = usePolling<Voyage | null>(api.voyage.current, POLL_VOYAGE);
  const onPassage = voyage != null;

  // The board shows everything at once, so there is nothing to pick and no param to keep. The
  // bridge runs full width across the top - it answers "where is she and what is she doing", the
  // question asked before any other - and beneath it her systems sit side by side, so an owner
  // reads position, then engines against generators against tanks, in one glance. The chart is not
  // here: it has its own Map tab, and pinning a live chart beside the instruments only halved the
  // room the readings had. A boat with no systems shows the bridge alone.
  if (wide) {
    return (
      <>
        {/* Above the readings rather than under them. What is left of the pairing band is the
            part an owner has to act on, and the foot of a screen he reads from the top is
            where a warning goes to be missed. */}
        <PairAlerts sealing={d.sealing} />
        <div className="sp-dash sp-board">
          {showBridge && (
            <section className="sp-sec sp-sec-bridge">
              <h2 className="sp-sec-h">
                <span className="sp-sec-n">Bridge</span>
              </h2>
              <BridgeInstruments d={d} onBaro={openBaro} />
            </section>
          )}
          {(clusters.length > 0 || onPassage) && (
            <div className="sp-systems">
              {clusters.map((c) => (
                <SystemsMarine key={c.key} cluster={c} />
              ))}
              {onPassage && (
                <section className="sp-sec sp-sec-trip" key="trip">
                  <h2 className="sp-sec-h">
                    <span className="sp-sec-n">Trip computer</span>
                  </h2>
                  <TripComputer voyage={voyage} now={d.now} />
                </section>
              )}
            </div>
          )}
        </div>
        {baroOpen && <BaroPopup onClose={() => setBaroOpen(false)} current={d.baroHPa} delta={d.baroDelta} />}
      </>
    );
  }

  // Phone: one panel with a tab row, the same sections one at a time. The tab is a URL param so it
  // survives a reload and can be shared; a tab that no longer resolves (a system that went quiet,
  // or the bridge on a boat that only reports an engine) falls back to the first tab there is.
  const tabs = [
    ...(showBridge ? [{ key: "bridge", name: "Bridge" }] : []),
    ...clusters.map((c) => ({ key: c.key as string, name: c.name })),
    ...(onPassage ? [{ key: "trip", name: "Trip" }] : []),
  ];
  const valid = (k: string | null) => (k && tabs.some((t) => t.key === k) ? k : null);
  const a = valid(params.get("a")) ?? tabs[0]?.key ?? "bridge";
  const setTab = (key: string) => {
    const next = new URLSearchParams(params);
    next.set("a", key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PairAlerts sealing={d.sealing} />
      <div className="sp-dash">
        <DashPanel
          tab={a}
          tabs={tabs}
          d={d}
          voyage={voyage}
          clusters={clusters}
          onTab={setTab}
          onBaro={openBaro}
        />
      </div>
      {baroOpen && <BaroPopup onClose={() => setBaroOpen(false)} current={d.baroHPa} delta={d.baroDelta} />}
    </>
  );
}
