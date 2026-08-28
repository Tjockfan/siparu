import { useState, useEffect, Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import BoatLoader from "./BoatLoader";
import SwissTopBar from "./swiss/SwissTopBar";
import SideNav from "./swiss/SideNav";
import BridgeTabBar from "./swiss/BridgeTabBar";
import { useNow } from "../lib/useNow";
import { useMediaQuery } from "../lib/useMediaQuery";
import { dur, ease } from "siparu-ui";
import { cacheTimestamp } from "../lib/prefetchCache";

// A wide screen carries a left rail instead of the top header + bottom tab bar; below this the
// phone keeps both. Matches the board threshold in BridgeMarine, so the dashboard opens up at the
// same width the chrome moves to the side.
const RAIL_QUERY = "(min-width: 1000px)";

/** App shell (Swiss) - flex column:
 *  header (persistent) → animated outlet → bottom tab bar.
 *  Screens render only their content; header+tabbar are shared.
 *
 *  Tab transition is DIRECTIONAL: navigating to a tab on the right slides the
 *  new content in from the right (+10px) while the old one exits left;
 *  navigating left does the reverse. When Map is involved there is NO
 *  transform, only a fade - MapLibre rendering is expensive and the transform
 *  layer is not worth the risk. Exit (140ms) is shorter than enter (220ms). */
const TAB_ORDER = ["/", "/logbook", "/voyage", "/map", "/remote"];
const MAP_IDX = 3;

/** Which tab a path belongs to, so the two logbook pages slide like the one tab they are. */
function tabIndex(pathname: string): number {
  const i = TAB_ORDER.indexOf(pathname);
  if (i !== -1) return i;
  return TAB_ORDER.findIndex((t) => t !== "/" && pathname.startsWith(`${t}/`));
}

const pageVars = {
  enter: (off: number) => ({ opacity: 0, x: off }),
  center: (off: number) => ({
    opacity: 1,
    x: 0,
    transition: { duration: off === 0 ? 0.16 : dur.base, ease: ease.out },
  }),
  exit: (off: number) => ({
    opacity: 0,
    x: -off,
    transition: { duration: dur.exit, ease: ease.exit },
  }),
};

export default function Layout() {
  const location = useLocation();
  const isLive = location.pathname === "/" || location.pathname === "/map";

  // Warm up the heavy sibling tab chunks in the background (Map -> MapLibre).
  // That way the inner Suspense fallback almost never shows when a tab is
  // clicked. 250ms: don't block the first screen's paint + its own data fetch.
  useEffect(() => {
    const id = setTimeout(() => {
      // .catch: keep a stale-chunk 404 (after a deploy) from producing an unhandled rejection.
      import("../routes/Logbook").catch(() => {});
      import("../routes/Voyage").catch(() => {});
      import("../routes/Map").catch(() => {});
      import("../routes/Remote").catch(() => {});
    }, 250);
    return () => clearTimeout(id);
  }, []);

  // Direction calc: the previous tab index is kept in state during render
  // (React's "storing information from previous renders" pattern - touching a
  // ref during render would violate react-hooks/refs).
  const idx = tabIndex(location.pathname);
  const [nav, setNav] = useState({ prev: idx, curr: idx });
  if (nav.curr !== idx) setNav({ prev: nav.curr, curr: idx });
  const prevIdx = nav.curr !== idx ? nav.curr : nav.prev;
  const involvesMap = idx === MAP_IDX || prevIdx === MAP_IDX;
  const dir = idx === prevIdx ? 0 : idx > prevIdx ? 1 : -1;
  const off = involvesMap ? 0 : dir * 10;

  // STALE badge: only on the telemetry screen (there a 2s api.live poll runs;
  // Map does not poll api.live, so age growing there is normal). If the last
  // SUCCESSFUL fetch is older than 10s the data is stale - showing LIVE would
  // be misleading.
  const now = useNow(2000);
  const liveTs = cacheTimestamp("bridge:live");
  const stale =
    location.pathname === "/" && liveTs !== null && now - liveTs > 10_000;

  const wide = useMediaQuery(RAIL_QUERY);

  return (
    <div className={`swiss sp-screen${wide ? " sp-wide" : ""}`}>
      {wide ? (
        <SideNav live={isLive} stale={stale} />
      ) : (
        <SwissTopBar clock live={isLive} stale={stale} />
      )}

      {/* Inner Suspense wraps AnimatePresence from the OUTSIDE - putting it
          inside would leave a suspended motion.div unable to finish its exit
          and would deadlock AnimatePresence. On the outside: if the lazy tab
          chunk is cold the header+tabbar stay FIXED and only the content area
          shows BoatLoader (inline). With prefetch it rarely appears in
          practice. */}
      <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <Suspense fallback={<BoatLoader />}>
          <AnimatePresence mode="wait" initial={false} custom={off}>
            <motion.div
              key={location.pathname}
              className="h-full min-h-0 flex flex-col"
              custom={off}
              variants={pageVars}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {/* The element, not a captured node. `useOutlet()` handed the page down as a value
                  read where this component rendered, and in wait mode the presence layer holds
                  the child it was given until the one before it has finished leaving - so the
                  screen was one navigation behind its own address: the engineer's table under
                  the officer's heading. Rendered as an element it reads the route where and
                  when it is drawn, which is inside the layer that is being shown. */}
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </Suspense>
      </main>

      {!wide && <BridgeTabBar />}
    </div>
  );
}
