# Siparu

Kept aboard, proven ashore. A Signal K plugin that records your boat's bridge
data - position, speed, heading, wind, depth, and whatever engine, tank and
generator gauges she exposes - into an on-board history with voyage detection,
and serves it through a built-in dashboard and a read-only REST API.

The dashboard shows the bridge: speed, heading, wind, depth, position, the
logbook, voyages and the chart. Engine, tank and generator gauges have panels of
their own, built from what she reports rather than from a list: a boat with three
engines gets three sets of readings, and a boat with no generator gets no
generator tab. The same gauges are also served over the API (`GET /live`,
`GET /inventory`).

## Principles

- **Read-only.** The plugin never writes to your boat: no deltas are emitted,
  no PUT handlers registered, no action handlers, no NMEA out. The CI proves it
  on every commit - grep this codebase and see for yourself.
- **Nothing leaves until you pair her**, and pairing takes a deliberate tap at
  the helm. Unpair and it stops the same minute.
- **What she sends once paired.** Her bridge, every ten seconds under way and
  once a minute at rest: position,
  speed and course over ground, heading, rate of turn, magnetic variation and
  deviation, navigation state, apparent and true wind with gust and direction,
  depth, air and water temperature, barometric pressure, and GPS satellite count.
  Plus any engine, tank or generator gauges she exposes (`propulsion.*`,
  `tanks.*`, `electrical.generators.*`). That is what makes the remote screen a
  bridge instead of a dot on a map, and it is more than a position: if that is
  more than you want to share, do not pair her.
- **Your history stays on board.** It is recorded on the boat as plain NDJSON
  with hourly and daily summaries. There is no bulk upload and the shore keeps no
  copy: a paired screen may ask her for one gauge's series in order to draw a
  graph, and she answers that from her own store. That question is the only thing
  she accepts from ashore. She takes no commands, because there are none to take.
- **The relay keeps her name and the time she was last seen.** Nothing else. Live
  frames pass through it to whatever screen you have open and are stored by
  nobody, so when she is offline the shore has nothing to show and says so.
- **One runtime dependency, pure JavaScript.** `ws`, which carries the uplink, and
  nothing else. It has no install script and no dependency of its own, and its two
  native helpers are optional peers - which is what lets the AppStore install this
  plugin with `npm --ignore-scripts` and have it work, on anything from a Raspberry
  Pi to a Victron Cerbo GX (Venus OS Large). Nothing here needs node-gyp.
- **Compatibility floor:** Node 20 + signalk-server 2.18.

## Not a safety system

Siparu is not a navigation, safety or alarm system, and it is not a substitute for
seamanship, a watchkeeper, or going aboard to look. It reads instruments that
drift, break and lie, and it carries what they say over networks that fail,
starting with the boat's own uplink: a screen with nothing wrong on it is not the
same thing as a boat that is fine, and the plugin raises no alarm to tell you
otherwise. The chart is for looking, not for navigating, and a depth reading is
whichever plane the boat's own sounder reports, which is not always the water
under the keel. Do not rely on this software to protect life or property.

## Before you pair: turn on Signal K security

Signal K ships with security switched off, and nothing in the setup makes you turn
it on. With it off, every plugin's HTTP surface is open to anyone who can reach
your boat's network, this one included. (The relay credential itself is out of
reach: it lives in a mode-600 file under the plugin's data directory, not in the
config. The relay address is not a plugin option at all - it comes from the
server process's environment, so nothing that writes plugin options can redirect
the boat.)

Because of that, the plugin locks its own writes while security is off: pairing,
unpairing and log edits refuse until you either add an admin user in Signal K or
tick "Allow pairing and log edits while Signal K security is off" in the plugin
settings. The tick exists for installs that cannot easily turn security on; it is
an acceptance of the risk, not a removal of it.

The lock cannot make an unsecured server safe. On such a server
`GET /skServer/plugins` already discloses every plugin's configuration, the
server's own config route can change any plugin's settings - including that very
tick - and the App Store will install code. The consequence peculiar to Siparu is
what a stranger on the marina wifi could do with an open door: link your boat to
**their** account while your own screen goes on saying "paired".

So before you pair, add an admin user in Signal K (Security > Users). It takes a
minute and it is the difference between a boat you share and a boat you leak.

## The chart, and where its tiles come from

The dashboard's chart draws its coastline and place names from a basemap tile
server. The default is a free, keyless, planet-wide host, and like any tile
server it receives the requesting IP address and the tile coordinates being
viewed. Those coordinates are roughly where the boat is: opening the chart
reveals her approximate position to that host, whether or not remote viewing is
on, and whether or not she is paired.

To keep the chart fully offline, drop a `basemap.pmtiles` file into the plugin's
`charts` data folder; the chart then loads from it and asks no third party for
anything. The basemap server can also be pointed at your own OpenMapTiles host
in the plugin's advanced settings. The seamark overlay, fonts and sprites are
served from Siparu's own host by default and can be redirected the same way.

## REST API

Mounted at `/plugins/siparu`:

| Endpoint | Description |
|---|---|
| `GET /live` | Current state of all recorded paths + data age |
| `GET /inventory` | Dynamic paths the boat exposes right now, narrowed to the families the dashboard understands, with units metadata |
| `GET /snapshots?bucket=1\|60\|360\|1440&from=&to=&limit=&offset=&order=` | History rows. `bucket=1` serves raw rows (today only); larger buckets read materialized rollups |
| `GET /health` | Recording status, signature diagnosis, per-path freshness, storage usage, rollup state |
| `GET /voyages?limit=` | Auto-detected voyages, newest first |
| `GET /voyages/current` | Currently open voyage, or `null` |
| `GET /voyages/stats` | Today / yesterday / rolling 7 days / season aggregates |
| `GET /voyages/:id/track` | Minute-cadence GPS track of one voyage |
| `GET /ais/targets?max_nm=&max_age_min=&limit=` | Nearby AIS targets, from the vessels the server already tracks |
| `GET /rollups/hourly?from=&to=` | Raw hourly rollup lines the dashboard derives its history series from |
| `GET /map-config` | Resolved chart asset URLs, so the dashboard loads local charts or the remote tile server without guessing |
| `GET /config/fuel-paths` | Which engine fuel-rate paths feed the per-voyage fuel figure, and the paths available to choose from |
| `GET /voyages/edits` | Which voyages were joined by hand, and so can be separated again |

The reading surface above is GET-only. Three flows move the plugin's own state and
never touch the vessel's: pairing, the fuel-source picker, and correcting a voyage
the detector split or joined in the wrong place. CI proves the point on every
commit, names each write route, and an eighth one fails the build.

| Endpoint | Description |
|---|---|
| `GET /pair/status` | Current pairing state |
| `POST /pair/start` | Ask the relay for a code to show at the helm |
| `POST /pair/approve` · `POST /pair/deny` | Answer a claim - the tap at the helm |
| `POST /pair/reset` | Unpair |
| `POST /config/fuel-paths` | Choose which engine fuel-rate paths feed the per-voyage fuel figure |
| `POST /voyages/:id/merge-previous` | Join this passage to the one before it, when one trip was recorded as two |
| `POST /voyages/:id/undo-merge` | Separate a passage back into what it was made of |

Those seven, and `GET /pair/status` with them, answer only requests that came from the
boat's own screen. A browser marks every request with its origin, and one from a page on
another site gets 403: on a server with security off, which is the default, an advert
frame in any tab on the boat's network could otherwise unpair her or lift the pairing
code off the helm. A caller with no browser headers, curl or a script on her own network,
is not affected. Neither is the reading surface above.

The two voyage edits are reachable from the boat's own network only. What the
shore can ask her is a closed set of five questions, all of them reads
(`history`, `snapshots`, `voyages`, `track`, `phases`); nothing on that socket
changes anything aboard, and the REST surface above is not proxied to it.

### The uplink, when she is paired

She opens a WebSocket out to the relay and sends the live frame described above
every ten seconds under way, once a minute at rest; if that socket cannot hold -
marina networks mangle WebSockets - the same frame goes by HTTPS once a minute
instead. Either way the shore keeps none of it: when she drops off, all that
remains ashore is her name and when she was last seen. Both are outbound:
she dials the relay, the relay never dials her.

Exactly one kind of message travels the other way:

| Inbound | Description |
|---|---|
| `{ type: 'history', id, path, query }` | Asks her to read one gauge's recorded history from her own store and send it back. Answered from the same NDJSON the local `GET /snapshots` serves; it reaches nothing else. |

Anything else the shore sends is ignored, because a boat takes no command and so
there is nothing else to hear.

She reports encrypted or she does not report. Until the account has named a
device to seal to, nothing goes ashore at all: she keeps recording her own
history, and her own screen says why nothing is leaving. There is no fallback
that sends a position in the clear, because a boat whose privacy depends on the
state of a list held elsewhere does not have any.

Once a device is named, the report is encrypted to it and the relay carries a
block it cannot read. Two things stay legible beside it, and they are worth
stating plainly because they are what a carrier can see: her identifier and
the time she sent the frame, so it can be routed at all. Both are inside her
signature, so neither can be rewritten in transit.

Voyage detection opens after sustained movement, closes after sustained
stillness, and folds short docking manoeuvres into the preceding voyage. Its
behavior is pinned by a golden-fixture test against a reference
implementation on ten days of real vessel data (`plugin/test/fixtures/`).

All timestamps are epoch milliseconds (UTC). Values use Signal K's SI units
(m/s, radians, Kelvin, Pascal).

## Development

```
npm install
npm run build   # compile plugin TypeScript to plugin/dist
npm test        # unit tests (vitest)
```

## License

Apache-2.0
