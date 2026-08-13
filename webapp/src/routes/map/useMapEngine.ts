/** MapLibre GL engine for the map screen - independent of theme variants.
 *  Chart assets (PMTiles/glyph/sprite) are resolved from the plugin's
 *  /map-config; the style comes from the style.ts factory. The caller
 *  renders its own chrome (header / overlay / tab bar). */
import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { api, type Snapshot, type AisTarget } from "../../lib/api";
import { ensurePmtilesProtocol, getMapConfig } from "../../map/mapRuntime";
import { radToDeg } from "../../lib/format";
import { startVisibleInterval } from "../../lib/visibleInterval";
import {
  AIS_LIMIT_MAX,
  AIS_LIMIT_MIN,
  AIS_NM_MAX,
  AIS_NM_MIN,
  loadAisPrefs,
  saveAisPrefs,
} from "../../lib/aisPrefs";
import {
  basemapSourceId,
  makeMapStyle,
  MAP_ATTRIBUTION,
  TRACK_SOURCE,
  type MapMode,
  type TrackStyle,
} from "../../map/style";

const DEFAULT_CENTER: [number, number] = [7.4246, 43.7384]; // Monaco (lon, lat)
const DEFAULT_ZOOM = 8;

/** How long a chart may stay blank before the map admits it. Long enough that a slow
 *  uplink is not called broken, short enough that nobody stares at empty water. */
const CHART_TIMEOUT_MS = 10_000;
const LATEST_REFRESH_MS = 30_000;
const TRACK_REFRESH_MS = 5 * 60_000;
const TRACK_WINDOW_MS = 24 * 3600 * 1000;
const AIS_REFRESH_MS = 30_000;
// avoid a burst of requests during slider scrubbing
const AIS_PREF_DEBOUNCE_MS = 250;

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

type LatLon = { lat: number; lon: number };

function currentMode(): MapMode {
  return document.documentElement.dataset.theme === "day" ? "day" : "night";
}

function trackGeojson(pts: LatLon[]): FeatureCollection {
  if (pts.length < 2) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: pts.map((p) => [p.lon, p.lat]) },
      },
    ],
  };
}

export interface MapEngineConfig {
  track: TrackStyle;
  /** Zoom control position - defaults to bottom-left (marine). */
  zoomPosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  popupHtml: (s: Snapshot, nowMs: number) => string;
  aisPopupHtml: (t: AisTarget) => string;
  /** Marker visual as an HTML string - the engine injects it into the marker element. */
  makeBoat: (headingDeg: number | null) => string;
  makeAis: (courseDeg: number | null) => string;
}

export interface MapEngine {
  containerRef: React.RefObject<HTMLDivElement | null>;
  aisOn: boolean;
  setAisOn: React.Dispatch<React.SetStateAction<boolean>>;
  aisCount: number;
  /** Range (nautical miles) - changed via the slider, persisted to localStorage. */
  aisMaxNm: number;
  setAisMaxNm: (n: number) => void;
  /** Maksimum hedef sayisi. */
  aisLimit: number;
  setAisLimit: (n: number) => void;
  latest: Snapshot | null;
  /** Diagnostic micro-note explaining why chart tiles are absent; null = healthy. */
  chartNote: string | null;
  /** Refit the map to the 24h track / boat bounds. */
  recenter: () => void;
}

export function useMapEngine(cfg: MapEngineConfig): MapEngine {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const boatMarkerRef = useRef<maplibregl.Marker | null>(null);
  const boatPopupRef = useRef<maplibregl.Popup | null>(null);
  const aisMarkersRef = useRef<maplibregl.Marker[]>([]);
  const initialFitDoneRef = useRef(false);
  const trackDataRef = useRef<FeatureCollection>(trackGeojson([]));
  // keep config in a ref - stay current without re-triggering effects.
  const cfgRef = useRef(cfg);
  useEffect(() => {
    cfgRef.current = cfg;
  });

  const [aisOn, setAisOn] = useState(true);
  const [aisCount, setAisCount] = useState(0);
  const [chartNote, setChartNote] = useState<string | null>(null);
  // Slider preferences - loaded from localStorage, persisted on set.
  const [aisMaxNm, setAisMaxNmState] = useState<number>(() => loadAisPrefs().maxNm);
  const [aisLimit, setAisLimitState] = useState<number>(() => loadAisPrefs().limit);
  const setAisMaxNm = useCallback(
    (n: number) => {
      const v = clampInt(n, AIS_NM_MIN, AIS_NM_MAX);
      setAisMaxNmState(v);
      saveAisPrefs({ maxNm: v, limit: aisLimit });
    },
    [aisLimit]
  );
  const setAisLimit = useCallback(
    (n: number) => {
      const v = clampInt(n, AIS_LIMIT_MIN, AIS_LIMIT_MAX);
      setAisLimitState(v);
      saveAisPrefs({ maxNm: aisMaxNm, limit: v });
    },
    [aisMaxNm]
  );
  const [trackPoints, setTrackPoints] = useState<LatLon[]>([]);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const trackPointsRef = useRef<LatLon[]>([]);
  useEffect(() => {
    trackPointsRef.current = trackPoints;
  }, [trackPoints]);

  const recenter = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const pts = trackPointsRef.current;
    if (pts.length >= 2) {
      const bounds = new maplibregl.LngLatBounds();
      for (const p of pts) bounds.extend([p.lon, p.lat]);
      map.fitBounds(bounds, { padding: 40, maxZoom: 14 });
      return;
    }
    const m = boatMarkerRef.current;
    if (m) map.easeTo({ center: m.getLngLat(), zoom: Math.max(map.getZoom(), 12) });
  }, []);

  /** Push track data into the style - also called after setStyle. */
  const syncTrack = useCallback((map: maplibregl.Map) => {
    const src = map.getSource(TRACK_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(trackDataRef.current);
  }, []);

  // ===== Map init =====
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const container = containerRef.current;
    let disposed = false;
    let map: maplibregl.Map | null = null;
    let modeObserver: MutationObserver | null = null;
    let chartTimer: number | undefined;

    (async () => {
      ensurePmtilesProtocol();
      const charts = await getMapConfig();
      if (disposed) return;
      const basemapSource = basemapSourceId(charts);
      if (!basemapSource) {
        setChartNote("Chart unavailable - position and track only");
      }

      const styleFor = (mode: MapMode) => makeMapStyle(mode, charts, { track: cfgRef.current.track });

      map = new maplibregl.Map({
        container,
        style: styleFor(currentMode()),
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        attributionControl: { compact: false, customAttribution: MAP_ATTRIBUTION },
        dragRotate: false,
        pitchWithRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      mapRef.current = map;
      map.addControl(
        new maplibregl.NavigationControl({ showCompass: false }),
        cfgRef.current.zoomPosition ?? "bottom-left"
      );

      // Yellow diagnostic note if chart tiles never stream in; clear it once the first tile
      // arrives. Only an actual tile counts as arrival. Neither of the obvious signals can
      // be trusted for a hosted basemap: when its TileJSON fails to load, MapLibre marks
      // the source loaded anyway ("let's pretend it's loaded so the source will be
      // ignored") and fires its error without a sourceId. Watching either one would clear
      // this warning, or never raise it, on exactly the boat that needs it: the one whose
      // uplink just died. So the question asked here is the honest one, "did a tile draw",
      // and silence is what raises the note.
      let basemapSeen = false;
      map.on("sourcedata", (e) => {
        const drew = !!(e as { tile?: unknown }).tile;
        if (e.sourceId === basemapSource && drew && !basemapSeen) {
          basemapSeen = true;
          setChartNote(null);
        }
      });
      chartTimer = window.setTimeout(() => {
        if (!basemapSeen && basemapSource) {
          setChartNote("Chart tiles unreachable - position and track only");
        }
      }, CHART_TIMEOUT_MS);

      // Rebuild the style when the theme (night/day) changes; thanks to diffing
      // the map is not reset. Since the track source's data is empty in the
      // style JSON, it is pushed back in immediately afterward.
      map.on("style.load", () => {
        if (map) syncTrack(map);
      });
      modeObserver = new MutationObserver(() => {
        if (!map) return;
        map.setStyle(styleFor(currentMode()));
        syncTrack(map);
      });
      modeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    })();

    return () => {
      disposed = true;
      window.clearTimeout(chartTimer);
      modeObserver?.disconnect();
      aisMarkersRef.current.forEach((m) => m.remove());
      aisMarkersRef.current = [];
      boatMarkerRef.current = null;
      boatPopupRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
  }, [syncTrack]);

  // ===== AIS targets =====
  useEffect(() => {
    if (!aisOn) {
      aisMarkersRef.current.forEach((m) => m.remove());
      aisMarkersRef.current = [];
      // Intentional: AIS turned off - single shot since there is no fetch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAisCount(0);
      return;
    }

    let cancelled = false;
    const fetchAis = async () => {
      try {
        const feed = await api.ais.targets({ maxNm: aisMaxNm, limit: aisLimit });
        if (cancelled) return;
        const map = mapRef.current;
        if (!map) return;
        aisMarkersRef.current.forEach((m) => m.remove());
        aisMarkersRef.current = [];
        for (const t of feed.targets) {
          const course = t.cog_deg ?? t.heading_deg ?? null;
          const el = document.createElement("div");
          el.className = "sp-ais-marker";
          el.innerHTML = cfgRef.current.makeAis(course);
          const marker = new maplibregl.Marker({ element: el, anchor: "center" })
            .setLngLat([t.lon, t.lat])
            .setPopup(
              new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: "280px" }).setHTML(
                cfgRef.current.aisPopupHtml(t)
              )
            )
            .addTo(map);
          aisMarkersRef.current.push(marker);
        }
        setAisCount(feed.targets.length);
      } catch {
        /* keep stale markers */
      }
    };
    // single fetch as soon as slider scrubbing stops - then periodic refresh (pauses while the tab is hidden)
    const debounce = window.setTimeout(fetchAis, AIS_PREF_DEBOUNCE_MS);
    const stopInterval = startVisibleInterval(fetchAis, AIS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
      stopInterval();
    };
  }, [aisOn, aisMaxNm, aisLimit]);

  // ===== Track (24h) =====
  useEffect(() => {
    let cancelled = false;
    const fetchTrack = async () => {
      try {
        const now = Date.now();
        const data = await api.logbook.snapshots({
          from: now - TRACK_WINDOW_MS,
          order: "asc",
          bucket: 1,
          limit: 2000,
        });
        if (cancelled) return;
        const pts: LatLon[] = data
          .filter((s) => s.lat !== null && s.lon !== null)
          .map((s) => ({ lat: s.lat as number, lon: s.lon as number }));
        setTrackPoints(pts);
      } catch {
        /* ignore */
      }
    };
    fetchTrack();
    const stopInterval = startVisibleInterval(fetchTrack, TRACK_REFRESH_MS);
    return () => {
      cancelled = true;
      stopInterval();
    };
  }, []);

  // ===== Draw track line =====
  useEffect(() => {
    trackDataRef.current = trackGeojson(trackPoints);
    const map = mapRef.current;
    if (!map) return;
    syncTrack(map);

    if (!initialFitDoneRef.current && trackPoints.length >= 2) {
      initialFitDoneRef.current = true;
      const bounds = new maplibregl.LngLatBounds();
      for (const p of trackPoints) bounds.extend([p.lon, p.lat]);
      map.fitBounds(bounds, { padding: 40, maxZoom: 14 });
    }
  }, [trackPoints, syncTrack]);

  // ===== Latest snapshot → boat marker =====
  useEffect(() => {
    let cancelled = false;
    const fetchLatest = async () => {
      try {
        const s = await api.logbook.snapshotLatest();
        if (cancelled) return;
        setLatest(s);
        const map = mapRef.current;
        if (!map) return;
        if (s.lat === null || s.lon === null) return;
        const hdgDeg = radToDeg(s.heading_true);
        const html = cfgRef.current.makeBoat(hdgDeg);
        const ll: [number, number] = [s.lon, s.lat];

        if (!boatMarkerRef.current) {
          const el = document.createElement("div");
          el.className = "sp-boat-marker";
          el.innerHTML = html;
          const popup = new maplibregl.Popup({ closeButton: true, offset: 16, maxWidth: "300px" }).setHTML(
            cfgRef.current.popupHtml(s, Date.now())
          );
          boatPopupRef.current = popup;
          boatMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
            .setLngLat(ll)
            .setPopup(popup)
            .addTo(map);
          if (!initialFitDoneRef.current) {
            map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 11) });
          }
        } else {
          boatMarkerRef.current.setLngLat(ll);
          boatMarkerRef.current.getElement().innerHTML = html;
          boatPopupRef.current?.setHTML(cfgRef.current.popupHtml(s, Date.now()));
        }
      } catch {
        /* ignore */
      }
    };
    fetchLatest();
    const stopInterval = startVisibleInterval(fetchLatest, LATEST_REFRESH_MS);
    return () => {
      cancelled = true;
      stopInterval();
    };
  }, []);

  return {
    containerRef,
    aisOn,
    setAisOn,
    aisCount,
    aisMaxNm,
    setAisMaxNm,
    aisLimit,
    setAisLimit,
    latest,
    chartNote,
    recenter,
  };
}
