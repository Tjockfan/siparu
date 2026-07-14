/* Voyage track map - mini MapLibre inside the expanded row. Uses the same
 * style factory as the Map tab (night/day brand flavors + seamark). Pan/zoom
 * are free. One row open at a time; mounts on open, unmounts on close. */
import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { TrackPoint } from "../../lib/api";
import { ensurePmtilesProtocol, getMapConfig } from "../../map/mapRuntime";
import { makeMapStyle, MAP_ATTRIBUTION, TRACK_SOURCE, type MapMode } from "../../map/style";

function mode(): MapMode {
  return document.documentElement.dataset.theme === "day" ? "day" : "night";
}

function endpointEl(accent: string, filled: boolean): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `width:10px;height:10px;border-radius:50%;border:2px solid ${accent};background:${
    filled ? accent : "transparent"
  };`;
  return el;
}

export default function VoyageTrackMap({ track }: { track: TrackPoint[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const container = ref.current;
    const root = document.documentElement;
    const accent = getComputedStyle(root).getPropertyValue("--accent").trim() || "#e5484d";

    let disposed = false;
    let map: maplibregl.Map | null = null;
    let obs: MutationObserver | null = null;

    (async () => {
      ensurePmtilesProtocol();
      const charts = await getMapConfig();
      if (disposed) return;

      const styleFor = () => makeMapStyle(mode(), charts, { track: { color: accent, width: 3 } });

      const ll = track
        .filter((p) => p.lat !== null && p.lon !== null)
        .map((p) => [p.lon, p.lat] as [number, number]);

      map = new maplibregl.Map({
        container,
        style: styleFor(),
        center: [7.42, 43.7],
        zoom: 9,
        attributionControl: { compact: false, customAttribution: MAP_ATTRIBUTION },
        dragRotate: false,
        pitchWithRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      mapRef.current = map;

      const applyTrack = () => {
        if (!map) return;
        const src = map.getSource(TRACK_SOURCE) as maplibregl.GeoJSONSource | undefined;
        if (src && ll.length >= 2) {
          src.setData({
            type: "FeatureCollection",
            features: [
              { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ll } },
            ],
          });
        }
      };
      map.on("style.load", applyTrack);
      applyTrack();

      if (ll.length >= 2) {
        // start: hollow ring · end: filled dot (accent)
        new maplibregl.Marker({ element: endpointEl(accent, false), anchor: "center" })
          .setLngLat(ll[0])
          .addTo(map);
        new maplibregl.Marker({ element: endpointEl(accent, true), anchor: "center" })
          .setLngLat(ll[ll.length - 1])
          .addTo(map);
        const bounds = new maplibregl.LngLatBounds();
        for (const p of ll) bounds.extend(p);
        map.fitBounds(bounds, { padding: 22, maxZoom: 15, animate: false });
      }

      // When data-theme (night/day) changes, the style is regenerated; the
      // track is re-applied on style.load.
      obs = new MutationObserver(() => {
        map?.setStyle(styleFor());
        applyTrack();
      });
      obs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    })();

    return () => {
      disposed = true;
      obs?.disconnect();
      map?.remove();
      mapRef.current = null;
    };
  }, [track]);

  return <div ref={ref} className="vy-map" />;
}
