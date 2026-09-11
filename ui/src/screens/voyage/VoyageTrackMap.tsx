/* Voyage track map - mini MapLibre inside the expanded row. Uses the same
 * style factory as the Map tab (night/day brand flavors + seamark). Pan/zoom
 * are free. A few rows open at a time (openRows); mounts on open, unmounts on close. */
import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { TrackPoint } from "../../data/api";
import { ensurePmtilesProtocol, getMapConfig } from "../../map/mapRuntime";
import { useApi } from "../../data/api";
import { makeMapStyle, MAP_ATTRIBUTION, TRACK_SOURCE, type MapMode } from "../../map/style";
import { registerMapSnapshot } from "./printSnapshots";

/** What the printed page shows in the map's place: its picture, and the credit the map carries. */
interface Picture {
  url: string;
  credit: string;
}

/**
 * The map's picture, taken for paper.
 *
 * The drawing buffer is readable only during a frame (the map does not keep it between
 * frames, on purpose - see printSnapshots), so the read is made inside the next render and
 * a render is asked for. A map still fetching tiles is given a moment to finish first, so
 * the page does not print half a coastline; one that never settles is not waited on.
 */
function takePicture(map: maplibregl.Map, container: HTMLElement): Promise<Picture> {
  // The data credit, and only that: the licence asks for it wherever the map is shown, paper
  // included. The "not for navigation" notice stays on screen, where a chart could be mistaken
  // for one; nobody steers by a printed passage record.
  const credit = (container.querySelector(".maplibregl-ctrl-attrib-inner")?.textContent ?? "")
    .replace(MAP_ATTRIBUTION, "")
    .replace(/^\s*\|\s*/, "")
    .trim();
  const settled = map.loaded()
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        map.once("idle", () => {
          clearTimeout(t);
          resolve();
        });
      });
  return settled.then(
    () =>
      new Promise<Picture>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("the map did not draw")), 2000);
        map.once("render", () => {
          clearTimeout(t);
          try {
            resolve({ url: map.getCanvas().toDataURL("image/png"), credit });
          } catch (e) {
            reject(e);
          }
        });
        map.triggerRepaint();
      }),
  );
}

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
  const api = useApi();
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);

  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const container = ref.current;
    const root = document.documentElement;
    const accent = getComputedStyle(root).getPropertyValue("--accent").trim() || "#e5484d";

    let disposed = false;
    let map: maplibregl.Map | null = null;
    let obs: MutationObserver | null = null;
    let unregister: (() => void) | null = null;

    (async () => {
      ensurePmtilesProtocol();
      const charts = await getMapConfig(api);
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
      const m = map;
      unregister = registerMapSnapshot(async () => {
        const pic = await takePicture(m, container);
        if (!disposed) setPicture(pic);
      });

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
      unregister?.();
      obs?.disconnect();
      map?.remove();
      mapRef.current = null;
    };
  }, [track]);

  return (
    <>
      <div ref={ref} className="vy-map" />
      {/* Paper only: the picture the Print button asked for, in the canvas's place. The credit
          goes with it because the map's own attribution control is not part of the canvas. */}
      {picture && (
        <figure className="vy-map-print" aria-hidden="true">
          <img src={picture.url} alt="" />
          <figcaption>{picture.credit}</figcaption>
        </figure>
      )}
    </>
  );
}
