/**
 * MapLibre style factory - the single place the map's look is defined.
 *
 * Basemap layers are generated from a Siparu "flavor" (night = default cockpit
 * grays, day = light) so both modes stay on the Swiss palette: gray families
 * only, red is reserved for own-ship and track overlays. The generator depends
 * on where the basemap comes from, because the two sources speak different tile
 * schemas: a local PMTiles archive is Protomaps (@protomaps/basemaps), the hosted
 * basemap is OpenMapTiles (omt.ts). The flavor is shared, so the chart looks the
 * same either way. Seamarks come from the vendored vector-seamarks style (BSD-2)
 * rendered from our own PMTiles.
 *
 * Asset URLs come from the plugin's /map-config, never hardcoded: local charts
 * folder when present, hosted tiles otherwise.
 */
import { namedFlavor, layers as basemapLayers } from '@protomaps/basemaps'
import type {
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
  SymbolLayerSpecification
} from 'maplibre-gl'
import type { MapConfig } from '../lib/api'
import { omtLayers } from './omt'
import seamarkLayersRaw from './seamarks-layers.json'

export type MapMode = 'night' | 'day'

export interface TrackStyle {
  color: string
  width: number
  /** [dash, gap] in line-width units; omit for a solid line. */
  dash?: [number, number]
}

export interface StyleOptions {
  track: TrackStyle
  /** Render the seamark overlay (buoys, lights, beacons). Default true. */
  seamarks?: boolean
}

/** Layer/source ids the engine talks to at runtime. */
export const TRACK_SOURCE = 'sp-track'
export const TRACK_LAYER = 'sp-track-line'
const PMTILES_SOURCE = 'protomaps'
const OMT_SOURCE = 'openmaptiles'
const SEAMARK_SOURCE = 'seamark'

const FONT_REGULAR = 'Noto Sans Regular'

/**
 * Which source id carries the basemap for this config, or null when there is no
 * basemap at all. The engine watches tile errors by source id, so it has to ask
 * rather than assume: a hardcoded id here means the "chart unreachable" note never
 * fires for the other schema, and an offline boat gets blank water with no warning.
 */
export function basemapSourceId(cfg: MapConfig): string | null {
  if (cfg.basemap) return PMTILES_SOURCE
  if (cfg.basemapTiles) return OMT_SOURCE
  return null
}

/** Product stance, added by the map control. Data credits come from the sources. */
export const MAP_ATTRIBUTION = 'Not for navigation'

/** ODbL credit for the offline archive, which carries no TileJSON to declare one. */
const PMTILES_ATTRIBUTION = '© OpenStreetMap contributors'

/* Siparu night flavor: protomaps "black" recolored onto the Swiss
 * night tokens (see swiss.css) - sea #101418, land #1e2226. Roads and
 * casings sit a step above land; every label is gray, halos match land. */
function nightFlavor() {
  const f = { ...namedFlavor('black') }
  const land = '#1e2226'
  const sea = '#101418'
  const road = '#2a2f34'
  const label = '#7d848a'
  Object.assign(f, {
    background: sea,
    earth: land,
    water: sea,
    buildings: '#23282d',
    park_a: land,
    park_b: land,
    wood_a: '#20252a',
    wood_b: '#20252a',
    scrub_a: land,
    scrub_b: land,
    sand: '#22272b',
    beach: '#22272b',
    glacier: '#252a2f',
    aerodrome: land,
    runway: road,
    pier: '#2c3238',
    minor_a: road,
    minor_b: road,
    minor_service: road,
    other: road,
    link: road,
    major: '#31373d',
    highway: '#383f46',
    railway: '#2e343a',
    boundaries: '#454c53',
    city_label: label,
    city_label_halo: land,
    subplace_label: '#5f666c',
    subplace_label_halo: land,
    state_label: '#4c5359',
    state_label_halo: land,
    country_label: '#6a7177',
    ocean_label: '#3d444b',
    roads_label_minor: '#565d63',
    roads_label_minor_halo: land,
    roads_label_major: '#666d73',
    roads_label_major_halo: land,
    address_label: label,
    address_label_halo: land
  })
  return f
}

/* Day flavor: protomaps "light" cooled down to the Swiss day palette -
 * pale blue-gray sea, warm gray land, no candy colors. */
function dayFlavor() {
  const f = { ...namedFlavor('light') }
  const land = '#e8e6e2'
  const sea = '#ccd9e0'
  Object.assign(f, {
    background: sea,
    earth: land,
    water: sea,
    buildings: '#d9d6d1',
    park_a: '#e2e2da',
    park_b: '#e2e2da',
    wood_a: '#dde0d6',
    wood_b: '#dde0d6',
    scrub_a: '#e2e2da',
    scrub_b: '#e2e2da',
    sand: '#eae7df',
    beach: '#eae7df',
    pier: '#d2cfc9',
    city_label: '#4c5359',
    city_label_halo: land,
    ocean_label: '#9fb2bc'
  })
  return f
}

/** Basemap layers minus everything that needs a basemap sprite - the only
 *  sprite in the style is the seamark sheet (nautical map, no POI clutter). */
function brandBasemapLayers(mode: MapMode): LayerSpecification[] {
  const flavor = mode === 'day' ? dayFlavor() : nightFlavor()
  const out: LayerSpecification[] = []
  for (const layer of basemapLayers(PMTILES_SOURCE, flavor, { lang: 'en' })) {
    if (layer.id === 'roads_oneway' || layer.id === 'roads_shields') continue
    if (layer.type === 'symbol' && layer.layout && 'icon-image' in layer.layout) {
      // keep the label, drop the townspot icon
      const layout = { ...(layer.layout as SymbolLayerSpecification['layout']) }
      delete (layout as Record<string, unknown>)['icon-image']
      out.push({ ...layer, layout } as LayerSpecification)
      continue
    }
    out.push(layer)
  }
  return out
}

/** Vendored seamark layers, retargeted to our source and fonts. */
type RawLayer = {
  id: string
  layout?: Record<string, unknown>
  paint?: Record<string, unknown>
} & Record<string, unknown>

/* Marina berth names/labels are noise on a tracking map - these were
 * exactly the "pink zone boxes" of the old raster seamark overlay.
 *
 * Overhead cables and pipelines go with them, and that is a deliberate call rather
 * than a tidy-up. They mark air draft: a span over a waterway, and the height a mast
 * has to pass under. That is a plotter's business and this is not a plotter - the
 * chart says "Not for navigation" and means it. Ashore, where these mostly run, they
 * drew loud orange and magenta lines across hillsides behind the anchorage, which is
 * the kind of clutter that teaches a skipper to stop reading the screen.
 *
 * The SUBMARINE cable and pipeline layers stay. They lie on the seabed under the boat,
 * and they are the one thing on this map that answers a question the owner actually
 * asks it: whether it is safe to drop the anchor here. */
const SEAMARK_DROP = new Set([
  'sm_berth_label',
  'sm_berth_area',
  'sm_berth_line',
  'sm_berth',
  'sm_cable_overhead',
  'sm_pipeline_overhead'
])

function brandSeamarkLayers(mode: MapMode): LayerSpecification[] {
  const raw = seamarkLayersRaw as unknown as RawLayer[]
  const label = mode === 'day' ? '#5c6166' : '#8b9095'
  const halo = mode === 'day' ? 'rgba(232,230,226,0.85)' : 'rgba(16,20,24,0.85)'
  const out: LayerSpecification[] = []
  for (const l of raw) {
    if (SEAMARK_DROP.has(l.id)) continue
    // Some vendored area and line layers carry no colour at all: upstream renders them
    // over a nautical basemap that supplies one. Ours does not, so MapLibre falls back
    // to its default, black, and paints unlabelled black slabs across open water. They
    // stayed hidden while the seamark archive was a small regional cut and surfaced the
    // moment it went planet-wide. A shape whose meaning we cannot state is not drawn.
    //
    // A pattern counts as a colour: MapLibre paints those from the sprite sheet, never
    // from the black default. Reading the rule too narrowly cost us the five layers that
    // are the whole point of a seamark overlay - anchorages, restricted areas, and the
    // submarine cables and pipelines you must not drop an anchor onto - because their
    // paint is a dashed pattern and no line-color.
    const paints = l.paint ?? {}
    const unpainted =
      (l.type === 'fill' && !('fill-color' in paints) && !('fill-pattern' in paints)) ||
      (l.type === 'line' && !('line-color' in paints) && !('line-pattern' in paints))
    if (unpainted) continue
    const layer: Record<string, unknown> = { ...l, source: SEAMARK_SOURCE }
    if (l.layout && Array.isArray(l.layout['text-font'])) {
      layer.layout = { ...l.layout, 'text-font': [FONT_REGULAR] }
    }
    if (l.id === 'sm_harbour') {
      // Icon-only: the harbour name duplicates the basemap place label
      // (same name, different point - collision dedup impossible); the
      // locality layer carries the name.
      const layout = { ...((layer.layout as Record<string, unknown>) ?? {}) }
      for (const k of Object.keys(layout)) if (k.startsWith('text-')) delete layout[k]
      // At low zoom the magenta marina disk must not overpower the own-ship
      // marker. The original was a fixed 0.25 - now a 0.14 -> 0.25 zoom ramp.
      layout['icon-size'] = { stops: [[9, 0.14], [12, 0.18], [15, 0.25]] }
      layer.layout = layout
      layer.paint = { ...(l.paint ?? {}), 'icon-opacity': { stops: [[9, 0.7], [13, 0.95]] } }
      out.push(layer as unknown as LayerSpecification)
      continue
    }
    const hasText = !!l.layout && 'text-field' in l.layout
    if (hasText) {
      const paint = { ...(l.paint ?? {}) }
      // The classic seamark magenta clashes with the Swiss palette -> neutral
      // gray; colorless labels default to BLACK and are unreadable on the
      // night map -> same gray. Meaningful colors (orange radar, red danger)
      // are left untouched.
      if (!paint['text-color'] || paint['text-color'] === '#a30075' || paint['text-color'] === '#000000') {
        paint['text-color'] = label
      }
      if (!paint['text-halo-color']) {
        paint['text-halo-color'] = halo
        paint['text-halo-width'] = 1
      }
      layer.paint = paint
    }
    out.push(layer as unknown as LayerSpecification)
  }
  return out
}

/** Relative /plugins/... URLs must become absolute before PMTiles sees them.
 *  Plain concat, not new URL(): the glyph template's {fontstack}/{range}
 *  braces must survive un-encoded. */
function abs(url: string): string {
  return /^https?:\/\//.test(url) ? url : window.location.origin + url
}

export function makeMapStyle(mode: MapMode, cfg: MapConfig, opts: StyleOptions): StyleSpecification {
  const seamarksOn = (opts.seamarks ?? true) && !!cfg.seamark
  const sources: Record<string, SourceSpecification> = {}
  const layers: LayerSpecification[] = []

  if (cfg.basemap) {
    sources[PMTILES_SOURCE] = {
      type: 'vector',
      url: `pmtiles://${abs(cfg.basemap)}`,
      attribution: PMTILES_ATTRIBUTION
    }
    layers.push(...brandBasemapLayers(mode))
  } else if (cfg.basemapTiles) {
    // No `attribution` here on purpose: the TileJSON carries the credit the tile
    // host requires, and setting one on the source would override and erase it.
    // MapLibre reads it from the TileJSON. The `url` indirection is load-bearing
    // too - the real tile path is build-dated and rotates, so it must never be
    // inlined as a `tiles` array.
    sources[OMT_SOURCE] = { type: 'vector', url: cfg.basemapTiles }
    layers.push(...omtLayers(OMT_SOURCE, mode === 'day' ? dayFlavor() : nightFlavor()))
  }
  if (seamarksOn && cfg.seamark) {
    sources[SEAMARK_SOURCE] = { type: 'vector', url: `pmtiles://${abs(cfg.seamark)}` }
    layers.push(...brandSeamarkLayers(mode))
  }

  // Own-ship track rides above the chart; data is injected by the engine
  // (kept inside the style so a theme setStyle() cannot orphan it).
  sources[TRACK_SOURCE] = {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  }
  layers.push({
    id: TRACK_LAYER,
    type: 'line',
    source: TRACK_SOURCE,
    layout: { 'line-cap': opts.track.dash ? 'butt' : 'round', 'line-join': 'round' },
    paint: {
      'line-color': opts.track.color,
      'line-width': opts.track.width,
      'line-opacity': 0.9,
      ...(opts.track.dash ? { 'line-dasharray': opts.track.dash } : {})
    }
  })

  return {
    version: 8,
    glyphs: abs(cfg.glyphs),
    ...(seamarksOn ? { sprite: `${abs(cfg.sprite)}/seamarks-sprites` } : {}),
    sources,
    layers
  }
}
