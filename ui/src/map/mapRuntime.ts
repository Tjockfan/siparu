/** Shared runtime for map surfaces: worker URL and pmtiles:// protocol
 *  registration (once) and a session-long cache of the chart configuration. Map and Voyage share the
 *  same resolution. MapLibre's own stylesheet is imported by the app's entry, not
 *  here: loaded from a lazy chunk it lands last and wins every tie with ours. */
import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";
import type { MapConfig, ScreenApi } from "../data/api";

let registered = false;

/** MapLibre finds its worker next to its own module, which a bundle does not keep,
 *  so the worker is handed over as an asset of this build: same origin, which the
 *  portal's worker-src expects. `?worker&url` and not `?url`: the worker imports a
 *  sibling chunk that only the worker pipeline bundles in. */
export function ensureMapRuntime(): void {
  if (registered) return;
  maplibregl.setWorkerUrl(workerUrl);
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  registered = true;
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
