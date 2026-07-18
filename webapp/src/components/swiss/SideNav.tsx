/* Siparu - desktop side rail (Swiss). Rendered instead of the top header and the bottom tab bar
 * on a wide screen, where a full-width bottom bar would stretch each tab to a quarter of the
 * viewport. Below the breakpoint this is not mounted at all (Layout branches on the same width),
 * so the phone keeps its header + bottom bar untouched.
 *
 * Three bands, top to bottom: the brand, the same four destinations the bottom bar carries
 * (drawn vertically from the shared TABS list), and a footer holding the live/stale state, the
 * boat-local clock and the theme toggle - the chrome that lives in the header on a phone. */
import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { BrandMark, MoonIcon, SunIcon } from "siparu-ui";
import { getTheme, toggleTheme, type ThemeName } from "../../lib/theme";
import { TABS } from "./BridgeTabBar";
import { TopBarClock } from "./SwissTopBar";

type Props = {
  live?: boolean;
  stale?: boolean;
};

export default function SideNav({ live, stale }: Props) {
  const [theme, setTheme] = useState<ThemeName>(() => getTheme());

  return (
    <nav className="sp-rail" aria-label="Bridge navigation">
      <span className="sp-lockup sp-brand">
        <BrandMark className="sp-glyph" />
        <Link to="/" className="mk" aria-label="Siparu home">
          Siparu
        </Link>
      </span>

      <div className="rnav-list">
        {TABS.map(({ to, end, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            replace
            className={({ isActive }) => `rnav${isActive ? " on" : ""}`}
          >
            <Icon size={20} />
            <span className="rl">{label}</span>
          </NavLink>
        ))}
      </div>

      <div className="rfoot">
        {live && (
          <span className={`live${stale ? " is-stale" : ""}`}>
            <span className="dot" />
            {stale ? "STALE" : "LIVE"}
          </span>
        )}
        <TopBarClock />
        <button
          type="button"
          className="umenu-btn"
          onClick={() => setTheme(toggleTheme())}
          aria-label={theme === "night" ? "Switch to day theme" : "Switch to night theme"}
          title={theme === "night" ? "Day theme" : "Night theme"}
        >
          {theme === "night" ? <SunIcon size={15} /> : <MoonIcon size={15} />}
        </button>
      </div>
    </nav>
  );
}
