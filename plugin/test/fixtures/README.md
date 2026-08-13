# Golden fixtures

`season-sample.ndjson.gz` - a wholly synthetic, procedurally generated track
of minute-cadence snapshots (ts, lat, lon, sog, nav_state). No real vessel data
is involved: `generate.mjs` lays it down from a seeded PRNG as an alternating
sequence of stationary periods (moored/anchored, SOG ~ 0) and underway legs
(SOG at a cruising band, position advanced along a bearing from an open-ocean
origin). That is exactly the workout the detector needs - a threshold crossing
to open, sustained stillness to close, legs long enough that the short-leg merge
pass leaves them apart. Regenerate with `node generate.mjs`; the output is
byte-stable for a given seed.

`expected-voyages.json` - the voyage list the engine produces over exactly this
input. It is derived from the engine itself (run `reconcile` over the fixture
rows and serialize the result), so the fixture is self-consistent by
construction. The voyage engine must reproduce it (see `voyage-golden.test.ts`);
this guards against silent behavior drift in the state machine, the metric
integration and the merge pass. After changing the track, re-derive this file
before running the golden test.
