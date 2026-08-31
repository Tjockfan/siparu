/**
 * OpenMapTiles basemap layers, generated from a Siparu flavor.
 *
 * The hosted basemap speaks the OpenMapTiles schema; the offline PMTiles archive on
 * the boat speaks the Protomaps one. Their layers are not interchangeable, so these
 * cannot come from @protomaps/basemaps. They are built here from the same flavor
 * tokens instead, so the chart keeps its colours whichever source draws it. That
 * matters more than it sounds: the map would otherwise change appearance at the exact
 * moment the uplink dies, which is the worst possible moment to make a skipper wonder
 * whether something just broke.
 *
 * One schema difference is easy to get backwards, and inverts land and sea if you do:
 * OpenMapTiles ships WATER polygons and leaves the land to the background colour,
 * while Protomaps ships an `earth` polygon over a water background. So `background`
 * below takes the land token.
 *
 * Only what a navigator needs is drawn. No POI icons, no house numbers, no highway
 * shields, and so no sprite: a tracking chart is not a road atlas. Every label is
 * pinned to one fontstack, because the glyphs may come from the boat's own disk,
 * where only that one is guaranteed to exist.
 */
import type { Flavor } from '@protomaps/basemaps'
import type { DataDrivenPropertyValueSpecification, LayerSpecification } from 'maplibre-gl'

const FONT_REGULAR = 'Noto Sans Regular'

/** English where the tiles carry it, local name otherwise. */
const LABEL: DataDrivenPropertyValueSpecification<string> = [
  'coalesce',
  ['get', 'name:en'],
  ['get', 'name']
] as unknown as DataDrivenPropertyValueSpecification<string>

const text = (size: number[][], color: string, halo: string) => ({
  layout: {
    'text-field': LABEL,
    'text-font': [FONT_REGULAR],
    'text-size': { stops: size },
    'text-max-width': 8
  },
  paint: { 'text-color': color, 'text-halo-color': halo, 'text-halo-width': 1 }
})

export function omtLayers(source: string, f: Flavor): LayerSpecification[] {
  const src = { source, 'source-layer': '' }
  const on = (sourceLayer: string) => ({ ...src, 'source-layer': sourceLayer })

  return [
    { id: 'omt_background', type: 'background', paint: { 'background-color': f.earth } },

    // Sea, lakes and rivers. Everything the boat floats on.
    {
      id: 'omt_water',
      type: 'fill',
      ...on('water'),
      filter: ['!=', ['get', 'intermittent'], 1],
      paint: { 'fill-color': f.water }
    },

    // No `park` layer, deliberately. OpenMapTiles puts marine protected areas in it,
    // and a park fill is a land colour, so it paints big polygons of "land" across open
    // water the boat is floating on. A chart that draws sea as shore is worse than a
    // chart that leaves a national park out.
    { id: 'omt_glacier', type: 'fill', ...on('landcover'), filter: ['==', ['get', 'class'], 'ice'], paint: { 'fill-color': f.glacier } },
    { id: 'omt_sand', type: 'fill', ...on('landcover'), filter: ['==', ['get', 'class'], 'sand'], paint: { 'fill-color': f.sand } },
    { id: 'omt_wood', type: 'fill', ...on('landcover'), filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass']]], paint: { 'fill-color': f.wood_a } },
    { id: 'omt_residential', type: 'fill', ...on('landuse'), filter: ['==', ['get', 'class'], 'residential'], paint: { 'fill-color': f.scrub_a } },

    {
      id: 'omt_building',
      type: 'fill',
      ...on('building'),
      minzoom: 13,
      paint: { 'fill-color': f.buildings }
    },

    {
      id: 'omt_waterway',
      type: 'line',
      ...on('waterway'),
      filter: ['!=', ['get', 'intermittent'], 1],
      paint: { 'line-color': f.water, 'line-width': { stops: [[8, 0.5], [14, 2]] } }
    },

    // Runways are coastal landmarks worth keeping; taxiways and aprons are not.
    {
      id: 'omt_runway',
      type: 'line',
      ...on('aeroway'),
      filter: ['==', ['get', 'class'], 'runway'],
      paint: { 'line-color': f.runway, 'line-width': { stops: [[11, 1], [14, 4]] } }
    },

    {
      id: 'omt_road_minor',
      type: 'line',
      ...on('transportation'),
      minzoom: 11,
      filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'track', 'path']]],
      paint: { 'line-color': f.minor_a, 'line-width': { stops: [[12, 0.4], [14, 1.5]] } }
    },
    {
      id: 'omt_road_secondary',
      type: 'line',
      ...on('transportation'),
      filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]],
      paint: { 'line-color': f.other, 'line-width': { stops: [[9, 0.5], [14, 2.5]] } }
    },
    {
      id: 'omt_road_primary',
      type: 'line',
      ...on('transportation'),
      filter: ['in', ['get', 'class'], ['literal', ['primary', 'trunk']]],
      paint: { 'line-color': f.major, 'line-width': { stops: [[7, 0.6], [14, 3]] } }
    },
    {
      id: 'omt_road_motorway',
      type: 'line',
      ...on('transportation'),
      filter: ['==', ['get', 'class'], 'motorway'],
      paint: { 'line-color': f.highway, 'line-width': { stops: [[6, 0.7], [14, 3.5]] } }
    },
    {
      id: 'omt_rail',
      type: 'line',
      ...on('transportation'),
      minzoom: 10,
      filter: ['==', ['get', 'class'], 'rail'],
      paint: { 'line-color': f.railway, 'line-width': { stops: [[10, 0.4], [14, 1.2]] } }
    },

    // Land borders only. Maritime boundaries are invisible lines drawn across the
    // water a boat is actually on, and they read as hazards that are not there.
    {
      id: 'omt_boundary',
      type: 'line',
      ...on('boundary'),
      filter: ['all', ['<=', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
      paint: {
        'line-color': f.boundaries,
        'line-width': { stops: [[4, 0.5], [10, 1.2]] },
        'line-dasharray': [3, 2]
      }
    },

    {
      id: 'omt_water_label',
      type: 'symbol',
      ...on('water_name'),
      ...text([[3, 10], [8, 13]], f.ocean_label, f.water)
    },
    {
      id: 'omt_road_label',
      type: 'symbol',
      ...on('transportation_name'),
      minzoom: 12,
      layout: {
        'text-field': LABEL,
        'text-font': [FONT_REGULAR],
        'text-size': { stops: [[12, 9], [15, 11]] },
        'symbol-placement': 'line',
        'text-max-angle': 30
      },
      paint: {
        'text-color': f.roads_label_major,
        'text-halo-color': f.roads_label_major_halo,
        'text-halo-width': 1
      }
    },
    {
      id: 'omt_place_village',
      type: 'symbol',
      ...on('place'),
      minzoom: 10,
      filter: ['in', ['get', 'class'], ['literal', ['village', 'hamlet', 'suburb', 'neighbourhood']]],
      ...text([[10, 10], [14, 12]], f.subplace_label, f.subplace_label_halo)
    },
    {
      id: 'omt_place_town',
      type: 'symbol',
      ...on('place'),
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
      ...text([[6, 11], [12, 15]], f.city_label, f.city_label_halo)
    },
    {
      id: 'omt_place_state',
      type: 'symbol',
      ...on('place'),
      maxzoom: 9,
      filter: ['==', ['get', 'class'], 'state'],
      ...text([[4, 10], [8, 12]], f.state_label, f.state_label_halo)
    },
    {
      id: 'omt_place_country',
      type: 'symbol',
      ...on('place'),
      maxzoom: 8,
      filter: ['==', ['get', 'class'], 'country'],
      ...text([[2, 10], [6, 14]], f.country_label, f.city_label_halo)
    }
  ] as LayerSpecification[]
}
