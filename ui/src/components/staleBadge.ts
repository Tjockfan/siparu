/**
 * When the LIVE badge has to say STALE instead.
 *
 * The badge is a claim about the data on the screen, so it is judged by the poll that feeds
 * that screen, and each live screen has its own. The telemetry screen polls every two
 * seconds, so ten seconds without a successful fetch is a boat that has gone quiet. The map
 * fetches her position every thirty seconds and the top bar her live frame every sixty; the
 * badge there used to be computed for the telemetry screen only, so the chart said LIVE for
 * as long as it was open, with the boat switched off and the popup frozen at the age it last
 * drew. The map is judged by the freshest of its two feeds, against its own cadence: two and
 * a half of its own polls missed is a chart lying, not a slow uplink.
 *
 * Ages come from the cache: usePolling and the map engine write it only on a SUCCESSFUL
 * fetch, so a failing poll leaves the timestamp where it was and the age grows. Null (never
 * fetched) is not stale, it is not yet anything, and the badge stays as it was.
 */
export const STALE_AFTER_MS: Record<"/" | "/map", number> = {
  "/": 10_000,
  "/map": 75_000,
};

export type LiveRoute = keyof typeof STALE_AFTER_MS;

/** Which of the live screens a path is, or null for every other screen. */
export function liveRouteOf(pathname: string, at: (path: string) => string): LiveRoute | null {
  if (pathname === at("/")) return "/";
  if (pathname === at("/map")) return "/map";
  return null;
}

export function staleOn(
  route: LiveRoute | null,
  now: number,
  bridgeTs: number | null,
  mapTs: number | null,
): boolean {
  if (route === null) return false;
  const freshest =
    route === "/" ? bridgeTs : bridgeTs === null ? mapTs : mapTs === null ? bridgeTs : Math.max(bridgeTs, mapTs);
  return freshest !== null && now - freshest > STALE_AFTER_MS[route];
}
