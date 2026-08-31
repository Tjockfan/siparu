/* Siparu - Bridge bottom tab bar (Swiss). Instruments · Logbook · Voyage · Map · Remote.
 * The active tab indicator slides between tabs via layoutId. 200ms snap
 * easing, no overshoot.
 *
 * Not "Dashboard": the README and the package call the whole of this app the dashboard, the one
 * that shows the bridge and the logbook and the chart, so a tab of that name sits inside itself
 * and beside the logbook it contains. Instruments is what this screen holds - the bridge, and
 * the engines, generator and tanks she reports - and it leaves the other three their own words. */
import type { ComponentType } from "react";
import { NavLink } from "react-router-dom";
import { motion } from "motion/react";
import { ease, InstrumentsIcon, LogbookIcon, MapIcon, RemoteIcon, VoyageIcon } from "../../index";
import { useHref } from "../../data/routes";

/** One destination. `to` is the screen path; the app's base is put in front of it when drawn. */
export type TabSpec = {
  to: string;
  end: boolean;
  label: string;
  Icon: ComponentType<{ size?: number }>;
};

// The bridge destinations, in order. Exported so the desktop side rail draws the same list
// vertically instead of keeping its own copy that could drift out of step with this one.
export const TABS: readonly TabSpec[] = [
  { to: "/", end: true, label: "Instruments", Icon: InstrumentsIcon },
  { to: "/logbook", end: false, label: "Logbook", Icon: LogbookIcon },
  { to: "/voyage", end: false, label: "Voyage", Icon: VoyageIcon },
  { to: "/map", end: false, label: "Map", Icon: MapIcon },
  // Last, and it earns the place by being the one tab nobody opens twice in a season: the
  // account, the pairing codes and the screens she seals to. What must be noticed instead of
  // looked up stays on the instruments (bridge/PairAlerts).
  { to: "/remote", end: false, label: "Remote", Icon: RemoteIcon },
];

export default function BridgeTabBar({ tabs = TABS }: { tabs?: readonly TabSpec[] }) {
  const href = useHref();
  return (
    <nav className="tabbar" aria-label="Bridge tabs">
      {tabs.map(({ to, end, label, Icon }) => (
        <NavLink key={to} to={href(to)} end={end} replace className={({ isActive }) => `tab${isActive ? " on" : ""}`}>
          {({ isActive }) => (
            <>
              {isActive && (
                <motion.span
                  className="tind"
                  layoutId="sp-tabind"
                  transition={{ duration: 0.2, ease: ease.snap }}
                />
              )}
              <Icon size={21} />
              <span className="tl">{label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
