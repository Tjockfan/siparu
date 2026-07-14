# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin is read-only by design. No release will ever add a write path to the vessel:
`handleMessage`, PUT requests and NMEA 2000 output do not appear anywhere in this code
base, and the REST endpoints are registered GET-only.

## [Unreleased]

### Added

- Live uplink. When remote viewing is paired, the plugin holds a WebSocket open to the
  relay and sends a frame every couple of seconds, so a screen ashore shows the vessel
  manoeuvring rather than a position up to a minute old.
- The HTTP heartbeat stays and is not legacy. It takes over the moment the socket breaks,
  which is what keeps a boat reporting through a marina network that mangles WebSockets,
  and it is what leaves a last known position behind when she goes offline.

### Changed

- `ws` is now a runtime dependency, and the only one. It has no install script and its
  native peers are optional, so it survives the Signal K App Store installing with
  `npm --ignore-scripts`.

## [0.1.2] - 2026-07-14

### Added

- Remote pairing. The vessel displays a short code, the owner types it into the portal,
  and the vessel is asked to confirm on its own screen before anything is linked.
- A vessel that pairs again is recognised by presenting the credential she already holds,
  never by the identity she claims. An MMSI or a vessel URN is recorded and is not trusted:
  both are asserted by whoever is calling, and an asserted identity authorises nothing.
- Telemetry heartbeat: one frame a minute over HTTPS, overwriting the last.
- Charts wherever she sails, without hosting a tile of it.
- Seamarks: buoys, lights, anchorages and cables, planet wide.

### Fixed

- Anchorages, restricted areas and submarine cables were being dropped from the chart. A
  rule that skipped layers without a line colour took the patterned ones with it.

## [0.1.1] - 2026-07-13

### Added

- First public release. A read-only Signal K plugin with an on-board dashboard, position
  and instrument history stored as hourly NDJSON with rollups, an automatic voyage engine,
  a chart, and a GET-only REST API.

[Unreleased]: https://github.com/Tjockfan/siparu/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.2
