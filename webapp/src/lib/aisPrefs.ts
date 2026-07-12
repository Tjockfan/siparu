/** AIS filter preferences - persisted in localStorage.
 *  Slider min/max ranges are clamped in the UI using these constants. */

const KEY = "siparu.aisPrefs";

export const AIS_NM_MIN = 1;
export const AIS_NM_MAX = 20;
export const AIS_LIMIT_MIN = 5;
export const AIS_LIMIT_MAX = 100;

export const AIS_NM_DEFAULT = 5;
export const AIS_LIMIT_DEFAULT = 30;

export type AisPrefs = { maxNm: number; limit: number };

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function loadAisPrefs(): AisPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { maxNm: AIS_NM_DEFAULT, limit: AIS_LIMIT_DEFAULT };
    const parsed = JSON.parse(raw);
    return {
      maxNm: clamp(Number(parsed.maxNm), AIS_NM_MIN, AIS_NM_MAX),
      limit: clamp(Number(parsed.limit), AIS_LIMIT_MIN, AIS_LIMIT_MAX),
    };
  } catch {
    return { maxNm: AIS_NM_DEFAULT, limit: AIS_LIMIT_DEFAULT };
  }
}

export function saveAisPrefs(p: AisPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore quota / private mode */
  }
}
