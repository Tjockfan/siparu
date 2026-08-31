/* Siparu - desktop side rail (Swiss). Rendered instead of the top header and the bottom tab bar
 * on a wide screen, where a full-width bottom bar would stretch each tab to a quarter of the
 * viewport. Below the breakpoint this is not mounted at all (Layout branches on the same width),
 * so the phone keeps its header + bottom bar untouched.
 *
 * Three bands, top to bottom: the brand, the same destinations the bottom bar carries (drawn
 * vertically from the shared TABS list), and a footer holding the live/stale state, the
 * boat-local clock and the theme toggle - the chrome that lives in the header on a phone. */
import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { BridgeLogIcon, BrandMark, ChevLeft, EngineLogIcon, MoonIcon, SunIcon } from "../../index";
import { getTheme, toggleTheme, type ThemeName } from "../../data/theme";
import { TABS, type TabSpec } from "./BridgeTabBar";
import { TopBarClock } from "./SwissTopBar";
import { useHref } from "../../data/routes";

/**
 * The two books, drawn under Logbook while the reader is in it.
 *
 * They open only there. A rail carrying every destination's children at all times is a site
 * map rather than a place to steer from, and these two are the only ones with children: the
 * ship keeps two logs and one of everything else.
 */
const BOOKS = [
  { to: "/logbook/bridge", label: "Bridge", Icon: BridgeLogIcon },
  { to: "/logbook/engine", label: "Engine", Icon: EngineLogIcon },
] as const;

type Props = {
  tabs?: readonly TabSpec[];
  live?: boolean;
  stale?: boolean;
  /** Where the screens sit inside a larger app; drawn as a way back above the brand. */
  back?: string;
  /** The boat's name, when the app shows more than one. */
  context?: string;
};

export default function SideNav({ tabs = TABS, live, stale, back, context }: Props) {
  const [theme, setTheme] = useState<ThemeName>(() => getTheme());
  const href = useHref();
  const inLogbook = useLocation().pathname.startsWith(href("/logbook"));

  return (
    <nav className="sp-rail" aria-label="Bridge navigation">
      {back && (
        <Link to={back} className="rback" aria-label="Back">
          <ChevLeft size={15} />
          <span className="rl">Boats</span>
        </Link>
      )}
      <span className="sp-lockup sp-brand">
        <BrandMark className="sp-glyph" />
        <Link to={href("/")} className="mk" aria-label="Siparu home">
          Siparu
        </Link>
      </span>
      {context && <span className="rctx">{context}</span>}

      <div className="rnav-list">
        {tabs.map(({ to, end, label, Icon }) => (
          <div key={to} className="rnav-item">
            <NavLink
              to={href(to)}
              end={end}
              replace
              className={({ isActive }) => `rnav${isActive ? " on" : ""}`}
            >
              <Icon size={20} />
              <span className="rl">{label}</span>
            </NavLink>
            {to === "/logbook" && inLogbook && (
              <div className="rnav-sub">
                {BOOKS.map((b) => (
                  <NavLink
                    key={b.to}
                    to={href(b.to)}
                    replace
                    className={({ isActive }) => `rsub${isActive ? " on" : ""}`}
                  >
                    <b.Icon size={16} />
                    <span className="rl">{b.label}</span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
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
