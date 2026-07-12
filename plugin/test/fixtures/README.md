# Golden fixtures

`season-sample.ndjson.gz` - 10 days of minute-cadence vessel snapshots
(ts, lat, lon, sog, nav_state), anonymized: **both latitude and longitude are
shifted by fixed offsets**, and timestamps by a fixed delta (interval-preserving).
The track's shape and its sog values are preserved so the detector has real work
to do; the position is not a real one. No vessel-identifying data is included.

`expected-voyages.json` - the voyage list the detector produces over exactly this
input. It was first generated from the reference implementation and, when the
fixture's latitude was anonymized, re-derived from the shipped engine (which the
test below proves equal to that reference). The voyage engine must reproduce it
(see voyage-golden.test.ts); this guards against silent behavior drift in the
state machine, the metric integration and the merge pass.
