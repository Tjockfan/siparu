# Siparu

Kept aboard, proven ashore. A Signal K plugin that records your boat's bridge
data - position, speed, heading, wind, depth, and whatever engine, tank and
generator gauges she exposes - into an on-board history with voyage detection,
and serves it through a built-in dashboard and a read-only REST API.

## Principles

- **Read-only.** The plugin never writes to your boat: no deltas are emitted,
  no PUT handlers registered, no action handlers, no NMEA out. The CI proves it
  on every commit - grep this codebase and see for yourself.
- **Nothing leaves until you pair her**, and pairing takes a deliberate tap at
  the helm. Unpair and it stops the same minute.
- **What she sends once paired.** Her bridge, every couple of seconds: position,
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

## Before you pair: turn on Signal K security

Signal K ships with security switched off, and nothing in the setup makes you turn
it on. With it off, every plugin's HTTP surface is open to anyone who can reach
your boat's network, this one included: the pairing endpoints below answer whoever
asks, and `GET /plugins/siparu/config` hands over the credential that lets a screen
ashore watch this vessel.

Little of that is peculiar to Siparu. On an unsecured server `GET /skServer/plugins`
already discloses every plugin's configuration and the App Store will install code.
What is peculiar to Siparu is the consequence: someone on the same marina wifi can
link your boat to **their** account, and your own screen will go on saying "paired"
while they watch her.

So before you pair, add an admin user in Signal K (Security > Users). It takes a
minute and it is the difference between a boat you share and a boat you leak.

## REST API

Mounted at `/plugins/siparu`:

| Endpoint | Description |
|---|---|
| `GET /live` | Current state of all recorded paths + data age |
| `GET /snapshots?bucket=1\|60\|360\|1440&from=&to=&limit=&offset=&order=` | History rows. `bucket=1` serves raw rows (today only); larger buckets read materialized rollups |
| `GET /health` | Recording status, signature diagnosis, per-path freshness, storage usage, rollup state |
| `GET /voyages?limit=` | Auto-detected voyages, newest first |
| `GET /voyages/current` | Currently open voyage, or `null` |
| `GET /voyages/stats` | Today / yesterday / rolling 7 days / season aggregates |
| `GET /voyages/:id/track` | Minute-cadence GPS track of one voyage |

The reading surface above is GET-only. The one exception is pairing, which
moves the plugin's own state and never touches the vessel's:

| Endpoint | Description |
|---|---|
| `GET /pair/status` | Current pairing state |
| `POST /pair/start` | Ask the relay for a code to show at the helm |
| `POST /pair/approve` · `POST /pair/deny` | Answer a claim - the tap at the helm |
| `POST /pair/reset` | Unpair |

### The uplink, when she is paired

She opens a WebSocket out to the relay and sends the live frame described above
every couple of seconds; if that socket cannot hold - marina networks mangle
WebSockets - the same frame goes by HTTPS once a minute instead, which is also
what leaves a last known position behind when she drops off. Both are outbound:
she dials the relay, the relay never dials her.

Exactly one kind of message travels the other way:

| Inbound | Description |
|---|---|
| `{ type: 'history', id, path, query }` | Asks her to read one gauge's recorded history from her own store and send it back. Answered from the same NDJSON the local `GET /snapshots` serves; it reaches nothing else. |

Anything else the shore sends is ignored, because a boat takes no command and so
there is nothing else to hear.

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
