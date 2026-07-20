/* Fuel source picker - which engine fuel-rate paths count toward voyage fuel.
 * Shown only when the boat reports more than one propulsion.*.fuel.rate path
 * (a single-engine boat needs no choice). Applying saves through the config
 * route, which restarts the plugin to re-integrate every voyage from disk under
 * the new selection; we poll until the selection lands, then refresh the list.
 * Sheet shell + createPortal, same as BaroPopup. */
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sheet } from "siparu-ui";
import { api, type FuelPathsView } from "../../lib/api";

/** propulsion.<instance>.fuel.rate -> "Instance" (Port / Engine / Starboard). */
export function fuelPathLabel(p: string): string {
  const m = p.match(/^propulsion\.([^.]+)\.fuel\.rate$/);
  const inst = m ? m[1] : p;
  return inst.charAt(0).toUpperCase() + inst.slice(1);
}

/** Short summary for the affordance: "All" when nothing is narrowed. */
export function fuelSourceSummary(v: FuelPathsView): string {
  if (v.selected.length === 0) return "All";
  if (v.selected.length === 1) return fuelPathLabel(v.selected[0]);
  return `${v.selected.length} engines`;
}

export default function FuelSourceSheet({
  view,
  onClose,
  onApplied,
}: {
  view: FuelPathsView;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(view.selected));
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  const toggle = (p: string) => {
    setErr(null);
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const apply = async () => {
    const want = [...sel].sort();
    setApplying(true);
    setErr(null);
    try {
      await api.config.setFuelPaths(want);
      // The plugin restarts and re-integrates from disk. Poll the config until
      // the new selection is live (a few seconds) rather than guessing a delay;
      // the endpoint may blink during the restart, so tolerate a failed read.
      const target = want.join(",");
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          const v = await api.config.fuelPaths();
          if ([...v.selected].sort().join(",") === target) break;
        } catch {
          /* restart window - keep polling */
        }
      }
      onApplied();
      closeRef.current?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not apply the change");
      setApplying(false);
    }
  };

  const target = document.querySelector<HTMLElement>(".swiss.sp-screen") ?? document.body;

  return createPortal(
    <Sheet
      title="Fuel source"
      eyebrow="voyage fuel"
      onClose={onClose}
      closeRef={closeRef}
      footer={
        <button type="button" className="fs-apply" onClick={apply} disabled={applying}>
          {applying ? "Applying…" : "Apply"}
        </button>
      }
    >
      <p className="fs-note">
        Which engines count toward voyage fuel. With none selected, every reporting engine is summed.
      </p>
      <div className="fs-list" role="group" aria-label="Fuel-rate sources">
        {view.available.map((p) => {
          const on = sel.has(p);
          return (
            <button
              key={p}
              type="button"
              className={`fs-row${on ? " on" : ""}`}
              role="checkbox"
              aria-checked={on}
              onClick={() => toggle(p)}
              disabled={applying}
            >
              <span className="fs-name">{fuelPathLabel(p)}</span>
              <span className="fs-path">{p}</span>
            </button>
          );
        })}
      </div>
      {err && <div className="fs-err">{err}</div>}
    </Sheet>,
    target,
  );
}
