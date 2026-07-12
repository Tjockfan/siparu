# Siparu

Kept aboard, proven ashore. A Signal K plugin that records your boat's bridge
data - position, speed, heading, wind, depth - into an on-board history with
voyage detection, and serves it through a built-in dashboard (PWA) and a
read-only REST API.

## Principles

- **Read-only.** The plugin never writes to your boat: no deltas are emitted,
  no PUT handlers registered, no action handlers, no NMEA out. The CI proves it
  on every commit - grep this codebase and see for yourself.
- **Your data stays on board.** History is stored on the boat, in plain NDJSON
  files with hourly/daily summaries. Nothing leaves the vessel unless you pair
  it, and pairing takes a deliberate tap at the helm - after which the boat
  sends its current position and name to the portal you paired it with, and
  nothing else. Unpair and it stops. The history never leaves.
- **Zero runtime dependencies, pure JavaScript.** No native modules, so it
  installs cleanly from the Signal K AppStore on anything from a Raspberry Pi
  to a Victron Cerbo GX (Venus OS Large).
- **Compatibility floor:** Node 20 + signalk-server 2.18.

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
