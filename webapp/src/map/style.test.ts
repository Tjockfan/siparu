/**
 * Style factory invariants.
 *
 * These assert properties, not pixels. The map has two tile schemas and two themes,
 * and the ways it fails are quiet ones: a layer pointing at a source that is not in
 * the style renders nothing and says nothing; a missing font drops every label; an
 * attribution set on the wrong source erases a credit we are required to show. None
 * of that throws, so none of it would be caught by simply building a style.
 */
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { describe, expect, it } from 'vitest'
import type { MapConfig } from '../lib/api'
import { basemapSourceId, makeMapStyle, MAP_ATTRIBUTION, TRACK_LAYER, TRACK_SOURCE, type MapMode } from './style'

// abs() turns the boat's server-relative asset URLs absolute, which needs an origin.
// This runs before the suites below, which build their styles while vitest is still
// collecting them, i.e. earlier than any hook would fire.
if (typeof globalThis.window === 'undefined') {
  ;(globalThis as { window?: unknown }).window = { location: { origin: 'http://boat.local' } }
}

const HOSTED: MapConfig = {
  basemap: null,
  basemapTiles: 'https://tiles.example.org/planet',
  seamark: 'https://assets.example.org/seamark.pmtiles',
  glyphs: 'https://assets.example.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://assets.example.org/sprites',
  local: { basemap: false, seamark: false, fonts: false, sprites: false }
}

const OFFLINE: MapConfig = {
  basemap: '/plugins/siparu/charts/basemap.pmtiles',
  basemapTiles: null,
  seamark: '/plugins/siparu/charts/seamark.pmtiles',
  glyphs: '/plugins/siparu/charts/fonts/{fontstack}/{range}.pbf',
  sprite: '/plugins/siparu/charts/sprites',
  local: { basemap: true, seamark: true, fonts: true, sprites: true }
}

const NONE: MapConfig = {
  basemap: null,
  basemapTiles: null,
  seamark: null,
  glyphs: '',
  sprite: '',
  local: { basemap: false, seamark: false, fonts: false, sprites: false }
}

/** What tiles.siparu.app and the charts folder actually ship. Bold is not among them. */
const SERVED_FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic']

/** Every font name a text-font holds, whether it is a plain stack or an expression. */
function fontNames(spec: unknown): string[] {
  return [...JSON.stringify(spec).matchAll(/"(Noto [^"]+)"/g)].map((m) => m[1])
}

const TRACK = { track: { color: '#e5484d', width: 3 } }
const MODES: MapMode[] = ['night', 'day']
const SCHEMAS: [string, MapConfig][] = [
  ['hosted', HOSTED],
  ['offline', OFFLINE]
]

describe('makeMapStyle', () => {
  for (const [schema, cfg] of SCHEMAS) {
    for (const mode of MODES) {
      describe(`${schema} / ${mode}`, () => {
        const style = makeMapStyle(mode, cfg, TRACK)

        it('is a valid MapLibre style', () => {
          expect(validateStyleMin(style as never)).toEqual([])
        })

        it('every layer points at a source the style declares', () => {
          const known = new Set(Object.keys(style.sources))
          for (const l of style.layers) {
            if (l.type === 'background') continue
            expect(known, `layer ${l.id}`).toContain((l as { source: string }).source)
          }
        })

        // The style ships one sprite, the seamark sheet. A basemap layer asking for an
        // icon or a fill pattern would look for it there, not find it, and log an error
        // on every frame while its polygons render as holes.
        it('no basemap layer depends on a sprite', () => {
          for (const l of style.layers) {
            if (l.id.startsWith('sm_')) continue
            const keys = [...Object.keys(l.layout ?? {}), ...Object.keys(l.paint ?? {})]
            for (const k of keys) {
              expect(k, `layer ${l.id}`).not.toBe('icon-image')
              expect(k.endsWith('-pattern'), `layer ${l.id} has ${k}`).toBe(false)
            }
          }
        })

        // Glyphs come from the asset server, or from the boat's own disk, and both carry
        // the same three fontstacks. Asking for a fourth (Bold is the tempting one, and
        // it is a 404) does not throw: MapLibre just drops every label in that layer.
        // text-font may be an expression, so the names are dug out rather than read off.
        it('every label asks for a fontstack that is actually served', () => {
          for (const l of style.layers) {
            const font = (l.layout as { 'text-font'?: unknown } | undefined)?.['text-font']
            if (!font) continue
            for (const f of fontNames(font)) expect(SERVED_FONTS, `layer ${l.id}`).toContain(f)
          }
        })

        it('carries the track source and layer', () => {
          expect(style.sources[TRACK_SOURCE]).toBeDefined()
          expect(style.layers.some((l) => l.id === TRACK_LAYER)).toBe(true)
        })
      })
    }
  }

  // A theme switch rebuilds the style. If the track lived outside it, that switch would
  // drop the boat's track on the floor. It has to survive even with no chart at all.
  it('keeps the track even when there is no chart to draw it on', () => {
    for (const mode of MODES) {
      const style = makeMapStyle(mode, NONE, TRACK)
      expect(style.sources[TRACK_SOURCE], mode).toBeDefined()
      expect(style.layers.some((l) => l.id === TRACK_LAYER)).toBe(true)
      expect(basemapSourceId(NONE)).toBeNull()
    }
  })

  describe('attribution', () => {
    // The tile host states its own credit in the TileJSON and MapLibre renders it.
    // Setting one on the source overrides it, so the credit we owe would vanish.
    it('lets the hosted basemap speak for itself', () => {
      const src = makeMapStyle('night', HOSTED, TRACK).sources.openmaptiles
      expect(src).toMatchObject({ type: 'vector', url: HOSTED.basemapTiles })
      expect(src).not.toHaveProperty('attribution')
    })

    // The offline archive has no TileJSON, so nothing else can declare its credit.
    it('credits OpenStreetMap for the offline archive', () => {
      const src = makeMapStyle('night', OFFLINE, TRACK).sources.protomaps as { attribution?: string }
      expect(src.attribution).toContain('OpenStreetMap')
    })

    it('states the product stance separately from any data credit', () => {
      expect(MAP_ATTRIBUTION).toBe('Not for navigation')
    })
  })

  describe('sprite', () => {
    it('is present only when seamarks are drawn, and is ours', () => {
      const withSeamarks = makeMapStyle('night', HOSTED, TRACK)
      expect(withSeamarks.sprite).toBe('https://assets.example.org/sprites/seamarks-sprites')

      const without = makeMapStyle('night', HOSTED, { ...TRACK, seamarks: false })
      expect(without.sprite).toBeUndefined()
      expect(without.sources.seamark).toBeUndefined()
    })
  })

  // Found on the water, not in a test: OpenMapTiles files marine protected areas under
  // `park`, and a park fill is a land colour, so the chart painted slabs of "shore"
  // across the sea off Sardinia. Drawing water as land is the one thing this product
  // must never do, whatever it costs in scenery.
  it('never fills a land colour from a source layer that also covers the sea', () => {
    const layers = makeMapStyle('night', HOSTED, TRACK).layers
    const sourceLayers = layers
      .filter((l) => l.type === 'fill')
      .map((l) => (l as { 'source-layer'?: string })['source-layer'])
    expect(sourceLayers).not.toContain('park')
  })

  // Also found on the water. MapLibre defaults a colourless fill or line to black, and
  // the vendored seamark style has several, so the chart drew black slabs on open water
  // once the seamark archive went planet-wide. Every shape must state its own colour.
  it('draws no shape whose colour it has not decided', () => {
    for (const mode of MODES) {
      for (const l of makeMapStyle(mode, HOSTED, TRACK).layers) {
        const paint = (l.paint ?? {}) as Record<string, unknown>
        if (l.type === 'fill') expect(paint, `layer ${l.id}`).toHaveProperty('fill-color')
        if (l.type === 'line') expect(paint, `layer ${l.id}`).toHaveProperty('line-color')
      }
    }
  })

  describe('basemapSourceId', () => {
    // The engine watches tile errors by source id. A wrong answer here means the
    // "chart unreachable" note never fires and an offline boat gets blank water.
    it('names the source that actually carries the basemap', () => {
      expect(basemapSourceId(HOSTED)).toBe('openmaptiles')
      expect(basemapSourceId(OFFLINE)).toBe('protomaps')
      expect(basemapSourceId(NONE)).toBeNull()
    })
  })

  // A layer list is a design decision. Changing it should be a reviewable diff, not a
  // side effect of bumping a dependency.
  describe('layer inventory', () => {
    it('hosted', () => {
      expect(makeMapStyle('night', HOSTED, TRACK).layers.map((l) => l.id)).toMatchSnapshot()
    })
    it('offline', () => {
      expect(makeMapStyle('night', OFFLINE, TRACK).layers.map((l) => l.id)).toMatchSnapshot()
    })
  })
})
