# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin is read-only by design. No release will ever add a write path to the vessel:
`handleMessage`, PUT requests and NMEA 2000 output do not appear anywhere in this code
base, and the REST endpoints are registered GET-only.

## [Unreleased]

## [0.1.7] - 2026-07-17

Nothing in this release changes what a boat does or what her screen shows. It exists so
that the next one can.

### Added

- `units.ts`: the rules that decide which panel a Signal K path belongs under, what its
  cell is called, and what unit it reads in. An engine reports in SI because the standard
  says so, and a person reads bar, rpm, degrees and litres per hour. Something has to
  convert, and until now the only thing that did lived on a screen outside this package.
  The plugin's own dashboard has no gauge panel yet; when it grows one, it reads these,
  rather than growing a second opinion about what 423634 Pa means.
- `CORE_SERIES_PATHS` and `CORE_SERIES`: the two navigation gauges a boat rolls up a
  history for, declared in one place and described in one table keyed off that
  declaration. Adding a path without describing it, or describing one without adding it,
  now fails the build. This replaces a paragraph in `query.ts` that asked whoever came
  next to remember two tables in another code base, which is not a thing a paragraph can
  enforce and did not.

### Known

Two readings this package now owns are wrong, and both are pinned by a test that says so
rather than quietly passing:

- Signal K documents eleven propulsion paths in kelvin or pascals. Six of them are not
  recognised, because the metric table matches a path's last segment exactly and claims
  only `temperature`: a coolant loop at 82 C prints `355.1`, with no unit, beside a label
  that reads Coolant temperature. The same is true of `exhaustTemperature`,
  `oilTemperature`, `coolantPressure`, `boostPressure` and `intakeManifoldTemperature`.
- A true wind of exactly 1.00 kn reads as a flat calm. `beaufortFromKn` divides by the
  knot factor and `beaufort` multiplies it straight back, and the round trip lands at
  0.9999999999999999, a hair under force 1. Measured across nine million knot values from
  0 to 90, it is the only input affected.

Both are older than this release and neither is fixed here on purpose: this file has to be
provably identical to the copy it was moved from before that copy can be deleted, and
being able to delete it is the point.

## [0.1.6] - 2026-07-16

### Fixed

- The logbook's times were the reader's own clock under a column that said UTC.
  Two hours out in Norway, an hour in Britain, and nothing on screen to give it
  away: the header says UTC, the number looks plausible, and the rows agree with
  each other. At sea a log time is UTC, so an event read off this screen and
  reported to anyone was reported at the wrong time. The rows themselves were
  always right and are unchanged; only what the screen said about them was wrong.
  The day window was local too, which quietly made the two daylight-saving days
  23 and 25 hours long; a UTC day is always 24.
- Pairing had no timeout. A marina wifi that accepts the connection and then
  swallows it left the boat waiting eight minutes with a spinner at the helm and
  nothing said. It now gives up after twenty seconds and says what it already knew
  how to say: "Cannot reach Siparu. Is the boat online?" The worst case was the
  confirm step, where the boat is already paired when the reply hangs, so the
  skipper reads failure and starts again on a boat that is in fact linked.
- The 0.1.3 entry claimed the engine, tank and generator gauges were "surfaced on
  the dashboard". They are recorded and served over the API; they have no screen
  of their own on the boat yet. The entry now says so.

## [0.1.5] - 2026-07-16

### Fixed

- The privacy section described a smaller product than the one that shipped. It
  promised "its current position and name, and nothing else" and that "the history
  never leaves"; in fact a paired boat sends her whole bridge every couple of
  seconds, including the engine, tank and generator gauges added in 0.1.3, and a
  paired screen may ask her for one gauge's recorded history. Nothing was leaving
  that should not have been. The description was wrong, which is its own fault:
  anyone who read it and decided to pair decided on bad information. It now lists
  what actually goes, what the shore may ask, and what the relay keeps.
- "Zero runtime dependencies" was no longer true - `ws` has been one since 0.1.3 -
  and the dashboard was called a PWA although it has no service worker. Both
  claims are corrected rather than quietly kept.

### Added

- The helm says so when Signal K security is off. In that state, which is Signal K's
  default, the pairing endpoints answer anyone who can reach the boat's network, and
  a stranger can link her to their own account while the owner's screen still reads
  "paired". `/pair/status` reports `security_off` and the dashboard shows it above
  every pairing state.

  It warns rather than refuses on purpose: refusing would stop the owner and not the
  intruder, who on an unsecured server can read the token from the plugin's own
  config in one request. Turn on Signal K security before pairing - the README says
  how, and it is worth the minute.

## [0.1.4] - 2026-07-16

### Fixed

- A silent instrument no longer writes its last reading into history wearing a fresh
  timestamp. Every field is now gated on the age of its own source when a row is
  recorded, so an instrument that stops reporting leaves a gap rather than a
  measurement nobody took. This matters most where it is least visible: a GPS that
  went quiet mid-passage kept logging speed, inflating hours underway and holding a
  voyage open indefinitely. Existing history is not rewritten.
- The dashboard read "FIX 0s" whenever the boat was reachable, because it aged the
  frame rather than the fix. It now ages the position itself, so a frozen instrument
  reads as stale, and a boat that has never had a position is no longer called fixed.

### Added

- Live values carry the age of each reading (`field_ages` on the live frame), so a
  single frozen gauge can be told apart from a boat whose instruments are all fine.
  The boat-wide data age cannot see one instrument go quiet while the others report.

### Changed

- Displayed values are unchanged: the screen still shows the last known reading, which
  is what a screen is for. Only the recorded history and the freshness a reading claims
  have changed.
- A voyage whose GPS reports zero speed briefly and then goes silent now stays open,
  where the stale zero used to close it. Hours underway are correct either way; an open
  voyage says the arrival is unknown rather than inventing one.
- The on-board dashboard wears the same mark as the portal, sized off one number per
  surface so a boat's screen and her owner's screen cannot drift apart.

## [0.1.3] - 2026-07-15

### Added

- Engine, tank and generator gauges. A boat's own `propulsion`, `tanks` and
  `electrical.generators` paths are discovered, recorded, and served over the API
  (`GET /live`, `GET /inventory`); no boat is asked to configure which ones it has.
  They have no screen of their own on the boat's dashboard yet.
- Each gauge carries its age, and its history is recorded and rolled up on the boat, so
  a reading can be graphed over time and a stale one can be told apart from a live one.
- A paired screen ashore may ask the boat for one gauge's recorded history. It is the
  only thing the shore may ask, and it is not a command: the boat answers from her own
  store and takes no instruction.
- Wind and barometer graphs, drawn from the boat's own history.
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

[Unreleased]: https://github.com/Tjockfan/siparu/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.7
[0.1.6]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.6
[0.1.5]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.5
[0.1.4]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.4
[0.1.3]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.3
[0.1.2]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.2
