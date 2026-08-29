/* Voyage - auto-detected passages.
 * Brutalist layout: active-passage banner + window summary grid + voyage list.
 * Tapping a row expands it: MapLibre track map (same style as the Map tab, pan/zoom)
 * plus port/coordinate detail, including fuel burned when the engines report it.
 * Data comes from voyage/useVoyageData.ts; header + tab bar from Layout. */
import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { Voyage, VoyageRollup, VoyageStatsCards, TrackPoint, FuelPathsView } from "../../lib/api";
import { ageOf } from "../../lib/age";
import { fmtCoordDM, fmtNum } from "../../lib/format";
import { FUEL_MODES, fuelReadout, type FuelMode } from "../../lib/fuel";
import { downloadText, exportFilename, trackGpx, voyagesCsv } from "../../lib/export";
import { useVoyageData, type StatWindow } from "./useVoyageData";
import { useMediaQuery } from "../../lib/useMediaQuery";
import VoyageTrackMap from "./VoyageTrackMap";
import FuelSourceSheet from "./FuelSourceSheet";
import { fuelSourceNotice, fuelSourceOffered, fuelSourceSummary } from "../../lib/fuelSource";

const FUEL_MODE_KEY = "siparu.fuelMode";

function initFuelMode(): FuelMode {
  const stored = localStorage.getItem(FUEL_MODE_KEY);
  return FUEL_MODES.some((m) => m.mode === stored) ? (stored as FuelMode) : "total_l";
}

/* The width where the page becomes a board: same threshold as the layout's rail and the
   dashboard, so the whole app changes shape at one width. */
const WIDE_QUERY = "(min-width: 1000px)";

const WINDOWS: { k: StatWindow; label: string }[] = [
  { k: "today", label: "Today" },
  { k: "yesterday", label: "Yesterday" },
  { k: "rolling_7d", label: "7 days" },
  { k: "season", label: "Season" },
];

/**
 * Why an edit did not happen, said the way it would be said aloud. The plugin
 * answers in codes so it does not carry a vocabulary; the wording lives here.
 */
const EDIT_ERRORS: Record<string, string> = {
  not_found: "That passage is no longer in the log.",
  no_previous: "There is no earlier passage to join this one to.",
  voyage_open: "This passage is still being recorded. It can be edited once it ends.",
  nothing_to_undo: "This passage was not joined by hand.",
  admin_required: "Sign in to Signal K as an administrator to edit the log.",
  security_off: "Signal K security is off, so the log is locked. Add an admin user in Signal K.",
};

/** Format a duration given in hours as "3h 12m" / "47m". */
function fmtDur(h: number | null): string {
  if (h === null || h <= 0) return "·";
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** How long ago the boat was last heard, for a badge over an answer that may be old. */
function agoShort(ts: number): string {
  const { value, unit } = ageOf((Date.now() - ts) / 1000);
  return `${value}${unit === "s" ? "s" : ` ${unit}`} ago`;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Route label like "Monaco → Saint-Tropez"; null when no port is known (coordinate fallback). */
function routeLabel(v: Voyage): string | null {
  if (!v.start_port && !v.end_port) return null;
  if (v.end_ts === null) return v.start_port ? `${v.start_port} →` : null;
  return `${v.start_port ?? "·"} → ${v.end_port ?? "·"}`;
}

export default function VoyageMarine() {
  // Bumped after a fuel-source change: the plugin restarts and re-integrates
  // every voyage, so stats + list + current are re-fetched under the new figure.
  const [reloadKey, setReloadKey] = useState(0);
  const d = useVoyageData(reloadKey);
  const wide = useMediaQuery(WIDE_QUERY);
  const [win, setWin] = useState<StatWindow>("today");
  const [openId, setOpenId] = useState<number | null>(null);
  const [tracks, setTracks] = useState<Record<number, TrackPoint[]>>({});
  const [fuelMode, setFuelMode] = useState<FuelMode>(initFuelMode);
  const [fuelView, setFuelView] = useState<FuelPathsView | null>(null);
  const [showFuel, setShowFuel] = useState(false);
  // Read once, and only used on paper: a printed passage record that does not say
  // which boat it belongs to is not a record of anything.
  const [boatName, setBoatName] = useState<string | null>(null);
  const [merged, setMerged] = useState<number[]>([]);
  const [editErr, setEditErr] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(FUEL_MODE_KEY, fuelMode);
  }, [fuelMode]);

  useEffect(() => {
    let ok = true;
    api
      .health()
      .then((h) => {
        if (ok) setBoatName(h.boat_name);
      })
      .catch(() => {
        /* the printed heading falls back to a generic title */
      });
    return () => {
      ok = false;
    };
  }, []);

  useEffect(() => {
    let ok = true;
    api.voyage
      .edits()
      .then((e) => {
        if (ok) setMerged(e.merged);
      })
      .catch(() => {
        // An older plugin has no such route. No undo offered, nothing else changes.
      });
    return () => {
      ok = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    let cancelled = false;
    api.config
      .fuelPaths()
      .then((v) => !cancelled && setFuelView(v))
      .catch(() => {
        /* the picker just stays hidden if the config read fails */
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Offered when there is a choice to make, and whenever a selection is in
  // force - a filter naming an engine that has gone quiet has to stay reachable.
  const canPick = !!fuelView && fuelSourceOffered(fuelView);
  // Why a passage that clearly ran the engine shows no fuel at all.
  const fuelNotice = fuelView ? fuelSourceNotice(fuelView) : null;

  const active = d.current && d.current.end_ts === null ? d.current : null;

  const toggle = async (id: number) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (!tracks[id]) {
      try {
        const t = await api.voyage.track(id);
        setTracks((prev) => ({ ...prev, [id]: t }));
      } catch {
        /* silent - the expanded detail still shows coordinates even without a map */
      }
    }
  };

  const roll = d.stats?.[win] ?? null;

  /**
   * Run an edit and reload from the boat rather than patching what is on screen.
   * The plugin re-integrates the whole span, so every figure in the list can move,
   * and a screen that guessed at the new ones would be showing arithmetic the boat
   * did not do.
   */
  const runEdit = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setEditErr(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setEditErr(EDIT_ERRORS[res.error ?? ""] ?? "That edit could not be made.");
        return;
      }
      setOpenId(null);
      setTracks({});
      setReloadKey((k) => k + 1);
    } catch (e) {
      // A refusal is an answer: the plugin says why in a code (and a message),
      // and "did not answer" would blame the network for a door that is locked.
      if (e instanceof ApiError) setEditErr(EDIT_ERRORS[e.code ?? ""] ?? (e.detail || "That edit could not be made."));
      else setEditErr("The boat did not answer.");
    }
  };

  return (
    <div className="vy">
      {/* Paper only. On screen the boat is whichever one you opened, and the date
          is in the header clock. */}
      <div className="vy-print-hd" aria-hidden="true">
        <span className="b">{boatName ?? "Passage record"}</span>
        <span className="d">{new Date().toISOString().slice(0, 10)}</span>
      </div>

      {/* The page is clusters on the glass, like the board and the remote screen: each
          under the systems' heading band, its contents as cells on one blurred sheet. */}
      {active && (
        <section className="sp-sec vy-sec-active">
          <h2 className="sp-sec-h">
            <span className="sp-sec-n">Under way</span>
            {active.start_port ? <span className="sp-sec-note">from {active.start_port}</span> : null}
            {/* The pulse is a claim of NOW, and the poll behind it can be failing while
                `active` still holds the last answer. A dead link drops the lamp and says
                how old the answer is, instead of beating over figures nobody is sending -
                the same rule the remote page's ON lamp keeps. */}
            {d.currentStale ? (
              <span className="sp-sec-badge quiet">
                since {hhmm(active.start_ts)}
                {d.currentSeenTs !== null ? ` · last seen ${agoShort(d.currentSeenTs)}` : " · unreachable"}
              </span>
            ) : (
              <span className="sp-sec-badge">
                <span className="vy-pulse" aria-hidden="true" />
                since {hhmm(active.start_ts)}
              </span>
            )}
          </h2>
          <div className="sp-glass">
            <ActiveBanner v={active} />
          </div>
        </section>
      )}

      <section className="sp-sec vy-sec-totals">
        <h2 className="sp-sec-h">
          <span className="sp-sec-n">Totals</span>
          {/* The note names the window on show. The board shows all four at once, so there
              it would be naming a choice the reader is not making. */}
          {!wide && (
            <span className="sp-sec-note">{WINDOWS.find((w) => w.k === win)?.label.toLowerCase()}</span>
          )}
          {/* The cells below print dots when the load failed; a band that said nothing over
              them would leave the dots unexplained two clusters above the error's sentence. */}
          {/* Keyed on the error alone, like the Voyages band beside it: two clusters fed by
              the one failed fetch must not tell two stories. */}
          {d.err ? <span className="sp-sec-badge quiet">unreachable</span> : null}
        </h2>
        <div className="sp-glass">
          {wide ? (
            /* The desk gets every window at once, the way the engineer's table lays machines
               against each other: today against the season is a comparison, and a picker that
               shows one at a time was making the reader hold the other three in his head. The
               phone keeps the picker - four columns of figures do not fit a hand. */
            <TotalsMatrix stats={d.stats} loading={d.loading} />
          ) : (
            <>
              <div className="vy-seg seg" role="group" aria-label="Stats window">
                {WINDOWS.map((w) => (
                  <button key={w.k} className={win === w.k ? "on" : ""} onClick={() => setWin(w.k)}>
                    {w.label}
                  </button>
                ))}
              </div>
              <StatsGrid roll={roll} loading={d.loading} />
            </>
          )}
        </div>
      </section>

      <section className="sp-sec vy-sec-voyages">
        <h2 className="sp-sec-h">
          <span className="sp-sec-n">Voyages</span>
          {/* Counted off what the sheet below actually shows, err and loading included: a
              badge saying 3 over "She did not answer in time" is the lie the design rubric
              now names. The list is fetched capped at 50, so 50 is "shown", not "all". */}
          {d.err ? (
            <span className="sp-sec-badge quiet">unreachable</span>
          ) : d.loading && d.list.length === 0 ? null : (
            <span className="sp-sec-badge">
              {d.list.length === 50 ? "50 shown" : d.list.length}
            </span>
          )}
        </h2>
        <div className="sp-glass">
          {(canPick || d.list.length > 0) && (
          <div className="vy-hd">
            <span className="vy-hd-acts">
              {canPick && (
                <button type="button" className="vy-fuelsrc" onClick={() => setShowFuel(true)}>
                  Fuel · {fuelSourceSummary(fuelView!)}
                </button>
              )}
              {d.list.length > 0 && (
                <button
                  type="button"
                  className="vy-fuelsrc"
                  onClick={() =>
                    downloadText(
                      exportFilename("siparu-voyages", Date.now(), "csv"),
                      "text/csv",
                      voyagesCsv(d.list),
                    )
                  }
                >
                  CSV
                </button>
              )}
              {/* The browser's own print dialogue is where a PDF comes from on every
                  platform this runs on, including the iPad. The button is here because
                  nobody looks for a print menu inside a boat app. */}
              {d.list.length > 0 && (
                <button type="button" className="vy-fuelsrc" onClick={() => window.print()}>
                  Print
                </button>
              )}
            </span>
          </div>
          )}

          {d.err ? (
            <div className="vy-err">{d.err}</div>
          ) : !d.loading && d.list.length === 0 ? (
            <div className="sp-empty">
              <div className="em-t">No voyages yet</div>
              <div className="em-s">Passages appear here once the boat gets under way.</div>
            </div>
          ) : (
            <div className="vy-list">
              {d.list.map((v, i) => (
                <VoyageRow
                  key={v.id}
                  v={v}
                  // The list runs newest first, so the passage before this one is the
                  // next row down. Undefined at the bottom of a truncated list, where
                  // there may well be an earlier one the boat still knows about; the
                  // plugin answers no_previous only when there truly is none.
                  prev={d.list[i + 1]}
                  wasJoined={merged.includes(v.id)}
                  open={openId === v.id}
                  track={tracks[v.id]}
                  fuelNotice={fuelNotice}
                  fuelMode={fuelMode}
                  onFuelMode={setFuelMode}
                  onToggle={() => toggle(v.id)}
                  onMerge={() => runEdit(() => api.voyage.mergePrevious(v.id))}
                  onUndoMerge={() => runEdit(() => api.voyage.undoMerge(v.id))}
                  editErr={openId === v.id ? editErr : null}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {showFuel && fuelView && (
        <FuelSourceSheet
          view={fuelView}
          onClose={() => setShowFuel(false)}
          onApplied={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

function ActiveBanner({ v }: { v: Voyage }) {
  return (
    <div className="vy-active">
      {/* No heading row of its own any more: the cluster band above carries the name, the
          port and the start time, with the pulse on its badge. */}
      <div className="vy-active-grid">
        <div className="vy-a-hero">
          <div className="t">Distance · <span className="sub">nm</span></div>
          <div className="n">{fmtNum(v.distance_nm, 1)}</div>
        </div>
        <div className="vy-a-cell">
          <div className="t">Underway</div>
          <div className="v">{fmtDur(v.hours_underway)}</div>
        </div>
        <div className="vy-a-cell">
          <div className="t">Avg SOG</div>
          <div className="v">{v.avg_sog_kn === null ? "·" : <>{v.avg_sog_kn.toFixed(1)}<span className="u">kn</span></>}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Every window at once, metrics down the side: the same figures the picker showed one
 * window at a time, laid out so a season can be read against a day. Nothing here is a new
 * fetch - the stats call has always answered all four windows, and the screen was throwing
 * three of them away.
 */
function TotalsMatrix({ stats, loading }: { stats: VoyageStatsCards | null; loading: boolean }) {
  const val = (w: StatWindow, f: (r: VoyageRollup) => string): string =>
    stats ? f(stats[w]) : "·";
  const row = (label: string, unit: string | null, f: (r: VoyageRollup) => string, hero = false) => (
    <>
      <span className={`mx-r${hero ? " mx-hero-r" : ""}`}>
        {label}
        {unit ? <span className="mx-u">· {unit}</span> : null}
      </span>
      {WINDOWS.map((w) => (
        // The shimmer rides an inner span with a placeholder figure, the way the phone's
        // StatsGrid loads: a bare loading cell printed nothing at all and read as the
        // product's own "she does not report this" mark.
        <span key={w.k} className={`mx-v${hero ? " mx-hero" : ""}`}>
          <span className={loading ? "skel" : undefined}>{loading ? "128.4" : val(w.k, f)}</span>
        </span>
      ))}
    </>
  );
  return (
    <div className="vy-matrix">
      <span className="mx-corner" aria-hidden="true" />
      {WINDOWS.map((w) => (
        <span key={w.k} className="mx-h">
          {w.label}
        </span>
      ))}
      {row("Distance", "nm", (r) => fmtNum(r.distance_nm, 1), true)}
      {row("Underway", null, (r) => fmtDur(r.hours_underway))}
      {row("Avg SOG", "kn", (r) => (r.avg_sog_kn == null ? "·" : r.avg_sog_kn.toFixed(1)))}
      {row("Max SOG", "kn", (r) => (r.max_sog_kn == null ? "·" : r.max_sog_kn.toFixed(1)))}
    </div>
  );
}

function StatsGrid({ roll, loading }: { roll: VoyageRollup | null; loading: boolean }) {
  const dash = loading ? "" : "·";
  return (
    <div className="vy-cards">
      <div className="c vy-hero">
        <div className="t">Distance · <span className="sub">nm</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{loading ? "128.4" : roll ? fmtNum(roll.distance_nm, 1) : dash}</div>
      </div>
      <div className="c">
        <div className="t">Underway</div>
        <div className="v">{roll ? fmtDur(roll.hours_underway) : dash}</div>
      </div>
      <div className="c">
        <div className="t">Avg SOG</div>
        <div className="v">{roll?.avg_sog_kn == null ? dash : <>{roll.avg_sog_kn.toFixed(1)}<span className="u">kn</span></>}</div>
      </div>
      <div className="c">
        <div className="t">Max SOG</div>
        <div className="v">{roll?.max_sog_kn == null ? dash : <>{roll.max_sog_kn.toFixed(1)}<span className="u">kn</span></>}</div>
      </div>
    </div>
  );
}

function VoyageRow({
  v,
  prev,
  wasJoined,
  open,
  track,
  fuelNotice,
  fuelMode,
  onFuelMode,
  onToggle,
  onMerge,
  onUndoMerge,
  editErr,
}: {
  v: Voyage;
  prev: Voyage | undefined;
  wasJoined: boolean;
  open: boolean;
  track: TrackPoint[] | undefined;
  fuelNotice: string | null;
  fuelMode: FuelMode;
  onFuelMode: (m: FuelMode) => void;
  onToggle: () => void;
  onMerge: () => void;
  onUndoMerge: () => void;
  editErr: string | null;
}) {
  const underway = v.end_ts === null;
  const fuel = fuelReadout(v.fuel_used_l, v.distance_nm, v.hours_underway, fuelMode);
  const span = underway ? `${hhmm(v.start_ts)} →` : `${hhmm(v.start_ts)}-${hhmm(v.end_ts!)}`;
  const avg = v.avg_sog_kn === null ? "·" : `${v.avg_sog_kn.toFixed(1)} kn`;
  const route = routeLabel(v);

  return (
    <div className={`vy-rowwrap${open ? " open" : ""}`}>
      <button className="vy-row" onClick={onToggle} aria-expanded={open}>
        <div className="vy-row-top">
          <span className="vy-date">{fmtDate(v.start_ts)}</span>
          {underway && <span className="vy-badge">Under way</span>}
          <span className="vy-dist">{fmtNum(v.distance_nm, 1)}<span className="vy-unit">nm</span></span>
        </div>
        {route && <div className="vy-route">{route}</div>}
        <div className="vy-row-sub">{span} · {fmtDur(v.hours_underway)} · {avg}</div>
      </button>

      {open && (
        <div className="vy-detail">
          {track && track.length >= 2 ? (
            <VoyageTrackMap track={track} />
          ) : (
            <div className="vy-track-empty">{track ? "Track too short to plot" : "Loading track…"}</div>
          )}
          <div className="vy-meta">
            <div className="vy-m">
              <span className="k">From</span>
              {v.start_port && <span className="val">{v.start_port}</span>}
              <span className={v.start_port ? "coord" : "val"}>
                {fmtCoordDM(v.start_lat, ["N", "S"], 2)} · {fmtCoordDM(v.start_lon, ["E", "W"], 2)}
              </span>
            </div>
            <div className="vy-m">
              <span className="k">To</span>
              {underway ? (
                <span className="val">-</span>
              ) : (
                <>
                  {v.end_port && <span className="val">{v.end_port}</span>}
                  <span className={v.end_port ? "coord" : "val"}>
                    {fmtCoordDM(v.end_lat, ["N", "S"], 2)} · {fmtCoordDM(v.end_lon, ["E", "W"], 2)}
                  </span>
                </>
              )}
            </div>
            <div className="vy-m">
              <span className="k">Avg SOG</span>
              <span className="val">{v.avg_sog_kn === null ? "·" : `${v.avg_sog_kn.toFixed(1)} kn`}</span>
            </div>
            <div className="vy-m">
              <span className="k">Max SOG</span>
              <span className="val">{v.max_sog_kn === null ? "·" : `${v.max_sog_kn.toFixed(1)} kn`}</span>
            </div>
            {/* An empty fuel figure is ambiguous - a sailing passage looks the
                same as a filter naming an engine the boat stopped sending. Name
                the second case rather than leaving the row out. */}
            {v.fuel_used_l === null && fuelNotice && (
              <div className="vy-m vy-m-fuel">
                <span className="k">Fuel</span>
                <span className="val vy-fuel-quiet">{fuelNotice}</span>
              </div>
            )}
            {v.fuel_used_l !== null && (
              <div className="vy-m vy-m-fuel">
                <span className="k">Fuel</span>
                <span className="val">{fuel ?? "·"}</span>
                <select
                  className="vy-fuel-sel"
                  value={fuelMode}
                  aria-label="Fuel unit"
                  onChange={(e) => onFuelMode(e.target.value as FuelMode)}
                >
                  {FUEL_MODES.map((m) => (
                    <option key={m.mode} value={m.mode}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}
            {track && track.length > 0 && (
              <div className="vy-m vy-m-track">
                <span className="k">Track</span>
                <button
                  type="button"
                  className="vy-fuelsrc"
                  onClick={() =>
                    downloadText(
                      exportFilename(`siparu-voyage-${v.id}`, v.start_ts, "gpx"),
                      "application/gpx+xml",
                      trackGpx(v, track),
                    )
                  }
                >
                  GPX · {track.length} fixes
                </button>
              </div>
            )}
            {/* One trip the engine recorded as two, put right. The button names the
                passage it would join to, so the edit is read before it is made
                rather than confirmed after. */}
            {!underway && (wasJoined || prev) && (
              <div className="vy-m vy-m-edit">
                <span className="k">Passage</span>
                {wasJoined ? (
                  <button type="button" className="vy-fuelsrc" onClick={onUndoMerge}>
                    Separate again
                  </button>
                ) : (
                  <button type="button" className="vy-fuelsrc" onClick={onMerge}>
                    Join to {hhmm(prev!.start_ts)}
                    {prev!.end_ts !== null ? `-${hhmm(prev!.end_ts)}` : ""} · {fmtDate(prev!.start_ts)}
                  </button>
                )}
              </div>
            )}
            {editErr && <div className="vy-m vy-m-editerr">{editErr}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
