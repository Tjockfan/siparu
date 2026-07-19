# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin is read-only by design. No release will ever add a write path to the vessel:
`handleMessage`, PUT requests and NMEA 2000 output do not appear anywhere in this code base.
The REST endpoints are GET-only but for the four pairing routes, which move this plugin's own
state when somebody taps approve at the helm and send nothing to the boat. CI proves both on
every commit, and a fifth write route fails the build.

## [Unreleased]

## [0.1.23] - 2026-07-19

### Added

- A track read over the live socket. A shore screen asks for one voyage by id and the
  boat answers with its recorded path, oldest fix first. A long track is decimated at an
  even stride before it crosses the wire, keeping the first and last fix, so a day under
  way at roughly 1 Hz still fits a single reply; the local track REST is left untouched
  and serves every fix. Read-only like its three siblings, and served from the same store.

## [0.1.20] - 2026-07-19

### Fixed

- A boat can be paired again after her token was revoked from the portal. When
  an owner unpairs her from ashore, the relay revokes her token but cannot reach
  the plugin to clear the copy on her disk; "Pair again" then presented that dead
  token, the relay opened a fresh boat, and the plugin refused the different id
  as a hijack, stranding her at a button that could not work. The hijack guard
  now defends only a live link: a token the relay has already refused protects
  nothing, so re-pairing adopts the new boat. Turning off first is no longer
  needed to recover.

## [0.1.19] - 2026-07-19

### Security

- The relay token is no longer kept in the plugin's options, where Signal K
  serves it over `GET /plugins/<id>/config` to anyone on the boat's network when
  security is off. It lives in a `0600` file under the plugin's data directory,
  which no route serves. A boat paired under an older build is migrated at start.
- "Turn off remote viewing" while the relay is unreachable no longer drops the
  only token that can revoke itself. The disowned token is kept and retried until
  the relay confirms it dead, and the on-board screen says so meanwhile.

### Added

- Per-field caps at ingest, mirroring the relay's telemetry sanitiser: string
  values are truncated, dynamic path names must fit the Signal K grammar, and the
  number of dynamic paths is bounded.

### Changed

- The live socket's frame cadence now follows the boat's speed: every ten
  seconds under way, once a minute at rest, instead of a fixed two seconds.
  Two seconds sounds attentive until the bill arrives - one boat alone was
  burning 43,000 relay invocations a day, most of them repeating that she had
  not moved. A moored boat now says so once a minute, and a day of streaming
  fits comfortably inside the relay's request budget.
- `seasonStart` is validated against the calendar, so a typo like `99-99` falls
  back to the default instead of silently emptying the season statistics; the
  admin form carries the same pattern. Named-port coordinates must sit on the
  globe. The relay URL falls back to the default unless it is `https`, so the
  boat token never rides plain http.

## [0.1.18] - 2026-07-18

### Fixed

- A boat that reports only an engine, and no position, wind or depth, no longer shows an empty
  bridge above its systems on the board. The bridge is now a section on the same footing as the
  others: drawn when she reports any nav or environment reading and absent when she does not, so it
  cannot claim she is alongside with the instruments off while her engine is plainly turning. It
  stays as the sole section only when she reports nothing at all, so the screen can still name why
  rather than going blank.

## [0.1.17] - 2026-07-18

### Changed

- The wide instrument screen is now one board rather than two panels to pick between. It shows
  everything she reports at once: a scrolling column of sections (the bridge, then each engine,
  generator and tank group she carries) beside a fixed chart pane. The sections are the panels she
  justifies, in her own order, so a boat with no generator has no generator section and there is
  no list of them to keep. The cells are dense and equal here, many readings at a glance, where the
  single bridge screen draws a few large ones. The phone is unchanged: one panel with a tab row.
  The old two-up split and its URL pair are gone.

### Fixed

- On the board the position readout no longer wraps its hemisphere letter onto a second line; the
  coordinate holds one line beside its label.

## [0.1.16] - 2026-07-18

### Added

- A desktop layout. On a wide screen the top header and the bottom tab bar give way to a left
  rail that carries the brand, the four destinations, the live state, the boat-local clock and the
  theme toggle, and the content fills the rest; a full-width bottom bar would otherwise stretch
  each tab to a quarter of the viewport. Below the breakpoint the phone keeps its header and bottom
  bar untouched, and the rail is not mounted at all, so the two chromes never stack.

## [0.1.15] - 2026-07-18

### Fixed

- A voyage's fuel was always empty. The integrator reads the engine rate off each snapshot's
  dynamic values, but the two places that hand snapshots to it, the live feed window and the disk
  re-read, both rebuilt each row from a fixed set of fields and dropped those values on the way. So
  the rate never arrived and every voyage reported no fuel, on a boat that was in fact reporting it.
  Both projections now carry the dynamic values through, and the live-path equivalence tests assert
  the integrated litres so a future projection cannot quietly drop them again.

## [0.1.14] - 2026-07-18

### Added

- A voyage now carries the fuel it burned. The engines report their own rate over the bus, and
  the voyage engine integrates it across the same segments it already uses for distance, so the
  figure is litres actually burned rather than a guess from a boat model or a curve. Twin engines
  are summed, and an engine idling at anchor still counts, because it is still burning. A boat
  whose engines report no rate shows no fuel at all rather than a fabricated number.
- The expanded voyage detail reads that fuel back in whatever frame the owner picks: a total in
  litres or US or Imperial gallons, litres per mile or miles per litre, or the average litres per
  hour. Each frame is named in full so no single number ever stands for two quantities, and the
  choice is remembered between sessions.

## [0.1.13] - 2026-07-17

### Added

- A wide screen carries two instrument panels at once. The dashboard is a panel now, and on a
  tablet held landscape or a laptop it splits into two: the bridge and one system side by side,
  each with its own tab row, so an owner can watch the engine and the wind without switching
  between them. The pair is a URL parameter (`?a=bridge&b=engine`), which means it survives a
  reload and can be copied from one screen to another. Below the split width there is one panel
  and the second choice waits in the address, so turning the tablet upright and back brings the
  pair back rather than losing it. Each panel reads its column count from its own width, not the
  window's, so a half-width panel lays out like the narrow screen it is the size of. A choice
  that no longer resolves, an engine that stopped reporting this session, collapses its panel
  rather than showing a second bridge in its place.

### Changed

- The engine, generator and tank panels fill the height they are given the way the bridge does.
  A system with a handful of gauges used to pack them at the top of the panel and leave a slab
  of dark beneath; now the rows stretch to take the space and the reading sits centred in its
  cell. A system reporting a single gauge gets a single tall cell, which is the honest shape of
  one reading rather than a screen that broke.

## [0.1.12] - 2026-07-17

### Fixed

- A tank's volume is read in litres. `capacity` and `currentVolume` arrive in cubic metres, so a
  473 litre tank printed "0.5", which is not a rounding error so much as a different tank, and
  `pressure` arrives in pascals and printed "350000". Twenty-seven path shapes, three metrics
  across each of the nine tank families the standard publishes. 0.1.11 put this table on the
  boat's own screen, so unlike the corrections before it this one is reachable aboard rather
  than only from ashore, and it was checked in the built bundle rather than assumed.

  No boat here reports any of them, which is the point: every tank on this vessel reports only
  its level, and a level already read correctly. The table is built from the standard rather
  than from the one engine room we can see.

  The three are keyed to tanks rather than to their own segments, which for `pressure` is
  obvious (every published pressure is pascals, but two of the thirteen are the barometer, and a
  barometer is read in hectopascals) and for the volumes is not. Both volume words look safe to
  claim outright. Measuring every path the standard publishes said otherwise: a bare `capacity`
  reads the battery container the standard gives no units at all, and dresses it in litres.
  Nothing could have drawn it. It would still have been this package saying a battery holds 473
  litres.

### Changed

- Three screens on board worked out how long ago something happened three different ways, and
  the arithmetic is now shared while the wording is not. A chart popup, a pairing band and a
  quiet gauge each keep the voice they were written in. Two of the three read the same as they
  did across every second of two hundred days.

  The pairing band changes, and only where it is read: it counts a first minute now. The line
  reports a frame that is refreshed every two seconds over the socket, or every sixty by the
  POST that stands in for it, so its whole domain is the first minute or so. It used to round,
  and so it went from "89s ago" straight to "2 min ago" without ever saying one minute, which
  against a sixty second interval put "2 min" on a boat that was still on schedule. Now "1 min"
  is a little late and "2 min" is a frame she missed.

## [0.1.11] - 2026-07-17

The gauges this plugin has recorded since 0.1.3 are on the boat's own screen. Until now the only
screen that drew them was one you open from ashore, which is a strange place for it to be the
only place, and it is what issue #1 asked for.

### Added

- Engine, generator and tank panels on the on-board dashboard, built from the paths on the live
  frame. Nothing counts anything: a boat with three engines gets three sets of readings, a boat
  with nine tanks gets nine cells, and a boat that reports neither never sees a tab strip at
  all. A tank fitted next winter gets a cell without a release from us, because there is no list
  of her equipment here to fall out of date.
- A gauge quiet for ninety seconds fades and says how long it has been, keeping its last
  reading. A cold engine at anchor is the normal case rather than a fault, and a cell that
  vanishes is indistinguishable from an instrument that was never fitted.

### Changed

- The bottom bar's first tab reads Instruments rather than Telemetry. It was named for what it
  carried when it carried four readings. Not Dashboard, which is what this README and this
  package call the whole app: a tab of that name would sit inside itself, next to the logbook it
  contains. The other three tabs are a logbook, a voyage and a map, and this one is her
  instruments.
- The unit table this package has published since 0.1.7 reaches a boat for the first time in
  this release. Nothing on board called it before, so it was tree-shaken out of the bundle she
  serves, and the corrections in 0.1.8 (five temperatures left as raw kelvin, two pressures as
  raw pascals, three ratios) only ever landed on a screen ashore. They now land on both, from
  one table.
- The header of `units.ts` said the boat's dashboard had no gauge panel and that this file's
  readings "fall out of her bundle entirely", and told whoever built that panel to delete the
  paragraph. This release builds it. The paragraph is gone, and the build says so: the table is
  in the chunk she serves.

### Removed

- A second unit table in the webapp, unused by anything and reading a pascal as hectopascals
  where the table this package publishes reads bar. It had no callers, so it broke nothing. It
  was waiting for the next person to open that file and believe it.

## [0.1.10] - 2026-07-17

### Fixed

- The 0.1.8 entry described a boat's screen doing things it has never been able to do. It said
  five temperatures "were shown" as raw kelvin, that a coolant loop "read 355.1", and that a
  wind of exactly 1.00 kn "read as a flat calm". None of that happened on a boat. The on-board
  dashboard has no gauge panel, so nothing aboard calls the table those readings come from and
  it is not in the bundle the boat serves at all. The screen that showed them is one that
  depends on this package for its units, and it showed them until it bumped the version it
  pins. The entry now says which. The bullet about a NaN reading as a hurricane was worse than
  imprecise: it was filed under Fixed, and nothing was broken. Splitting the ladder out would
  have introduced it, and the same change that could have prevented the guard from being there
  put one on each door. It is now filed as what it is.

  This is the third time a release of this package has claimed a screen showed something it did
  not: 0.1.5 said the gauges were "surfaced on the dashboard", 0.1.6 shipped to correct it and
  reintroduced the same claim in the commit that was correcting it, and 0.1.8 wrote it again.
  The fault is the same each time: describing a defect in a table by the reading a person would
  have seen, without checking whether anyone could see it.
- The 0.1.7 entry counted eleven propulsion paths and then said six of them were unrecognised,
  switching from paths to distinct last segments mid-sentence. As paths it was seven: an
  engine's `oilTemperature` and a transmission's are two paths and one segment. It now counts
  paths throughout, and the 0.1.8 entry names the fifth temperature it was short of.
- The header of `units.ts` still said the boat's screen had no copy of this table and instructed
  its own deletion at the moment the second copy went. The second copy went in 0.1.8 and the
  paragraph stayed, contradicting that release's own notes. It now says where this actually
  stands, including the part that is not solved: the copies are gone, but the shore reads a
  pinned version, so the drift moved from a comment asking two files to agree to a version
  number asking a person to remember.

## [0.1.9] - 2026-07-17

### Fixed

- Grey water was labelled "Waste water". Signal K's path is `wasteWater` and its own description
  reads "Waste water tank (grey water)", so the schema itself concedes the path name is not the
  word. On board it is worse than a mismatch: black water is waste too, so a gauge labelled Waste
  water asks a question instead of answering one, and a tank is a thing somebody pumps out at a
  particular hour in a particular marina. It reads Grey water now. Every other family the schema
  publishes (fresh water, black water, fuel, lubrication, live well, bait well, gas, ballast)
  already read correctly from their own path and are untouched.
- A hand-named tank read its id raw: `tanks.fuel.portForward` came out "Fuel portForward". Named
  ids are camelCase like every other Signal K segment and are now read like one, "Fuel port
  forward". Instance numbers off the bus are unaffected and still read "Fuel 0".

## [0.1.8] - 2026-07-17

The gauge table this package publishes had readings wrong in it. Nothing on a boat showed them:
the on-board dashboard has no gauge panel, so nothing here calls the table and it is not even
in the bundle the boat serves. The screens affected are the ones that depend on this package
for their units, and each gets the fix when it bumps the version it pins.

*(These four bullets were rewritten in 0.1.10. As first published they said "were shown" and
"read as a flat calm", which described a boat's screen doing something it has never been able
to do. See the 0.1.10 entry.)*

### Fixed

- Five of the six temperatures Signal K publishes for an engine were unrecognised and left as
  raw kelvin with no unit. The table matches a path's last segment exactly and claimed only
  `temperature`, so `coolantTemperature`, `oilTemperature`, `intakeManifoldTemperature`,
  `exhaustTemperature` and a transmission's `oilTemperature` all fell through: a caller reading
  a coolant loop at 82 C got `355.1` to put under a label saying Coolant temperature.
  `coolantPressure` and `boostPressure` did the same, giving pascals where an engine gauge reads
  bar. The list is now taken from the schema rather than from the paths one boat happens to
  report, which is why it hid: the boat this was written against sends the short name.
- Engine load and torque, and a drive's trim, are fractions of one that the schema documents as
  percentages. They came out `0.7` rather than `72%`.
- `beaufortFromKn` returned force 0 for exactly 1.00 kn. It divided by the knot factor so the
  ladder could multiply it straight back, and the round trip landed at 0.9999999999999999, a
  hair under force 1. The ladder now reads knots, the unit Beaufort is defined in. Reachable
  only from a caller holding a rounded figure, such as a document's table: no wind in metres per
  second converts to exactly 1.00 kn, because no double multiplied by 1.94384 lands there.

### Prevented, rather than fixed

Splitting the ladder out would have let a missing reading come out as a hurricane, and it is
listed because the trap is worth knowing rather than because anything fell into it. `typeof NaN`
is `"number"` and every comparison against NaN is false, so a NaN reaching the ladder falls off
the end of it and returns force 12. Both doors were guarded before, one of them by accident:
the knots door reached the thresholds through the metres-per-second door, which checked. Each
guards itself now, in the same change that took the shared guard away.

### Changed

- The boat's own screen no longer keeps its own copy of the Beaufort scale, the anchor-swing
  speed threshold or the knot factor. It reads the same `units.ts` the shore does. They agreed
  to the character, and there was nothing but distance keeping them that way.

### Not fixed, and deliberately

`transmission.gearRatio` carries the same `ratio` unit as engine load and is not a percentage:
the schema calls it "engine rotations per propeller shaft rotation", so a 2.5:1 gearbox is 2.5.
It reads as a plain number, which is correct. It is the reason the ratios above are listed one
by one rather than covered by a rule saying ratio means percent.

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

*(Both were fixed in 0.1.8. Kept as written, because a changelog is a record of what was
believed at the time, and this was true when it shipped.)*

Two readings this package now owns are wrong, and both are pinned by a test that says so
rather than quietly passing:

- Signal K documents eleven propulsion paths in kelvin or pascals. Seven of them are not
  recognised, because the metric table matches a path's last segment exactly and claims
  only `temperature`: a coolant loop at 82 C prints `355.1`, with no unit, beside a label
  that reads Coolant temperature. The same is true of `exhaustTemperature`,
  `oilTemperature` (twice: an engine's and a transmission's), `coolantPressure`,
  `boostPressure` and `intakeManifoldTemperature`.
- `beaufortFromKn` returns force 0 for exactly 1.00 kn. It divides by the knot factor and
  `beaufort` multiplies it straight back, and the round trip lands at 0.9999999999999999,
  a hair under force 1. Measured across nine million knot values from 0 to 90, it is the
  only input affected.

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

[Unreleased]: https://github.com/Tjockfan/siparu/compare/v0.1.20...HEAD
[0.1.20]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.20
[0.1.19]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.19
[0.1.18]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.18
[0.1.17]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.17
[0.1.16]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.16
[0.1.15]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.15
[0.1.14]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.14
[0.1.13]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.13
[0.1.12]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.12
[0.1.11]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.11
[0.1.10]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.10
[0.1.9]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.9
[0.1.8]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.8
[0.1.7]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.7
[0.1.6]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.6
[0.1.5]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.5
[0.1.4]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.4
[0.1.3]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.3
[0.1.2]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.2
