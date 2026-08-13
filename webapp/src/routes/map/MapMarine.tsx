/* Map - chart + AIS (Swiss redesign; MapLibre port).
 * Engine + AIS logic preserved; the basemap now uses its own PMTiles stack
 * (style.ts factory, night/day brand flavors). The overlays are designed
 * in-house. */
import { useEffect, useState } from "react";
import { api, type Snapshot, type AisTarget } from "../../lib/api";
import { fmtCoordDM, fmtNum, formatTs, radToDeg, sogKnFiltered } from "../../lib/format";
import { makeBoatIcon, makeAisIcon, relativeAgo, type BoatPalette } from "../../map/boatIcon";
import { useMapEngine } from "./useMapEngine";
import AisFilterPopover from "./AisFilterPopover";

const MAP_CSS = `
.mp .maplibregl-map { background: var(--map-sea); font-family: var(--sp-font); font-size: 11px; outline: none; }
.mp .maplibregl-canvas { outline: none; }

/* Zoom control - brutalist */
.mp .maplibregl-ctrl-group { background: var(--cell); border: 1.5px solid var(--rule); border-radius: 0; box-shadow: none; }
.mp .maplibregl-ctrl-group button {
  background: var(--cell); border-bottom: 1px solid var(--rule);
  width: 30px; height: 30px; border-radius: 0;
}
.mp .maplibregl-ctrl-group button:last-child { border-bottom: none; }
.mp .maplibregl-ctrl-group button:disabled { opacity: 0.4; }
.mp .maplibregl-ctrl-zoom-in .maplibregl-ctrl-icon,
.mp .maplibregl-ctrl-zoom-out .maplibregl-ctrl-icon { filter: var(--ctrl-icon-filter); }
.mp .maplibregl-ctrl-bottom-left { margin: 0 0 30px 12px; } /* zoom, above the attribution strip */

/* Attribution - always visible as required by ODbL; a full-width strip
   separate from the controls (design note: must not overlap the RANGE pill,
   and contrast must not drop) */
.mp .maplibregl-ctrl-bottom-right { left: 0; right: 0; margin: 0; display: flex; justify-content: center; }
.mp .maplibregl-ctrl-attrib {
  background: color-mix(in srgb, var(--cell) 90%, transparent);
  font-family: var(--sp-font); font-size: 9px; letter-spacing: 0.02em;
  color: var(--text); opacity: 0.85; padding: 2px 8px; border-radius: 0; margin: 0;
}
.mp .maplibregl-ctrl-attrib a { color: var(--text); text-decoration: none; }

/* Popup - brutalist card */
.mp .maplibregl-popup-content { background: var(--cell); color: var(--text); border: 1.5px solid var(--rule); border-radius: 0; box-shadow: none; padding: 11px 13px; font-family: var(--sp-font); }
.mp .maplibregl-popup-tip { display: none; }
.mp .maplibregl-popup-close-button { color: var(--muted); font-family: var(--sp-font); font-size: 16px; right: 4px; top: 2px; }
.sp-boat-marker { z-index: 3; }
.sp-ais-marker { z-index: 2; cursor: pointer; }

/* AIS filter popover - brutalist, opens upward above the button */
.mp .ais-filter { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 700; width: 232px; padding: 14px; background: var(--cell); border: 1.5px solid var(--rule); color: var(--text); }
.mp .ais-filter .aisf-row { margin-bottom: 14px; }
.mp .ais-filter .aisf-row:last-child { margin-bottom: 0; }
.mp .ais-filter .aisf-label > span:first-child { font-family: var(--sp-font); font-size: 9px; letter-spacing: 0.16em; font-weight: 700; color: var(--muted); text-transform: uppercase; }
.mp .ais-filter .aisf-label { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 7px; }
.mp .ais-filter .aisf-value { font-family: var(--sp-mono); font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; }
.mp .ais-filter input[type="range"] { -webkit-appearance: none; appearance: none; width: 100%; height: 18px; background: transparent; cursor: pointer; }
.mp .ais-filter input[type="range"]::-webkit-slider-runnable-track { height: 2px; background: var(--rule); }
.mp .ais-filter input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -6px; background: var(--accent); }
.mp .ais-filter input[type="range"]::-moz-range-track { height: 2px; background: var(--rule); }
.mp .ais-filter input[type="range"]::-moz-range-thumb { width: 14px; height: 14px; border: none; background: var(--accent); }
`;

// DivIcon SVG cannot resolve CSS vars - fixed accent. Bright fill + deep stroke
// carry both cases (dark sea / light sea).
const ACCENT_BOAT: BoatPalette = {
  fill: "#f2f3f5",
  stroke: "#e5484d",
  glow: "rgba(229,72,77,0.45)",
  dot: "#e5484d",
};

const KEY = "color: var(--muted); font-family: var(--sp-font); font-size: 8.5px; letter-spacing: 0.1em; text-transform: uppercase;";
const VAL = "color: var(--text); font-family: var(--sp-font); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;";
const TITLE = "color: var(--text); font-family: var(--sp-font); font-weight: 600; font-size: 14px; margin-bottom: 8px;";
const TAG = "font-family: var(--sp-font); font-size: 8px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #fff; background: var(--map-ais-hi); padding: 3px 5px;";

// Popups are passed to MapLibre Popup.setHTML as a RAW HTML string; vessel
// name/ship_type/nav_state from the AIS feed may be attacker-controlled. They
// must be HTML-escaped before reaching innerHTML (otherwise an <img onerror>
// could steal the JWT in localStorage).
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function popupHtml(s: Snapshot, nowMs: number, boatName: string): string {
  const sogKn = sogKnFiltered(s.sog);
  const cogDeg = sogKn !== null ? radToDeg(s.cog) : null;
  const hdgDeg = radToDeg(s.heading_true);
  const navState = (s.nav_state ?? "·").toUpperCase();
  return `
    <div style="${TITLE}">${esc(boatName)}</div>
    <div style="display:grid;grid-template-columns:auto 1fr;column-gap:14px;row-gap:4px;align-items:baseline;">
      <span style="${KEY}">POS</span><span style="${VAL}">${fmtCoordDM(s.lat, ["N", "S"], 2)} · ${fmtCoordDM(s.lon, ["E", "W"], 3)}</span>
      <span style="${KEY}">SOG</span><span style="${VAL}">${fmtNum(sogKn, 1, " kt")}</span>
      <span style="${KEY}">COG</span><span style="${VAL}">${cogDeg === null ? "·" : fmtNum(cogDeg, 0, "°")}</span>
      <span style="${KEY}">HDG</span><span style="${VAL}">${hdgDeg === null ? "·" : fmtNum(hdgDeg, 0, "°")}</span>
      <span style="${KEY}">NAV</span><span style="${VAL}">${esc(navState)}</span>
      <span style="${KEY}">UPD</span><span style="${VAL}">${relativeAgo(s.ts, nowMs)} <span style="color:var(--muted)">(${formatTs(s.ts).slice(11, 19)})</span></span>
    </div>
  `;
}

function aisPopupHtml(t: AisTarget): string {
  const title = t.name || `MMSI ${t.mmsi}`;
  const sog = t.sog_kn === null ? "·" : `${t.sog_kn.toFixed(1)} kt`;
  const cog = t.cog_deg === null ? "·" : `${String(Math.round(t.cog_deg)).padStart(3, "0")}°`;
  const dist = t.distance_nm === null ? "·" : `${t.distance_nm.toFixed(1)} NM`;
  const loa = t.length_m === null ? "·" : `${Math.round(t.length_m)} m`;
  const meta = [t.ship_type, t.ais_class ? `Class ${t.ais_class}` : null].filter(Boolean).join(" · ") || "·";
  return `
    <div style="${TITLE}; display:flex; justify-content:space-between; gap:10px; align-items:center;">${esc(title)} <span style="${TAG}">AIS</span></div>
    <div style="display:grid;grid-template-columns:auto 1fr;column-gap:14px;row-gap:4px;align-items:baseline;">
      <span style="${KEY}">TYPE</span><span style="${VAL}">${esc(meta)}</span>
      <span style="${KEY}">LOA</span><span style="${VAL}">${loa}</span>
      <span style="${KEY}">SOG</span><span style="${VAL}">${sog}</span>
      <span style="${KEY}">COG</span><span style="${VAL}">${cog}</span>
      <span style="${KEY}">DIST</span><span style="${VAL}">${dist}</span>
      <span style="${KEY}">NAV</span><span style="${VAL}">${esc((t.nav_state ?? "·").toUpperCase())}</span>
    </div>
  `;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export default function MapMarine() {
  // The local vessel's name - fetched once from /health; falls back to a neutral title.
  const [boatName, setBoatName] = useState<string | null>(null);
  useEffect(() => {
    let ok = true;
    api.health().then((h) => { if (ok && h.boat_name) setBoatName(h.boat_name); }).catch(() => {});
    return () => { ok = false; };
  }, []);

  const {
    containerRef, aisOn, setAisOn, aisMaxNm, setAisMaxNm, aisLimit, setAisLimit, latest, chartNote,
  } = useMapEngine({
    track: { color: "#c23a3f", width: 1.8, dash: [2.8, 2.2] },
    zoomPosition: "bottom-left", // so the top strip doesn't cover the zoom buttons
    popupHtml: (s, now) => popupHtml(s, now, boatName ?? "This vessel"),
    aisPopupHtml,
    makeBoat: (h) => makeBoatIcon(h, ACCENT_BOAT),
    makeAis: (c) => makeAisIcon(c, "#7a8a86"),
  });
  const [filterOpen, setFilterOpen] = useState(false);

  const hdgDeg = latest ? radToDeg(latest.heading_true) : null;
  const sogKn = latest ? sogKnFiltered(latest.sog) : null;
  const navState = latest?.nav_state ? titleCase(latest.nav_state) : null;
  const coords =
    latest?.lat != null && latest?.lon != null
      ? `${fmtCoordDM(latest.lat, ["N", "S"], 2)}  ${fmtCoordDM(latest.lon, ["E", "W"], 3)}`
      : "·";

  return (
    <div className="mp">
      <style>{MAP_CSS}</style>
      <div ref={containerRef} className="mp-canvas" />

      <div className="mp-strip">
        <span className="co">{coords}</span>
        <span className="vec">
          <b>{hdgDeg !== null ? `${Math.round(hdgDeg)}°` : "·"}</b> · <b>{sogKn !== null ? sogKn.toFixed(1) : "·"}</b>kn
        </span>
        {navState && <span className="navp">{navState}</span>}
      </div>

      {chartNote && <div className="mp-chartnote">{chartNote}</div>}

      <div className="mp-ctrl">
        <button className={`mp-btn${aisOn ? " on" : ""}`} onClick={() => setAisOn(!aisOn)}>
          AIS
        </button>
        <div style={{ position: "relative" }}>
          <button className="mp-btn" onClick={() => setFilterOpen((v) => !v)}>
            Range · <span className="n">{aisMaxNm}</span> Nm
          </button>
          <AisFilterPopover
            open={filterOpen}
            onClose={() => setFilterOpen(false)}
            maxNm={aisMaxNm}
            setMaxNm={setAisMaxNm}
            limit={aisLimit}
            setLimit={setAisLimit}
            variant="marine"
          />
        </div>
      </div>
    </div>
  );
}
