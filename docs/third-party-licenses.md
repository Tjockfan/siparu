# Third-party licenses - map stack

Third-party components used in Siparu's map stack, and their licence obligations.

## Code (npm, shipped in the webapp bundle)

| Package | Licence | Role |
|---|---|---|
| maplibre-gl | BSD-3-Clause | Render engine |
| pmtiles | BSD-3-Clause | PMTiles protocol client |
| @protomaps/basemaps | BSD-3-Clause | Basemap style generator |

## Vendored (copied into the repo)

| Source | Licence | Files |
|---|---|---|
| [josxha/vector-seamarks](https://github.com/josxha/vector-seamarks) | BSD-2-Clause | `webapp/src/map/seamarks-layers.json` (adapted style layers) and the seamark sprite sheets (served under `sprites/` on the tile host) |

Per BSD-2, redistribution keeps the copyright notice and licence text. The full
licence text is carried in the `NOTICE` file.

## Data and assets (served from the tile host, not bundled)

| Asset | Licence | Obligation |
|---|---|---|
| OpenStreetMap data (basemap + seamark PMTiles) | ODbL 1.0 | Visible "© OpenStreetMap contributors" attribution - shown on every map surface via `MAP_ATTRIBUTION` |
| Protomaps daily planet build | ODbL "Produced Work" | OSM attribution suffices |
| Noto Sans glyphs ([protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets)) | SIL OFL 1.1 | Free to serve as a font; not sold on its own |

## Not for navigation

Siparu uses no official hydrographic (ENC/HO) data - it is a monitoring tool, not a
navigation system. Every map surface carries a fixed "Not for navigation" note in its
attribution line.
