/* Voyage - auto-detected passages.
 * Brutalist layout: active-passage banner + window summary grid + voyage list.
 * Tapping a row expands it: MapLibre track map (same style as the Map tab, pan/zoom)
 * plus port/coordinate detail, including fuel burned when the engines report it.
 * Data comes from voyage/useVoyageData.ts; header + tab bar from Layout. */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { Voyage, VoyageRollup, TrackPoint, FuelPathsView } from "../../lib/api";
import { fmtCoordDM, fmtNum } from "../../lib/format";
import { FUEL_MODES, fuelReadout, type FuelMode } from "../../lib/fuel";
import { useVoyageData, type StatWindow } from "./useVoyageData";
import VoyageTrackMap from "./VoyageTrackMap";
import FuelSourceSheet, { fuelSourceSummary } from "./FuelSourceSheet";

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

  useEffect(() => {
    localStorage.setItem(FUEL_MODE_KEY, fuelMode);
  }, [fuelMode]);

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

  // Only offer the choice when there is one to make: more than one engine reports fuel.
  const canPick = !!fuelView && fuelView.available.length > 1;

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

  return (
    <div className="vy">
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
        {canPick && (
          <button type="button" className="vy-fuelsrc" onClick={() => setShowFuel(true)}>
            Fuel · {fuelSourceSummary(fuelView!)}
          </button>
        )}
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
          {d.list.map((v) => (
            <VoyageRow
              key={v.id}
              v={v}
              open={openId === v.id}
              track={tracks[v.id]}
              fuelMode={fuelMode}
              onFuelMode={setFuelMode}
              onToggle={() => toggle(v.id)}
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
  open,
  track,
  fuelMode,
  onFuelMode,
  onToggle,
}: {
  v: Voyage;
  open: boolean;
  track: TrackPoint[] | undefined;
  fuelMode: FuelMode;
  onFuelMode: (m: FuelMode) => void;
  onToggle: () => void;
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
          </div>
        </div>
      )}
    </div>
  );
}
