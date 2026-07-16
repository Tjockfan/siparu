/**
 * The seam between MetricsState and the recorded history.
 *
 * A row on disk claims to be a measurement taken at its `ts`. The live screen
 * may keep showing an instrument's last value after it goes quiet - that is
 * what last-known-wins is for, and it is the right call for a gauge someone is
 * looking at. A recorded row may not, because nothing measured it: an entry
 * saying "8 kn at 22:45" when the GPS died at 22:15 is the one thing this
 * product exists to never do.
 *
 * These tests drive the whole path the plugin drives - ingest -> snapshot ->
 * store.append -> VoyageLog.feed - because the fabrication lives in the seam
 * between them, where the metrics tests and the voyage tests each stop.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULTS, INTERNAL } from '../src/config'
import { Voyage } from '../src/contract'
import { MetricsState } from '../src/metrics'
import { Store } from '../src/store'
import { VoyageLog } from '../src/voyagelog'

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)
/** knots -> m/s */
const KN = 1 / 1.94384
const MINUTE = 60_000

let dir: string
let store: Store

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'siparu-stale-'))
  store = new Store(dir, 100 * 1024 * 1024, () => undefined)
  await store.init(T0)
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** index.ts writeSnapshot without the plumbing: the row that reaches disk. */
async function record(state: MetricsState, vlog: VoyageLog, now: number): Promise<void> {
  const snap = state.snapshot(now, true, INTERNAL.fabricationHorizonMs)
  await store.append(snap)
  await vlog.feed(snap)
}

describe('a recorded row is a measurement, not a memory', () => {
  it('drops what nothing measured, while the live read keeps showing it', () => {
    const s = new MetricsState(DEFAULTS)
    s.ingest('navigation.speedOverGround', 8 * KN, T0)
    s.ingest('navigation.position', { latitude: 43.0, longitude: 6.0 }, T0)
    s.ingest('navigation.state', 'under way using engine', T0)
    s.ingest('environment.depth.belowTransducer', 14.0, T0)
    s.ingest('environment.wind.speedApparent', 7.5, T0)

    const live = s.snapshot(T0 + 30 * MINUTE, false)
    expect(live.sog).toBeCloseTo(8 * KN, 5)
    expect(live.depth).toBe(14.0)

    const recorded = s.snapshot(T0 + 30 * MINUTE, true, INTERNAL.fabricationHorizonMs)
    expect(recorded.sog).toBeNull()
    expect(recorded.lat).toBeNull()
    expect(recorded.lon).toBeNull()
    expect(recorded.nav_state).toBeNull()
    expect(recorded.depth).toBeNull()
    expect(recorded.wind_speed_apparent).toBeNull()
  })

  it('cuts where the horizon says it does, not a beat earlier', () => {
    const s = new MetricsState(DEFAULTS)
    const h = INTERNAL.fabricationHorizonMs
    s.ingest('navigation.speedOverGround', 4.1, T0)
    expect(s.snapshot(T0 + h, true, h).sog).toBe(4.1)
    expect(s.snapshot(T0 + h + 1, true, h).sog).toBeNull()
  })

  it('keeps a slow gauge that is merely unhurried', () => {
    const s = new MetricsState(DEFAULTS)
    // A barometer speaking once a minute is not a dead barometer. This is why
    // the horizon is its own constant and not INTERNAL.staleMs (30s), which
    // would null a perfectly healthy one on every snapshot.
    s.ingest('environment.outside.pressure', 101_300, T0)
    expect(s.snapshot(T0 + 90_000, true, INTERNAL.fabricationHorizonMs).air_pressure_pa).toBe(101_300)
  })
})

describe('the live read says how old each value is', () => {
  it('ages each field by its own source, while the boat sails on', () => {
    const s = new MetricsState(DEFAULTS)
    // The signature failure: GPS alive, depth sounder dead. data_age_s cannot
    // see this - it is the whole reason field ages exist.
    s.ingest('environment.depth.belowTransducer', 14.0, T0)
    s.ingest('navigation.position', { latitude: 43.0, longitude: 6.0 }, T0 + 30 * MINUTE)
    s.ingest('navigation.speedOverGround', 8 * KN, T0 + 30 * MINUTE)

    const ages = s.coreFieldAges(T0 + 30 * MINUTE)
    expect(ages.sog).toBe(0)
    expect(ages.lat).toBe(0)
    expect(ages.lon).toBe(0)
    expect(ages.depth).toBe(30 * 60)

    // The live snapshot still shows the frozen depth - that is last-known-wins
    // doing its job. The age is what tells the screen not to trust it.
    expect(s.snapshot(T0 + 30 * MINUTE, false).depth).toBe(14.0)
  })

  it('has no age for a field nothing ever reported', () => {
    const s = new MetricsState(DEFAULTS)
    s.ingest('navigation.speedOverGround', 4.0, T0)
    const ages = s.coreFieldAges(T0)
    expect(ages.sog).toBe(0)
    expect(ages.depth).toBeUndefined()
    expect(ages.lat).toBeUndefined()
    // A window max-hold has no source and so no age.
    expect(ages.wind_gust).toBeUndefined()
  })
})

describe('the seam: a dead sensor reaches the voyage log', () => {
  it('a GPS that stops talking does not go on logging hours underway', async () => {
    const state = new MetricsState(DEFAULTS)
    const vlog = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog.init(T0)

    // Ten minutes of real passage at 8 kn, deltas arriving as they would.
    let lat = 43.0
    for (let t = 0; t <= 10 * MINUTE; t += INTERNAL.samplePeriodMs) {
      state.ingest('navigation.speedOverGround', 8 * KN, T0 + t)
      state.ingest('navigation.position', { latitude: lat, longitude: 6.0 }, T0 + t)
      lat += 0.0000741 // ~8 kn, northbound
      if (t % MINUTE === 0) await record(state, vlog, T0 + t)
    }

    const open = vlog.current()
    expect(open).not.toBeNull()
    const atDeath = open as Voyage
    expect(atDeath.hours_underway).toBeGreaterThan(0.1)
    const hoursAtDeath = atDeath.hours_underway
    const distanceAtDeath = atDeath.distance_nm

    // The GPS goes silent. Nothing else does: the snapshot timer keeps firing
    // every minute, and it is that timer - not the sensor - writing the rows.
    // The horizon does not abolish the fabrication, it bounds it: a value two
    // minutes old is still trusted, on purpose, so the first rows after the
    // death still count. What must not happen is that it goes on counting.
    for (let t = 11 * MINUTE; t <= 13 * MINUTE; t += MINUTE) {
      await record(state, vlog, T0 + t)
    }
    const settled = vlog.current()?.hours_underway as number

    for (let t = 14 * MINUTE; t <= 40 * MINUTE; t += MINUTE) {
      await record(state, vlog, T0 + t)
    }

    const after = vlog.current()
    // Twenty-seven further minutes of silence add nothing at all.
    expect(after?.hours_underway).toBe(settled)
    expect(after?.distance_nm).toBe(distanceAtDeath)

    // And the whole invention is bounded by the horizon rather than by how long
    // the GPS stays dead - which is the bug: before the gate this reached 0.667,
    // a full half hour of passage the boat never made.
    expect(settled - hoursAtDeath).toBeLessThanOrEqual(INTERNAL.fabricationHorizonMs / 3_600_000 + 0.001)
    expect(after?.hours_underway).toBeLessThan(0.25)
  })

  it('leaves the voyage open when the boat stopped just before her GPS died', async () => {
    // The horizon's known cost, pinned so it stays a decision rather than a
    // surprise. A GPS that reports SOG=0 briefly and then goes silent used to
    // close the voyage: the stale zero was, by luck, true. The gate cuts that
    // zero along with everything else, so the voyage stays open until the GPS
    // comes back and a real stop is observed.
    //
    // Accepted deliberately. The hours stay honest either way (asserted below);
    // what is lost is a closing time nothing measured, and an open voyage says
    // "not known" where the old row said "moored at 22:45" on no evidence. The
    // remaining gap - closing a voyage on absence of data rather than on a
    // fabricated zero - belongs to the voyage engine, which is golden-pinned and
    // is not touched here.
    const state = new MetricsState(DEFAULTS)
    const vlog = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog.init(T0)

    for (let t = 0; t <= 10 * MINUTE; t += INTERNAL.samplePeriodMs) {
      state.ingest('navigation.speedOverGround', 8 * KN, T0 + t)
      state.ingest('navigation.position', { latitude: 43.0, longitude: 6.0 }, T0 + t)
      if (t % MINUTE === 0) await record(state, vlog, T0 + t)
    }
    const hoursUnderway = vlog.current()?.hours_underway as number

    // She stops, says so for one minute, and the GPS dies.
    for (let t = 10 * MINUTE + INTERNAL.samplePeriodMs; t <= 11 * MINUTE; t += INTERNAL.samplePeriodMs) {
      state.ingest('navigation.speedOverGround', 0, T0 + t)
      state.ingest('navigation.position', { latitude: 43.0, longitude: 6.0 }, T0 + t)
      if (t % MINUTE === 0) await record(state, vlog, T0 + t)
    }
    for (let t = 12 * MINUTE; t <= 60 * MINUTE; t += MINUTE) {
      await record(state, vlog, T0 + t)
    }

    expect(vlog.current()).not.toBeNull()
    // The point: open, but not inventing a passage while it waits.
    expect(vlog.current()?.hours_underway).toBe(hoursUnderway)
  })

  it('a boat that really is under way still logs her hours', async () => {
    // The guard above must not buy its honesty by throwing away live data:
    // same 40 minutes, sensor alive throughout.
    const state = new MetricsState(DEFAULTS)
    const vlog = new VoyageLog(store, DEFAULTS, () => undefined)
    await vlog.init(T0)

    let lat = 43.0
    for (let t = 0; t <= 40 * MINUTE; t += INTERNAL.samplePeriodMs) {
      state.ingest('navigation.speedOverGround', 8 * KN, T0 + t)
      state.ingest('navigation.position', { latitude: lat, longitude: 6.0 }, T0 + t)
      lat += 0.0000741
      if (t % MINUTE === 0) await record(state, vlog, T0 + t)
    }

    const v = vlog.current()
    expect(v).not.toBeNull()
    // 40 minutes underway = 0.667 h, less the first row (no predecessor to
    // integrate against).
    expect(v?.hours_underway).toBeGreaterThan(0.6)
    expect(v?.distance_nm).toBeGreaterThan(4.0)
  })
})
