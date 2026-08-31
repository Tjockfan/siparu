import { useState, useEffect, Suspense } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import BoatLoader from "./BoatLoader";
import SwissTopBar from "./swiss/SwissTopBar";
import SideNav from "./swiss/SideNav";
import BridgeTabBar, { TABS, type TabSpec } from "./swiss/BridgeTabBar";
import { useNow } from "../data/useNow";
import { useMediaQuery } from "../data/useMediaQuery";
import { dur, ease } from "../motion";
import { cacheTimestamp } from "../data/prefetchCache";
import { SecurityNotice } from "./SecurityWarning";
import { useApi, type PairScreen } from "../data/api";
import { usePolling } from "../data/usePolling";
import { joinBase, useBase } from "../data/routes";

// A wide screen carries a left rail instead of the top header + bottom tab bar; below this the
// phone keeps both. Matches the board threshold in BridgeMarine, so the dashboard opens up at the
// same width the chrome moves to the side.
const RAIL_QUERY = "(min-width: 1000px)";

/** A standing condition, not an event: the slow poll is the honest cadence for one. Matches
 *  the instruments' own, which asks the same endpoint for the same reason. */
const SECURITY_POLL_MS = 30_000;

/** The server's door: whether it stands open, and whether the plugin has locked its writes for it. */
type Door = { open: boolean | undefined; locked: boolean };

type Props = {
  /** The destinations, in order. The bridge set unless the app says otherwise. */
  tabs?: readonly TabSpec[];
  /** Screen paths on which the LIVE badge is drawn (the ones polling the live frame). */
  liveOn?: readonly string[];
  /** Screen paths across which the transition is a plain fade: the map, whose render is dear. */
  fadeOn?: readonly string[];
  /** Lazy chunks to warm once the first screen has painted, so a tap rarely shows a loader. */
  warm?: ReadonlyArray<() => Promise<unknown>>;
  /** Where the top bar's back chevron leads, when the screens sit inside a larger app. */
  back?: string;
  /** The top bar's context tag - the boat's name, when there is more than one boat. */
  context?: string;
};

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

/** App shell (Swiss) - flex column:
 *  header (persistent) → animated outlet → bottom tab bar.
 *  Screens render only their content; header+tabbar are shared.
 *
 *  Tab transition is DIRECTIONAL: navigating to a tab on the right slides the
 *  new content in from the right (+10px) while the old one exits left;
 *  navigating left does the reverse. When Map is involved there is NO
 *  transform, only a fade - MapLibre rendering is expensive and the transform
 *  layer is not worth the risk. Exit (140ms) is shorter than enter (220ms). */
export default function Layout({
  tabs = TABS,
  liveOn = ["/", "/map"],
  fadeOn = ["/map"],
  warm,
  back,
  context,
}: Props) {
  const api = useApi();
  const location = useLocation();
  const outlet = useOutlet();
  const base = useBase();
  const at = (path: string) => joinBase(base, path);
  const isLive = liveOn.some((p) => location.pathname === at(p));

  // Warm up the heavy sibling tab chunks in the background (Map -> MapLibre).
  // That way the inner Suspense fallback almost never shows when a tab is
  // clicked. 250ms: don't block the first screen's paint + its own data fetch.
  useEffect(() => {
    if (!warm) return;
    const id = setTimeout(() => {
      // .catch: keep a stale-chunk 404 (after a deploy) from producing an unhandled rejection.
      for (const load of warm) load().catch(() => {});
    }, 250);
    return () => clearTimeout(id);
    // The list is a constant of the app that mounted this shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Which tab a path belongs to, so the two logbook pages slide like the one tab they are. */
  const tabIndex = (pathname: string): number => {
    const exact = tabs.findIndex((t) => at(t.to) === pathname);
    if (exact !== -1) return exact;
    return tabs.findIndex((t) => !t.end && pathname.startsWith(`${at(t.to)}/`));
  };
  const fadeIdx = fadeOn.map((p) => tabs.findIndex((t) => t.to === p));

  // Direction calc: the previous tab index is kept in state during render
  // (React's "storing information from previous renders" pattern - touching a
  // ref during render would violate react-hooks/refs).
  const idx = tabIndex(location.pathname);
  const [nav, setNav] = useState({ prev: idx, curr: idx });
  if (nav.curr !== idx) setNav({ prev: nav.curr, curr: idx });
  const prevIdx = nav.curr !== idx ? nav.curr : nav.prev;
  const involvesMap = fadeIdx.includes(idx) || fadeIdx.includes(prevIdx);
  const dir = idx === prevIdx ? 0 : idx > prevIdx ? 1 : -1;
  const off = involvesMap ? 0 : dir * 10;

  // STALE badge: only on the telemetry screen (there a 2s live poll runs;
  // Map does not poll it, so age growing there is normal). If the last
  // SUCCESSFUL fetch is older than 10s the data is stale - showing LIVE would
  // be misleading.
  const now = useNow(2000);
  const liveTs = cacheTimestamp("bridge:live");
  const stale = location.pathname === at("/") && liveTs !== null && now - liveTs > 10_000;

  const wide = useMediaQuery(RAIL_QUERY);
  // The door is a fact about her server. At her helm the pairing status carries it; ashore
  // there is no pairing to ask, and her own account of herself says the same two things.
  const { data: door } = usePolling<Door | null>(
    () =>
      api.pair
        ? api.pair.status().then((s: PairScreen) => ({ open: s.security_off, locked: s.pairing_locked === true }))
        : api.health().then((h) => ({ open: h.security_off, locked: h.pairing_locked === true })),
    SECURITY_POLL_MS,
    [],
  );

  return (
    <div className={`swiss sp-screen${wide ? " sp-wide" : ""}`}>
      {wide ? (
        <SideNav tabs={tabs} live={isLive} stale={stale} back={back} context={context} />
      ) : (
        <SwissTopBar clock live={isLive} stale={stale} back={back} context={context} />
      )}

      {/* Inner Suspense wraps AnimatePresence from the OUTSIDE - putting it
          inside would leave a suspended motion.div unable to finish its exit
          and would deadlock AnimatePresence. On the outside: if the lazy tab
          chunk is cold the header+tabbar stay FIXED and only the content area
          shows BoatLoader (inline). With prefetch it rarely appears in
          practice. */}
      <main className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
        <Suspense fallback={<BoatLoader />}>
          {/* popLayout, not wait. Wait mode swaps children only when the exit animation has
              FINISHED, and an animation is a thing that can stall - a hidden tab's rAF is
              paused, so a navigation made in the background left the old page standing under
              the new address until the animation got to run. That stall is the "one
              navigation behind" bug this layout has had in two disguises. popLayout mounts
              the new page immediately - the address is correct the same frame it changes -
              and pops the leaving one out of the flow to fade over it. */}
          <AnimatePresence mode="popLayout" initial={false} custom={off}>
            <motion.div
              key={location.pathname}
              className="h-full min-h-0 flex flex-col"
              custom={off}
              variants={pageVars}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {/* The captured node, not the element. `<Outlet />` reads the address at render
                  time, and the leaving wrapper keeps rendering through its own exit - so the
                  moment the address changed, the exit layer was already showing the NEW page,
                  and every switch became a double blink: the new screen at full opacity for a
                  frame, bare ground, then the fade-in (measured on video,
                  dev/verify/flicker.py - two full blank frames per switch in wait mode).
                  `useOutlet()` hands the wrapper the page it was keyed for, so the exit shows
                  the page that is actually leaving; the entering wrapper is created with the
                  new address's node the same render. Route landing is pinned by
                  dev/verify/route_lag.py - door and mid-fade sequences. */}
              {outlet}
            </motion.div>
          </AnimatePresence>
        </Suspense>
      </main>

      {!wide && <BridgeTabBar tabs={tabs} />}

      {/* Mounted by the shell rather than by a screen: an open server belongs to the boat, not
          to whichever tab the app happened to open on, and an owner who lands on the logbook has
          the same open door as one who lands on the instruments. Asked once per launch (the
          dialog itself only opens if a month has passed since it was last acknowledged), so this
          poll is slow: it is here to notice a condition, not to watch one. */}
      <SecurityNotice on={door?.open} locked={door?.locked === true} />
    </div>
  );
}
