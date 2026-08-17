# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin is read-only by design. No release will ever add a write path to the vessel:
`handleMessage`, PUT requests and NMEA 2000 output do not appear anywhere in this code base.
The REST endpoints are GET-only but for seven, which move this plugin's own state and send
nothing to the boat: four for pairing (a tap at the helm), one for the fuel source (which
engine feeds voyage fuel) and two for correcting a passage the detector split or joined
wrongly. CI proves both on every commit, and an eighth write route fails the build.

## [Unreleased]

### Fixed

- **The attribution notices now travel with the package.** `NOTICE` carries the terms the
  third-party map components are redistributed under, and npm does not add that file to a
  tarball on its own the way it adds `LICENSE` and the README. For every release until this
  one the file sat in the repository and reached nobody who installed the plugin. CI now
  refuses a package that does not carry it.

## [0.2.9] - 2026-08-16

### Changed

- **Releases are published by CI, and carry a provenance attestation.** Until now the
  upload came from a maintainer's laptop, authorised by a long-lived token in a plaintext
  file that was scoped to every package the account owns and permitted to skip two-factor
  authentication. Every vessel installs this plugin from the registry, so that file was
  the shortest path from one compromised machine to code running aboard a customer's boat.
  A tagged build now publishes over OIDC with no token in existence, and the attestation
  lets anyone verify which commit in the public repository produced the tarball. The
  clean-room scan over the published file set still gates the upload; it moved to
  `tools/`, and its pattern list reaches CI as a secret rather than as a file on one Mac.

## [0.2.8] - 2026-08-16

### Fixed

- **The description is one sentence shorter, because the registry cut the last one in half.**
  npm truncates a package description at 255 characters and 0.2.7 ran past it, so the npm page
  and the Signal K App Store both ended mid-word.

## [0.2.7] - 2026-08-16

### Fixed

- **The published description no longer claims a record the relay does not keep.** The npm
  page and the Signal K App Store entry called this "an impartial, timestamped record of
  every voyage". Nothing ashore keeps one: a frame's signature is verified in memory and
  discarded, and the only mark left is the boat's name and when she was last seen. The
  description now says what the wire actually does, which is seal the report to the devices
  you name and sign it on the way out. The comment over the relay's frame handler said the
  same untrue thing to the next developer and now says what is kept, and what is not.
- **The README said the boat reports every ten seconds. She reports every two.** The cadence
  was raised on 20 July and the README kept the old number through every release since,
  understating the data an uplink uses by five times - the one figure that matters to an
  owner on a metered Starlink or 4G plan. The fallback
  line was wrong in the other direction: when the socket cannot hold, what goes by HTTPS once
  a minute is her clock alone, not the frame.
- **The inbound table listed one message; the socket answers five.** `snapshots`, `voyages`,
  `track` and `phases` have been on the wire for months and were missing from the table.
  All five are reads of the store the plugin wrote itself, and the table now says so.
- **The golden fixture is synthetic and the README now says so.** It described ten days of
  real vessel data; the track is laid down from a seeded PRNG and no vessel's real movements
  are involved.

## [0.2.6] - 2026-08-15

### Fixed

- **The slow uplink now says the same thing the socket says.** When the live socket cannot
  hold, the boat falls back to a report over HTTPS once a minute, and that path read every
  refusal that was not a rejected token as "Relay refused the frame (403)". A membership that
  has lapsed is the one refusal an owner can do something about, and it was reaching the helm
  as a status code. It now gets the same state the socket already had, and the same sentence.

## [0.2.5] - 2026-08-15

### Added

- **The helm says when the shore is not allowed to watch her, and does not send anybody to
  the boat.** The relay refuses a boat's socket while the account behind her is not on a
  paying plan. Read as an ordinary failure that would have said "Cannot reach Siparu. Is the
  boat online?", sending a skipper to check an aerial that works perfectly; read as a rejected
  token it would have said something worse, which is to pair her again, meaning a trip to the
  vessel and the same closed gate at the end of it. The refusal now has its own state: she
  keeps her token, keeps recording, stands off for fifteen minutes rather than knocking, and
  the pairing band says remote viewing is paused and why. Nothing about the boat's own screen
  changes: on board she is free, always.

### Fixed

- **The voyage banner no longer speaks in status codes.** A failed load showed the raw error,
  so an owner looking for his passages could be told "500: Internal Server Error". The fuel
  sheet on the same screen already had the rule: the server's own sentence is what a helm
  screen shows, and the code it arrived prefixed with is not.

## [0.2.4] - 2026-08-15

### Added

- **The boat's own screen names the keys she turned away.** Her approval chain has refused
  entries since it shipped, and the only place that refusal appeared was the health JSON.
  Ashore it never could appear: the party that would have to report a key pressed onto the
  list is the party that would be reporting itself. So the page at the helm now carries the
  other half of the list she already prints, kept in three separate places because a screen
  nothing vouched for, a screen the chain could not reach, and a screen the sealer could not
  wrap to are three different problems with three different answers.
- **What this is not, in the two places the plugin is actually read.** The only disclaimer
  the product had lived on a terms page that is not published, so every surface a user reaches
  said what Siparu does and nothing about what it must not be relied on for. The README and
  the plugin's own description in the Signal K settings screen now both carry it: this is not
  a navigation system, not a chart, and not a safety or alarm system, and nothing aboard is
  steered, switched or commanded by it.

## [0.2.3] - 2026-08-15

### Removed

- **The alarm channel is gone, and with it the last write the shore could make.** The
  notification watch, the alert rule store and the rule write path have been taken out. The
  live socket now answers five reads and nothing else, and a frame carries the sealed report,
  her id and her timestamp under her signature, with no severity word and no event marker
  beside it. A test pins the wire to exactly those fields, and it was checked by mutation
  rather than trusted. An alarm you were told about and did not get is worse than one that was
  never promised: nothing here rings, and nothing here says it will.

### Security

- **With Signal K security off, the plugin's own writes refuse.** Pairing, unpairing, voyage
  edits and the fuel picker are locked until the owner either adds an admin user or ticks a
  setting saying the open network is accepted. An unsecured server let anybody on the boat's
  network reset the pairing (which kills the live token, so the relay's "not your boat" guard
  cannot fire) and then start a new one, taking the next code. The lock cannot make an
  unsecured server safe, and the setting's own description says so; what it changes is the
  default posture, from silent permission to refusal. The status route says the door is
  locked, so the screen explains the missing buttons instead of letting them fail.
- **The relay address is no longer a plugin option.** It decides who receives the boat's
  frames and whose devices she seals to, and plugin options can be written by anyone who can
  reach the server's config route on an unsecured install. It is a constant now, overridable
  only from the server process's own environment.
- **A device list from ashore is only trusted as far as the chain aboard reaches.** The boat
  used to seal to whatever list she was handed, checked by shape alone. An entry is now
  accepted only when a device she already trusts vouched for it, chained back to an anchor
  recorded on her own disk, and that anchor is written at the helm when the first screen is
  approved. The shore stores and carries approvals it can neither verify nor mint, and it does
  not get to choose which one is tried: every voucher a screen was given is attempted, because
  which one verifies depends on an anchor the carrier deliberately does not know.

### Added

- **Depth says which plane it was measured from.** The gauge resolves depth below transducer,
  below keel and below surface in priority order, and it can switch between them when a source
  goes quiet. The difference between two of those planes is the boat's own draft, which is
  exactly the margin somebody would be reading the number for. Snapshots carry the datum, and
  the cell prints it in words under the figure. A snapshot from an older plugin, with no datum
  recorded, says so rather than borrowing a plane.
- **Health names the screens a frame left out.** The sealer has always refused to wrap to an
  unusable device row and said so only in a debug line that is off by default, so a screen that
  stopped receiving looked exactly like a boat gone quiet. The refusal now survives the log
  being off, and it is served only while she is actually sealing: an unpaired boat no longer
  names screens belonging to an account she has left.

## [0.2.2] - 2026-08-08

### Security

- **The routes that change something now refuse a page in someone else's tab.** Signal K
  serves this plugin on the boat's own network, its default is security off, and it answers
  every request with `Access-Control-Allow-Origin: *` next to
  `Access-Control-Allow-Credentials: true`. Together those mean any page open in any browser
  on that network could call these routes and read the answers: unpair her, or read the
  pairing screen, take the code the helm is displaying and claim her into an account of its
  own. An advert frame was enough, and the owner's screen went on saying "paired" throughout.

  A browser stamps every request with where it came from, in headers page script is not
  allowed to set. The four pairing routes, `GET /pair/status`, the fuel-path picker and the
  two voyage edits now read that stamp and answer 403 to anything that did not come from the
  boat's own screen. A caller with no browser headers is still let through, because that is
  curl or a script on the boat's own network, where the plugin's config route already hands
  over the token in one request.

  The GET reading surface is unchanged. It is published as an API to point a dashboard at,
  and some of those dashboards are pages on another port. `/pair/status` is the exception,
  because it carries the code.

### Changed

- **A pairing turned down for want of room now says which room.** An approval can come back
  refused because the account already holds as many boats as its plan allows. That arrived on
  the helm screen as "could not finish pairing, try again", which would have the skipper typing
  the code into a wall that will still be standing in a minute. It is an answer rather than a
  fault, so it now takes the shape the wrong-account refusal already had: the code is spent, and
  the screen names the cause and the place to go and fix it.

## [0.2.1] - 2026-08-04

### Added

- **The passage figures now sit beside the gauges, while the passage is still open.** They
  existed only after a voyage had closed, on another screen. An owner asked to read them under
  way and gave the reason: an average is worth reading against the instantaneous burn next to
  it, so a rate of 6 L/h means something. That comparison is only possible on the instrument
  board, which is where the panel goes.

  Nothing new is measured. The boat already integrates distance, time under way, the speeds
  and the litres; the panel reframes those into eight cells and divides two of them, dropping
  any cell whose denominator the passage does not have. A boat whose engines report no fuel
  rate loses three cells and keeps the rest, and the panel is absent altogether when no voyage
  is open.

  There is no idle cell, which is the one a trip computer is expected to have. Duration minus
  time under way is real minutes, but it adds together lying still with the log running and
  the boat being switched off between snapshots, and the rows cannot separate the two. Printed
  as "idle" it would tell an owner their boat idled for three hours while she sat on the hard
  with the panel dark. Both spans are shown, and the subtraction is left to the person who
  knows which it was.

## [0.2.0] - 2026-08-04

### Changed

- **The unencrypted reporting path is gone.** A vessel now reports to the shore encrypted or
  not at all. Until this release, a boat whose owner had authorised no screen sent her frames
  in the clear, which is how remote viewing shipped without taking anyone's live view away. It
  also meant the product's central promise held only for boats that happened to have a screen
  on their list, and an empty list arrives over a channel the boat does not control: as long as
  cleartext was the answer to it, whoever carried the list decided whether she was private.

  **What this means for an existing installation.** A boat with at least one authorised screen
  is unaffected: she was already sealing. A boat with none stops reporting to the shore when
  this version is installed, and her own screen says why. Authorise a screen - in the app, or
  on the vessel's page ashore - and reporting resumes within one key poll. Nothing recorded is
  lost either way: the vessel keeps her whole history herself, and always did.

  The minute-by-minute HTTPS call now carries the vessel's clock and nothing else. It cannot
  encrypt (a single POST has no key exchange behind it), so it no longer carries a position for
  anybody. Its job is unchanged: it is what keeps "she called in a minute ago" true while the
  socket will not stay up.

  A question that arrives unencrypted is refused rather than answered, on every channel and for
  every kind of read. That was already true of a sealing boat; it is now true of every boat.

### Fixed

- A vessel that is reporting nothing stays visible ashore. The shore records only a boat that
  says something, so one with no authorised screen - correctly silent - would have read as
  switched off, on the day she was installed and while her owner was looking at her page trying
  to work out why he could see nothing. The minute-by-minute call now stands down for a socket
  that is carrying reports rather than one that is merely connected, and takes over within
  minutes when reporting stops for any reason. It carries the vessel's clock and no position.

## [0.1.47] - 2026-08-04

### Added

- The Bridge screen now lists a short fingerprint for every authorised screen the vessel
  encrypts her reports to. A device added from the owner's account never goes near the boat,
  so the key that reaches her is passed along by the service, and she has no way to tell one
  the owner's phone made from one that was substituted for it. The only answer to that is a
  person: the same string is shown on the device and on the vessel's own display, on her own
  network, and the two are compared aboard. Offered rather than demanded, and nothing is
  blocked by it.

  The fingerprint is `SHA-256("siparu/device-fingerprint/v1" || key)` truncated to ten bytes
  and rendered in Crockford base32. It is computed over the decoded key rather than the text
  that carries it, because one key has several spellings and hashing the text would let
  whoever passes it along show two honest parties different strings for the same key. Eighty
  bits, because what is resisted is a second preimage rather than a collision. Four
  implementations that share no code are held to one committed set of vectors.

## [0.1.46] - 2026-08-03

### Added

- The Bridge screen now says when nothing is reaching the shore. A vessel that encrypts her
  reports and has been left with no authorised screen to encrypt to sends nothing, on
  purpose, and until now that was indistinguishable from a boat whose link had failed: the
  pairing band went on reporting the uplink as healthy, because the socket was. She names
  the condition in her own words instead, and says in the same breath that she is still
  recording her history aboard, so nobody goes looking for a fault at the helm over
  something that has to be put right ashore.

## [0.1.45] - 2026-08-03

### Fixed

- A screen the owner has just authorised no longer waits out the key poll before it can
  read anything. The boat reads the list of screens she encrypts to every five minutes,
  so a phone added in between could not open a single frame while she went on reporting
  normally, and the app had no way to tell that apart from a vessel that had gone quiet.
  Measured on a live link before the change: 101 seconds and fifty unreadable frames.
  She is now told when a screen ashore opens, and asks who may read her at that moment
  rather than on the next tick. Same measurement after: three seconds.
- The note that prompts this carries nothing and is answered with nothing. It reports
  that a connection was made; what to do about it is the boat's, and she keeps her own
  floor of half a minute between prompted asks so that a screen reconnecting in a loop
  cannot turn into a boat asking in a loop over a metered link. One arriving inside that
  floor is held until it expires rather than dropped, so a second screen authorised right
  behind the first is not left waiting out the full interval. The five minute poll
  underneath is unchanged: withdrawing a screen still has to work on a boat nobody is
  watching.

## [0.1.44] - 2026-08-01

### Fixed

- A fuel source that stops reporting no longer takes voyage fuel down with it in
  silence. The selection is kept in the plugin's options and outlives the paths that
  were current when it was made, so renaming a propulsion instance, or tidying two
  sources into one, leaves a filter naming something the boat no longer sends. Voyage
  fuel then integrated nothing and the figure was left out of the screen entirely,
  which reads as a passage under sail rather than a stale setting. Worse, the picker
  itself was only offered when more than one engine reported a rate, so the boat that
  had just been tidied down to one engine hid the only control that could lift the
  filter.
- The picker is now offered whenever a selection is in force, whatever the boat is
  reporting, and it lists the quiet path alongside the live ones so it can be switched
  off. Both the affordance and the voyage detail name the engine that is selected but
  silent, in place of an empty figure.

## [0.1.43] - 2026-07-31

### Added

- A sealed frame now carries which event its severity is about, as the moment the
  newest audible condition began. The severity is one word for the whole vessel, so
  a second alarm raised while a first one stands used to be indistinguishable from
  the first one still standing, and only the first was ever announced. The new field
  is signed like the severity, is left off until something audible has stood, and
  says that an event is a different event without saying what it is. A reader that
  has never heard of it verifies the signature exactly as before.

## [0.1.32] - 2026-07-26

### Added

- A sealed frame now says how loud the vessel is, and nothing about what is wrong.
  The notification tree is subscribed for the first time and read for one thing:
  the loudest condition standing. That word travels in the clear beside the
  ciphertext, because a carrier has to know a notification is due, and inside the
  signature, because it must not be able to decide that one is not. What the
  condition actually is - fuel, fire, shore power, an anchor dragging - stays in
  the encrypted body and is indistinguishable from outside.
- The level is sent on every sealed frame, quiet included. A reader that rings on
  a rise needs the fall back to normal in order to arm itself again; a boat that
  mentioned her severity only while something was wrong would announce the first
  alarm of a passage and none of the ones after it.

### Notes

- Only raised conditions are held, so a cleared notification is deleted rather
  than stored as quiet, and a flood of invented notification paths cannot hide the
  one condition that matters: at the ceiling, a louder state takes the place of a
  quieter one.
- A notification state in no vocabulary Signal K defines is ignored rather than
  guessed at, and said once in the log. Calling it an alarm would raise a false
  one; calling it normal would swallow whatever it meant.
- Nothing about this reaches the vessel. The notification tree is read from the
  delta stream, exactly as the gauges are.

## [0.1.31] - 2026-07-25

### Added

- A boat can now be asked a question nobody in between can read. A screen holding
  a device key seals its request to her inbox key; she opens it, answers it from
  her own store through the same narrow request guards as ever, and seals the
  answer back. The answer is an ordinary sealed frame carrying the request id as
  a signed extension, so a reader verifies an answer exactly as it verifies a
  report. Requests carry no signature and no wrapped key: a device holds no
  signing key by design, and a question has one recipient.

### Changed

- While she is sealing, an answer either goes sealed or does not go at all. A
  build wired without a sealer answered in the clear by omission before this.
  A refusal takes its own path out and stays in the clear: it carries no record
  of hers, and a screen asking in the clear has to be told rather than left
  waiting.

## [0.1.30] - 2026-07-22

### Changed

- Her recorded past follows her present. While frames are sealed, history,
  snapshots, voyages, track and phases are refused rather than answered in the
  clear: a boat sealing her position while sending a day of them in a snapshots
  page would have kept the promise on the smaller half of her data. The refusal
  names itself (`SEALED`) so a screen can say why rather than appear stuck.

## [0.1.29] - 2026-07-22

### Added

- Sealed reporting. When the account carries a device key, every live frame is
  encrypted to those devices and signed, so the service carrying it can verify a
  frame it cannot read. With no device key registered she reports exactly as
  before, and the switch is hers alone.

### Changed

- When screens are authorised and none of them can be sealed to, she sends
  nothing rather than falling back to cleartext. Silence is visible on an owner's
  screen; a quiet leak is not.

## [0.1.28] - 2026-07-22

### Added

- The boat holds two keys of her own, created at pairing and kept beside the
  relay credential at mode 0600: an Ed25519 identity that signs what she sends,
  and an X25519 inbox that receives what is sent to her. She publishes the public
  halves once, and the account refuses to change them afterwards.

## [0.1.27] - 2026-07-21

### Added

- Activity phases: the raw band beneath the voyages. A boat is always in one
  activity (under way, at anchor, on a mooring, or stopped), and she now records
  that band as a sibling of the voyage engine without touching it: a separate
  state machine and a separate file, so the voyage history is unaffected. A change
  of state has to hold before it counts, so a brief stop does not split a passage.
  Read over GET /phases and /phases/current, and over the live socket as a fifth
  read-only sibling of the history, snapshots, voyages and track reads. Recorded
  on the boat, kept nowhere ashore.

### Changed

- The closed-voyage time range reads with a plain hyphen.

## [0.1.26] - 2026-07-20

### Changed

- Raise the under-way live cadence to 2 seconds from 10, so a moving boat
  refreshes smoothly for a shore watching her. The standing cadence stays at 60
  seconds, so a boat at anchor or in a berth costs nothing extra. The 10-second
  floor was a free-tier request-ceiling workaround; the paid tier bills past the
  ceiling rather than cutting the socket, and compute duration was never the
  constraint (a 0.5% duty cycle against a far larger included pool).

## [0.1.25] - 2026-07-20

### Changed

- Engines and generators read as a matrix now, one parameter per row and one
  instance per column, so the same reading lines up across a multi-engine boat
  and a hot cylinder shows against its neighbours. Columns take their
  running-light colour (port red, starboard green, center amber). Tanks read as
  fill bars with a low-fuel accent.
- The wide board runs the bridge full width with the engine, generator and tank
  panels beside each other, and no longer pins a chart pane: the chart has its
  own Map tab. The phone scrolls the matrix sideways behind a pinned label rail.

### Fixed

- A gearbox's oil temperature and pressure no longer share a row with the
  engine's own oil readings on the matrix, which had quietly dropped one of the
  pair on a boat reporting both.

## [0.1.24] - 2026-07-20

### Added

- A fuel-source picker on the voyages screen. A boat where the same engine is
  reported by more than one source counts its fuel twice, and only the owner
  knows which reading is real; the picker lets her choose which
  `propulsion.*.fuel.rate` paths feed the per-voyage figure. It appears only when
  more than one engine reports fuel, and with nothing chosen every reporting
  engine is summed, exactly as before. The choice is this plugin's own option,
  saved through the same store the configuration screen writes and applied by a
  restart that re-integrates each voyage from disk; nothing reaches the vessel,
  and CI names the one new route in its read-only proof.

### Fixed

- The open voyage's fuel now moves live as the boat burns it, instead of only
  after a restart. The dynamic gauge paths that carry `propulsion.*.fuel.rate`
  reach disk on every snapshot but were withheld from the voyage engine's live
  feed, so the running total waited for the next reconcile from disk to catch up.

## [0.1.23] - 2026-07-19

### Added

- A track read over the live socket. A shore screen asks for one voyage by id and the
  boat answers with its recorded path, oldest fix first. A long track is decimated at an
  even stride before it crosses the wire, keeping the first and last fix, so a day under
  way at roughly 1 Hz still fits a single reply; the local track REST is left untouched
  and serves every fix. Read-only like its three siblings, and served from the same store.

## [0.1.22] - 2026-07-19

### Added

- A voyages read over the live socket. A shore screen asks for a boat's recent
  voyages and she answers with the list her local /voyages REST already serves,
  newest first, the count clamped to the same bounds. Read-only like its siblings,
  reaching the voyage store and never Signal K; a request that is not one of the
  known kinds is dropped in silence.

## [0.1.21] - 2026-07-19

### Added

- A snapshots read over the live socket. The socket already carried one gauge's
  history for a chart; it now also answers a request for whole recorded rows, the
  logbook read the shore could not reach before. It parses, acts only on a
  well-formed request, and reads the same store the local /snapshots REST serves,
  never Signal K and never a command. Read-only; the type tag is the gate, and
  anything that is not a known request is dropped in silence.

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

[Unreleased]: https://github.com/Tjockfan/siparu/compare/v0.2.9...HEAD
[0.2.9]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.9
[0.2.8]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.8
[0.2.7]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.7
[0.2.6]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.6
[0.2.5]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.5
[0.2.4]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.4
[0.2.3]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.3
[0.2.1]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.1
[0.2.0]: https://github.com/Tjockfan/siparu/releases/tag/v0.2.0
[0.1.45]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.45
[0.1.44]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.44
[0.1.43]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.43
[0.1.27]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.27
[0.1.26]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.26
[0.1.25]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.25
[0.1.24]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.24
[0.1.23]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.23
[0.1.22]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.22
[0.1.21]: https://github.com/Tjockfan/siparu/releases/tag/v0.1.21
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
