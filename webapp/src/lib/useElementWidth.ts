import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The measured width of one element, or null until it has been measured.
 *
 * Null is "not known yet", which is deliberately a different answer from a number: it is what
 * a server render and a browser without ResizeObserver both report, and a caller that treats
 * it as a width would lay the page out for a phone on a chart table. Callers are expected to
 * draw everything while the answer is null and narrow it once a real number arrives.
 *
 * A ref callback rather than a ref object, so the first measurement happens when the node is
 * attached instead of a frame later.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const obs = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    obs.current = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(w);
    });
    obs.current.observe(node);
  }, []);

  useEffect(() => () => obs.current?.disconnect(), []);

  return [ref, width];
}
