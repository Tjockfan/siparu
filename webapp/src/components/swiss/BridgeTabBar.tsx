/* Siparu - Bridge bottom tab bar (Swiss). Instruments · Logbook · Voyage · Map.
 * The active tab indicator slides between tabs via layoutId. 200ms snap
 * easing, no overshoot.
 *
 * Not "Dashboard": the README and the package call the whole of this app the dashboard, the one
 * that shows the bridge and the logbook and the chart, so a tab of that name sits inside itself
 * and beside the logbook it contains. Instruments is what this screen holds - the bridge, and
 * the engines, generator and tanks she reports - and it leaves the other three their own words. */
import { NavLink } from "react-router-dom";
import { motion } from "motion/react";
import { ease, InstrumentsIcon, LogbookIcon, MapIcon, VoyageIcon } from "siparu-ui";

const TABS = [
  { to: "/", end: true, label: "Instruments", Icon: InstrumentsIcon },
  { to: "/logbook", end: false, label: "Logbook", Icon: LogbookIcon },
  { to: "/voyage", end: false, label: "Voyage", Icon: VoyageIcon },
  { to: "/map", end: false, label: "Map", Icon: MapIcon },
] as const;

export default function BridgeTabBar() {
  return (
    <nav className="tabbar" aria-label="Bridge tabs">
      {TABS.map(({ to, end, label, Icon }) => (
        <NavLink key={to} to={to} end={end} replace className={({ isActive }) => `tab${isActive ? " on" : ""}`}>
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
