import { useEffect, useState } from "react";

/** A periodically updated "now" value used instead of a render-time
 *  `Date.now()`, so the pure-render rule is not violated. Ticks every
 *  30 seconds by default. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (t === null) t = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (t !== null) {
        clearInterval(t);
        t = null;
      }
    };
    // Don't tick while the tab is hidden; update immediately once visible again.
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        setNow(Date.now());
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
  return now;
}
