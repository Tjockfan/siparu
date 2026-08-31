/**
 * Where the screens live in the address bar.
 *
 * Aboard they are the whole app and sit at the root: `/`, `/logbook`, `/map`. Ashore the same
 * screens sit under the boat they show: `/boats/:id`, `/boats/:id/logbook`. A screen that
 * wrote `/logbook` into a link would work in one app and lead out of the other, so every
 * link a screen draws goes through `useHref`, and the app that mounts the screens says what
 * comes before the path.
 */
import { createContext, useContext, type ReactNode } from "react";

const BaseContext = createContext("");

export function RouteBase({ base, children }: { base: string; children: ReactNode }) {
  return <BaseContext.Provider value={base}>{children}</BaseContext.Provider>;
}

/** Join the app's base onto a screen path. The root path is the base itself. */
export function joinBase(base: string, path: string): string {
  if (path === "/") return base || "/";
  return base + path;
}

/** The app's base for the screens, "" when they sit at the root. */
export function useBase(): string {
  return useContext(BaseContext);
}

/** A resolver from screen path to app address, for every link a screen draws. */
export function useHref(): (path: string) => string {
  const base = useContext(BaseContext);
  return (path) => joinBase(base, path);
}
