import { useEffect, useMemo, useState } from "react";
import { shipTimes, type ShipTimes, type ZoneLookup } from "../lib/shipTime";

// Kept once it has loaded. Each view mounts its own copy of this hook, and without this a
// change of view painted one frame of UTC hours before the already-loaded table came back.
let loaded: ZoneLookup | null = null;

/**
 * A page's rows on the ship's clock.
 *
 * The zone table is a lazy chunk, the same one the top bar's clock loads, so the first paint of
 * a cold page is in UTC and says UTC over the lane; the hours and the head change together when
 * the table arrives. They are never out of step with each other, which is the part that matters:
 * a reader can be shown UTC, he cannot be shown one clock under the other's name.
 */
export function useShipTimes(rows: readonly { ts: number; lat: number | null; lon: number | null }[]): ShipTimes {
  const [lookup, setLookup] = useState<ZoneLookup | null>(() => loaded);
  useEffect(() => {
    let ok = true;
    import("tz-lookup")
      .then((m) => {
        loaded = m.default;
        // Wrapped: a function handed to setState is called as an updater, not stored.
        if (ok) setLookup(() => m.default);
      })
      .catch(() => {/* no zone table: the page stays in UTC and keeps saying so */});
    return () => {
      ok = false;
    };
  }, []);
  return useMemo(() => shipTimes(rows, lookup), [rows, lookup]);
}
