/* Siparu - shared header band (Swiss `.head`).
 * back chevron · mark + SIPARU wordmark · context tag · [LIVE] · [clock] · theme toggle. */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type LiveSnapshot } from "../../lib/api";
import { useNow } from "../../lib/useNow";
import { usePolling } from "../../lib/usePolling";
import { getTheme, toggleTheme, type ThemeName } from "../../lib/theme";
import { BrandMark, ChevLeft, MoonIcon, SunIcon } from "siparu-ui";

type Props = {
  /** true → history back; string → navigate(path). */
  back?: boolean | string;
  /** context tag, e.g. "Voyage". */
  context?: string;
  live?: boolean;
  stale?: boolean;
  /** ticking HH:MM:SS clock on the right. */
  clock?: boolean;
};

function utc(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

/** Local time at the boat's GPS position. lat/lon → IANA timezone (tz-lookup,
 *  lazy) → DST-correct render ("16:23:45 CEST"). Falls back to UTC. */
function TopBarClock() {
  const now = useNow(1000);
  const { data: snap } = usePolling<LiveSnapshot>(api.live, 60_000, [], "bridge:live");
  const [tz, setTz] = useState<string | null>(null);

  const lat = snap?.lat ?? null;
  const lon = snap?.lon ?? null;
  // ~11 km (0.1°) key - small movements must not recompute the timezone.
  const latKey = lat === null ? null : Math.round(lat * 10);
  const lonKey = lon === null ? null : Math.round(lon * 10);

  useEffect(() => {
    if (lat === null || lon === null) return;
    let ok = true;
    import("tz-lookup")
      .then((m) => {
        if (ok) setTz(m.default(lat, lon));
      })
      .catch(() => {/* tz-lookup unavailable → UTC stays */});
    return () => {
      ok = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latKey, lonKey]);

  let label = utc(now);
  if (tz) {
    try {
      label = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZoneName: "short",
      }).format(now);
    } catch {/* invalid tz → UTC stays */}
  }
  return <span className="clk">{label}</span>;
}

export default function SwissTopBar({ back, context, live, stale, clock }: Props) {
  const navigate = useNavigate();
  const [theme, setTheme] = useState<ThemeName>(() => getTheme());

  const onBack = () => {
    if (typeof back === "string") navigate(back);
    else navigate(-1);
  };

  return (
    <header className="head">
      <div className="mkwrap">
        {back != null && back !== false && (
          <button type="button" className="back" onClick={onBack} aria-label="Back">
            <ChevLeft size={15} />
          </button>
        )}
        <span className="sp-lockup">
          <BrandMark className="sp-glyph" />
          <Link to="/" className="mk" aria-label="Siparu home">
            Siparu
          </Link>
        </span>
        {context && <span className="ctx">{context}</span>}
      </div>

      <div className="r">
        {live && (
          <span className={`live${stale ? " is-stale" : ""}`}>
            <span className="dot" />
            {stale ? "STALE" : "LIVE"}
          </span>
        )}
        {clock && <TopBarClock />}
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
    </header>
  );
}
