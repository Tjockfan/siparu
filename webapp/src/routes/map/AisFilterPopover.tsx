/** AIS filter popover - used by all 3 themes.
 *  Presentation is decoupled from the hook; it works purely through props.
 *  The theme CSS scope is applied as a class name based on `variant`. */
import { useEffect, useRef } from "react";
import {
  AIS_LIMIT_MAX,
  AIS_LIMIT_MIN,
  AIS_NM_MAX,
  AIS_NM_MIN,
} from "../../lib/aisPrefs";

export type AisFilterVariant = "marine" | "ios" | "pastel";

interface Props {
  open: boolean;
  onClose: () => void;
  maxNm: number;
  setMaxNm: (n: number) => void;
  limit: number;
  setLimit: (n: number) => void;
  variant: AisFilterVariant;
}

export default function AisFilterPopover({
  open,
  onClose,
  maxNm,
  setMaxNm,
  limit,
  setLimit,
  variant,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Stop click/scroll/drag events from reaching the map so it doesn't pan.
  // Since it renders null when closed, the effect depends on `open` - the
  // element only exists while open.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !open) return;
    const stop = (e: Event) => e.stopPropagation();
    const evs = ["pointerdown", "mousedown", "touchstart", "dblclick", "wheel"] as const;
    for (const ev of evs) el.addEventListener(ev, stop);
    return () => {
      for (const ev of evs) el.removeEventListener(ev, stop);
    };
  }, [open]);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Close on outside click - but make an exception for the anchor (AIS
  // button); the button's own onClick will handle the toggle.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      const el = rootRef.current;
      if (!el || !(e.target instanceof Node)) return;
      if (el.contains(e.target)) return; // inside the popover
      const cluster = el.parentElement;
      if (cluster && cluster.contains(e.target)) return; // anchor button
      onClose();
    };
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("touchstart", onDoc);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div ref={rootRef} className={`ais-filter ais-filter-${variant}`} role="dialog">
      <div className="aisf-row">
        <div className="aisf-label">
          <span>Range</span>
          <span className="aisf-value">{maxNm} NM</span>
        </div>
        <input
          type="range"
          min={AIS_NM_MIN}
          max={AIS_NM_MAX}
          step={1}
          value={maxNm}
          onChange={(e) => setMaxNm(Number(e.target.value))}
        />
      </div>

      <div className="aisf-row">
        <div className="aisf-label">
          <span>Targets</span>
          <span className="aisf-value">{limit}</span>
        </div>
        <input
          type="range"
          min={AIS_LIMIT_MIN}
          max={AIS_LIMIT_MAX}
          step={5}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
