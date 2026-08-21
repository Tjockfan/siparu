import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seesOtherVessels } from '../src/ais'
import { AisReceiverMemory } from '../src/aisreceiver'

/**
 * Proof that an AIS receiver is aboard, and why it has to be remembered.
 *
 * The map's AIS switch is a control, not a readout: it is what a skipper alone at sea
 * reaches for to see whether anybody is out there. Hiding it whenever the target count is
 * zero would take it away from exactly the boat that needs it most. But drawing it on a
 * vessel with no receiver breaks the rule the rest of the product keeps - a boat that
 * sends nothing gets no box.
 *
 * The two cases are identical in the Signal K model (an empty vessels dictionary), so the
 * only thing that tells them apart is history: a target seen once proves a receiver
 * forever. This file covers both halves, the sighting and the memory of it.
 */

describe('what counts as a sighting', () => {
  const self = 'vessels.urn:mrn:signalk:uuid:0001'
  const other = 'urn:mrn:imo:mmsi:222222222'

  it('sees another vessel in the model', () => {
    expect(seesOtherVessels({ 'urn:mrn:signalk:uuid:0001': {}, [other]: {} }, self)).toBe(true)
  })

  it('does not count the boat herself', () => {
    expect(seesOtherVessels({ 'urn:mrn:signalk:uuid:0001': {} }, self)).toBe(false)
  })

  it('says no on an empty or absent model', () => {
    expect(seesOtherVessels({}, self)).toBe(false)
    expect(seesOtherVessels(undefined, self)).toBe(false)
  })

  it('counts a target the map overlay would throw away', () => {
    // buildAisFeed drops targets that are far, stale or have no position. None of that
    // bears on whether a receiver is aboard: a silent hulk 40 miles off, reported once an
    // hour, is the same proof as a ferry alongside. Filtering here would make the switch
    // disappear from a boat in open water, which is the failure this whole file prevents.
    expect(seesOtherVessels({ 'urn:mrn:signalk:uuid:0001': {}, [other]: { navigation: {} } }, self)).toBe(
      true
    )
  })
})

describe('remembering the sighting', () => {
  let dir: string
  let mem: AisReceiverMemory
  const file = () => path.join(dir, 'ais.json')

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-ais-'))
    mem = new AisReceiverMemory(dir)
    mem.load()
  })

  afterEach(async () => {
    await mem.flush()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('starts out having seen nothing', () => {
    expect(mem.status()).toEqual({ receiver_seen: false, first_seen_ts: null })
  })

  it('holds the sighting and the hour of it', async () => {
    mem.note(1_770_000_000_000)
    await mem.flush()
    expect(mem.status()).toEqual({ receiver_seen: true, first_seen_ts: 1_770_000_000_000 })
  })

  it('survives a restart, which is the whole point', async () => {
    mem.note(1_770_000_000_000)
    await mem.flush()
    const after = new AisReceiverMemory(dir)
    after.load()
    expect(after.status()).toEqual({ receiver_seen: true, first_seen_ts: 1_770_000_000_000 })
  })

  it('writes once and never again', async () => {
    // Called from the snapshot tick, so this runs for as long as the boat is powered. A
    // write per minute for the life of the vessel would wear the card this runs off.
    mem.note(1_770_000_000_000)
    await mem.flush()
    const first = fs.statSync(file()).mtimeMs
    mem.note(1_770_000_600_000)
    await mem.flush()
    expect(fs.statSync(file()).mtimeMs).toBe(first)
    expect(mem.status().first_seen_ts).toBe(1_770_000_000_000)
  })

  it('keeps the switch when the record has gone bad', async () => {
    // She wrote the file, so she had seen a target. Reading a torn sector as "no receiver"
    // would take the control away from a boat that has one, and the reader cannot tell a
    // bad sector from an honest empty horizon. The recoverable mistake is the other one:
    // an idle switch on a boat that has no AIS.
    fs.writeFileSync(file(), '{ this is not json')
    const after = new AisReceiverMemory(dir)
    after.load()
    expect(after.status()).toEqual({ receiver_seen: true, first_seen_ts: null })
  })
})
