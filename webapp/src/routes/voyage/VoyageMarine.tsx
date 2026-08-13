/* Voyage - auto-detected passages.
 * Brutalist layout: active-passage banner + window summary grid + voyage list.
 * Tapping a row expands it: MapLibre track map (same style as the Map tab, pan/zoom)
 * plus port/coordinate detail, including fuel burned when the engines report it.
 * Data comes from voyage/useVoyageData.ts; header + tab bar from Layout. */
import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import type { Voyage, VoyageRollup, TrackPoint, FuelPathsView } from "../../lib/api";
import { fmtCoordDM, fmtNum } from "../../lib/format";
import { FUEL_MODES, fuelReadout, type FuelMode } from "../../lib/fuel";
import { downloadText, exportFilename, trackGpx, voyagesCsv } from "../../lib/export";
import { useVoyageData, type StatWindow } from "./useVoyageData";
import VoyageTrackMap from "./VoyageTrackMap";
import FuelSourceSheet from "./FuelSourceSheet";
import { fuelSourceNotice, fuelSourceOffered, fuelSourceSummary } from "../../lib/fuelSource";

const FUEL_MODE_KEY = "siparu.fuelMode";

function initFuelMode(): FuelMode {
  const stored = localStorage.getItem(FUEL_MODE_KEY);
  return FUEL_MODES.some((m) => m.mode === stored) ? (stored as FuelMode) : "total_l";
}

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

      {active && <ActiveBanner v={active} />}

      <div className="vy-seg seg" role="group" aria-label="Stats window">
        {WINDOWS.map((w) => (
          <button key={w.k} className={win === w.k ? "on" : ""} onClick={() => setWin(w.k)}>
            {w.label}
          </button>
        ))}
      </div>
      <StatsGrid roll={roll} loading={d.loading} />

      <div className="vy-hd">
        <span className="vy-hd-l">Voyages <b>{d.list.length}</b></span>
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
      <div className="vy-active-hd">
        <span className="vy-pulse" aria-hidden="true" />
        Under way{v.start_port ? ` · from ${v.start_port}` : ""} · since {hhmm(v.start_ts)}
      </div>
      <div className="vy-active-grid">
        <div className="vy-a-hero">
          <div className="t">Distance · <span className="sub">nm</span></div>
          <div className="n">{fmtNum(v.distance_nm, 1)}</div>
        </div>
        <div className="vy-a-cell">
          <div className="t">Underway · <span className="sub">time</span></div>
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

function StatsGrid({ roll, loading }: { roll: VoyageRollup | null; loading: boolean }) {
  const dash = loading ? "" : "·";
  return (
    <div className="vy-cards">
      <div className="c vy-hero">
        <div className="t">Distance · <span className="sub">nm</span></div>
        <div className={`n${loading ? " skel" : ""}`}>{loading ? "128.4" : roll ? fmtNum(roll.distance_nm, 1) : dash}</div>
      </div>
      <div className="c">
        <div className="t">Underway · <span className="sub">time</span></div>
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
