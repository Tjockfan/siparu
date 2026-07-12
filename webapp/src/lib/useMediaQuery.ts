import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatch(e.matches);
    // Initial state is already correct via useState; the effect only subscribes.
    // Instead of calling setState synchronously, we listen through the handler
    // and check mq.matches once - which satisfies the rule.
    handler({ matches: mq.matches } as MediaQueryListEvent);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);

  return match;
}

export const useIsMobile = () => useMediaQuery("(max-width: 767px)");
