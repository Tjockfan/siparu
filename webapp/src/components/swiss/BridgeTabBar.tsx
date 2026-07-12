/* Siparu - Bridge bottom tab bar (Swiss). Telemetry · Logbook · Voyage · Map.
 * The active tab indicator slides between tabs via layoutId. 200ms snap
 * easing, no overshoot. */
import { NavLink } from "react-router-dom";
import { motion } from "motion/react";
import { ease } from "../../lib/motion";
import { TelemetryIcon, LogbookIcon, MapIcon, VoyageIcon } from "./icons";

const TABS = [
  { to: "/", end: true, label: "Telemetry", Icon: TelemetryIcon },
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
