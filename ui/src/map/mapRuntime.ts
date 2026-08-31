/** Shared runtime for map surfaces: pmtiles:// protocol registration (once)
 *  and a session-long cache of the chart configuration. Map and Voyage share the
 *  same resolution. MapLibre's own stylesheet is imported by the app's entry, not
 *  here: loaded from a lazy chunk it lands last and wins every tie with ours. */
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { MapConfig, ScreenApi } from "../data/api";

let protocolRegistered = false;

export function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  protocolRegistered = true;
}

/** If the configuration is unreachable the map runs without charts (overlays only). */
export const NO_CHARTS: MapConfig = {
  basemap: null,
  basemapTiles: null,
  seamark: null,
  glyphs: "",
  sprite: "",
  local: { basemap: false, seamark: false, fonts: false, sprites: false },
};

let cached: MapConfig | null = null;
let inflight: Promise<MapConfig> | null = null;

/** Resolved chart assets - success is cached, failure returns NO_CHARTS
 *  (not cached, so a later open recovers once the source is up). */
export function getMapConfig(api: ScreenApi): Promise<MapConfig> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api
      .mapConfig()
      .then((cfg) => {
        cached = cfg;
        return cfg;
      })
      .catch(() => NO_CHARTS)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
