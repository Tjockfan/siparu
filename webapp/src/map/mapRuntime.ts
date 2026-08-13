/** Shared runtime for map surfaces: pmtiles:// protocol registration (once)
 *  and a session-long cache of /map-config. Map and Voyage share the same resolution. */
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { api, type MapConfig } from "../lib/api";

let protocolRegistered = false;

export function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  protocolRegistered = true;
}

/** If /map-config is unreachable the map runs without charts (overlays only). */
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
 *  (not cached, so a later open recovers once the plugin is up). */
export function getMapConfig(): Promise<MapConfig> {
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
