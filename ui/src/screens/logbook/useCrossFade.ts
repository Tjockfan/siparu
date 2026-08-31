/**
 * Hold what is on screen one moment longer than the choice that changed it.
 *
 * A table that swaps its contents on the frame the button is pressed reads as a flicker: the
 * engines are there, then the generators are, and nothing tells the eye that one replaced the
 * other. Given a moment to leave, the change is legible - the page goes quiet, then comes back
 * carrying something else.
 *
 * The value is what the reader asked for; what comes back is what the screen should still be
 * drawing, and whether it is on its way out. The two part company only for the length of the
 * fade, so nothing else has to know this is happening.
 */
import { useEffect, useState } from "react";

export function useCrossFade<T>(value: T, ms: number): [T, boolean] {
  const [shown, setShown] = useState(value);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (value === shown) return;
    setLeaving(true);
    const t = setTimeout(() => {
      setShown(value);
      setLeaving(false);
    }, ms);
    // The reader can press again before the fade is out. Clearing here means the second press
    // replaces the first rather than queueing behind it, so a run down the tabs ends on the
    // tab he stopped at and not on the one he passed through.
    return () => clearTimeout(t);
  }, [value, shown, ms]);

  return [shown, leaving];
}
