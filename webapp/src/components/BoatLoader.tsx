/**
 * BoatLoader - minimal loading state: the wordmark breathes slowly.
 * No spinner, no "LOADING…" text frame; as quiet as the rest of the panel.
 *
 *  full=true  → full-screen ink background, centered (route-level Suspense).
 *  full=false → fills the content area (tab switch: header/tabbar stay put).
 *  prefers-reduced-motion → breathing stops, static mark.
 *
 * Styles live in swiss.css (.sp-bload*).
 */
export default function BoatLoader({ full = false }: { full?: boolean }) {
  return (
    <div className={`sp-bload${full ? " full" : ""}`} role="status" aria-label="Loading">
      <span className="sp-bload-mk">
        Siparu
      </span>
    </div>
  );
}
