/** Marker HTML builders - engine wraps these in MapLibre Marker elements.
 *  Kept as plain HTML strings so an update is just innerHTML swap. */
import { ageOf, type AgeUnit } from "../lib/age";

export interface BoatPalette {
  fill: string;
  stroke: string;
  glow: string;
  dot: string;
}

const AMBER_BOAT: BoatPalette = {
  fill: "#ffb938",
  stroke: "#b38326",
  glow: "rgba(255,185,56,0.65)",
  dot: "#050706",
};

/**
 * Triangular boat marker, oriented by `headingDeg`. `palette` provides the
 * colors per theme (defaults to amber). A null headingDeg renders a static dot.
 */
export function makeBoatIcon(
  headingDeg: number | null,
  palette: BoatPalette = AMBER_BOAT,
): string {
  const amber = palette.fill;
  const amberDim = palette.stroke;

  if (headingDeg === null || Number.isNaN(headingDeg)) {
    // Fallback: solid dot
    return `
      <div style="
        width: 14px; height: 14px;
        background: ${amber};
        border: 1px solid ${amberDim};
        border-radius: 50%;
        box-shadow: 0 0 8px ${palette.glow};
      "></div>`;
  }

  // Pixel-art triangle pointing UP at heading=0, rotated by headingDeg.
  // Dark casing + thick accent stroke so own ship stands out instantly, even
  // within an AIS cluster (hierarchy: own ship > AIS).
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 28 28"
         style="transform: rotate(${headingDeg}deg); transform-origin: 17px 17px; display: block;">
      <polygon points="14,2 24,24 14,19 4,24"
               fill="none"
               stroke="rgba(10,12,14,0.85)"
               stroke-width="4.2"
               stroke-linejoin="round"/>
      <polygon points="14,2 24,24 14,19 4,24"
               fill="${amber}"
               stroke="${amberDim}"
               stroke-width="1.6"
               style="filter: drop-shadow(0 0 5px ${palette.glow});"/>
      <circle cx="14" cy="14" r="1.5" fill="${palette.dot}"/>
    </svg>`;
}

/**
 * AIS target marker - hollow chevron oriented by course (COG, heading
 * fallback). Visually dimmer than own ship: outline-only, smaller. If no
 * course is known, a small hollow diamond.
 */
export function makeAisIcon(courseDeg: number | null, color = "#c79555"): string {
  const c = color;

  if (courseDeg === null || Number.isNaN(courseDeg)) {
    return `
      <div style="
        width: 9px; height: 9px;
        background: transparent;
        border: 1.4px solid ${c};
        transform: rotate(45deg);
        box-shadow: 0 0 4px ${c}88;
        margin: 2px;
      "></div>`;
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"
         style="transform: rotate(${courseDeg}deg); transform-origin: 9px 9px; display: block;">
      <polygon points="9,2 14,15 9,11.5 4,15"
               fill="none"
               stroke="${c}"
               stroke-width="1.6"
               stroke-linejoin="round"
               style="filter: drop-shadow(0 0 3px ${c}88);"/>
    </svg>`;
}

/**
 * A single letter per unit, because this one is read in a popup rather than a sentence.
 *
 * The chart's own row sits next to an absolute clock - "3m ago (14:52:07)" - in a mono
 * key/value grid whose column is as wide as the widest value in it. Spelling out " min"
 * here would widen every row of that popup to buy nothing a reader of a chart wants.
 */
const TERSE: Record<AgeUnit, string> = { s: "s", min: "m", h: "h", d: "d" };

/** Format a unix-ms timestamp as a short relative duration ("12s ago", "3m ago"). */
export function relativeAgo(tsMs: number, nowMs: number = Date.now()): string {
  const { value, unit } = ageOf((nowMs - tsMs) / 1000);
  return `${value}${TERSE[unit]} ago`;
}
