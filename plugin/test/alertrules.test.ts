import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { generateKeyPairSync } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AlertRuleStore,
  MAX_ALERT_RULES,
  MAX_CLOCK_SKEW_MS,
  makeRuleProof,
  parseRuleWrite,
  proofInput,
  verifyRuleProof,
  type ParsedRuleWrite
} from '../src/alertrules'
import { BoatKeyStore } from '../src/keystore'
import { publicFromPrivate, rawPrivate, rawPublic } from '../src/sealing'

/**
 * The one thing a device writes, and the proof that says who wrote it.
 *
 * Two halves are being measured here and they fail in opposite directions. The proof has to
 * refuse a stranger, because the boat's inbox key is public and without it anyone who knew it
 * could silence her alarms. The store has to fall LOUD on everything else - a corrupt file, a
 * list it cannot read, a boat that was never given one - because the failure nobody notices is
 * the phone that never rang.
 */

const BOAT = 'boat-0001'
const TANK = 'notifications.tanks.blackWater.0.currentLevel'
const BILGE = 'notifications.tanks.bilge.0.currentLevel'

let dir: string
let keys: BoatKeyStore
let inboxPriv: Buffer
let inboxPub: Buffer

/** A screen, with both halves kept so a test can write as it and check as her. */
function device(kid = 'kid-phone') {
  const pair = generateKeyPairSync('x25519')
  return {
    kid,
    priv: rawPrivate(pair.privateKey),
    pub: rawPublic(pair.publicKey)
  }
}

/** A rule write as a real device makes one: the proof is computed, never pasted. */
function write(
  dev: ReturnType<typeof device>,
  over: Partial<Omit<ParsedRuleWrite, 'proof'>> = {},
  proofOver: { boat?: string } = {}
): ParsedRuleWrite {
  const req = {
    v: 1,
    id: 'req-0001',
    kid: dev.kid,
    ts: 1_753_142_400_000,
    rules: [{ path: TANK, ring_from: 'never' }],
    ...over
  }
  return {
    ...req,
    proof: makeRuleProof({
      req,
      boat: proofOver.boat ?? BOAT,
      devicePriv: dev.priv,
      devicePub: dev.pub,
      inboxPub
    })
  }
}

function check(req: ParsedRuleWrite, dev: ReturnType<typeof device>, boat = BOAT): boolean {
  return verifyRuleProof({ req, boat, inboxPriv, inboxPub, devicePub: dev.pub })
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-rules-'))
  keys = new BoatKeyStore(dir)
  keys.load()
  const pair = await keys.ensure()
  inboxPriv = rawPrivate(pair.inbox)
  inboxPub = publicFromPrivate(pair.inbox)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('proving who wrote a rule list', () => {
  it('accepts a list from the device that made it', () => {
    const phone = device()
    expect(check(write(phone), phone)).toBe(true)
  })

  it('refuses a list signed with another device key', () => {
    // The whole point of the layer. Opening a request proves only that the sender knew a
    // public key; this is what turns that into "and holds the private half of an authorised
    // screen".
    const phone = device()
    const stranger = device('kid-stranger')
    const forged = write(stranger, { kid: phone.kid })
    expect(check(forged, phone)).toBe(false)
  })

  it('refuses a proof made against another boat', () => {
    // A write captured on its way to one vessel must not be replayable at the next berth.
    const phone = device()
    expect(check(write(phone, {}, { boat: 'boat-9999' }), phone)).toBe(false)
  })

  it.each([
    ['the request id', { id: 'req-0002' }],
    ['the timestamp', { ts: 1_753_142_400_001 }],
    ['the device id', { kid: 'kid-other' }],
    ['a rule path', { rules: [{ path: BILGE, ring_from: 'never' }] }],
    ['a severity', { rules: [{ path: TANK, ring_from: 'alarm' }] }],
    ['the rule count', { rules: [] }]
  ])('refuses a list where a carrier rewrote %s', (_what, over) => {
    const phone = device()
    const signed = write(phone)
    expect(check({ ...signed, ...over } as ParsedRuleWrite, phone)).toBe(false)
  })

  it('refuses a list whose rules were reordered in transit', () => {
    // Covered in the order sent rather than sorted, so a carrier that shuffled them fails the
    // check. It also means the boat can store them in the order she verified.
    const phone = device()
    const signed = write(phone, {
      rules: [
        { path: TANK, ring_from: 'never' },
        { path: BILGE, ring_from: 'alarm' }
      ]
    })
    const shuffled = { ...signed, rules: [...signed.rules].reverse() }
    expect(check(shuffled, phone)).toBe(false)
  })

  it('refuses a proof that is not thirty-two bytes, or not base64url at all', () => {
    const phone = device()
    const signed = write(phone)
    expect(check({ ...signed, proof: signed.proof.slice(0, 20) }, phone)).toBe(false)
    expect(check({ ...signed, proof: 'not base64url!!' }, phone)).toBe(false)
    expect(check({ ...signed, proof: '' }, phone)).toBe(false)
  })
})

describe('the bytes both implementations have to agree on', () => {
  it('cannot be made the same by two different lists', () => {
    // Length prefixes, and this is what they buy: without them a path ending where a severity
    // begins would hash identically to the pair split elsewhere, and a carrier could move the
    // boundary without breaking the proof.
    const base = { v: 1, boat: BOAT, kid: 'k', id: 'i', ts: 1 }
    const a = proofInput({ ...base, rules: [{ path: 'notifications.ab', ring_from: 'never' }] })
    const b = proofInput({ ...base, rules: [{ path: 'notifications.a', ring_from: 'bnever' }] })
    expect(a.equals(b)).toBe(false)
  })

  it('separates a boat and a device that run together', () => {
    const rules = [{ path: TANK, ring_from: 'never' }]
    const a = proofInput({ v: 1, boat: 'ab', kid: 'c', id: 'i', ts: 1, rules })
    const b = proofInput({ v: 1, boat: 'a', kid: 'bc', id: 'i', ts: 1, rules })
    expect(a.equals(b)).toBe(false)
  })
})

describe('reading a write off the wire', () => {
  it('ignores anything that is not one', () => {
    expect(parseRuleWrite({ type: 'voyages', id: 'x', limit: 5 })).toBeUndefined()
    expect(parseRuleWrite(null)).toBeUndefined()
    expect(parseRuleWrite('setalertrules')).toBeUndefined()
  })

  it('refuses a list longer than the ceiling before it hashes anything', () => {
    // Everything on this side of the proof runs for whoever can reach the socket. A list of a
    // million entries must be turned away by its shape, not after an HMAC over all of it.
    const rules = Array.from({ length: MAX_ALERT_RULES + 1 }, (_, i) => ({
      path: `notifications.x.${i}`,
      ring_from: 'never'
    }))
    expect(parseRuleWrite({ type: 'setalertrules', v: 1, id: 'i', kid: 'k', ts: 1, rules, proof: 'x' }))
      .toBeUndefined()
  })

  it('keeps a severity it does not recognise, and leaves the judgement for later', () => {
    // Deliberate: the proof covers raw fields, so whether a word means anything to this build
    // is a question for after the sender is established. A device she answers to deserves to
    // be told its list was refused; a stranger deserves nothing.
    const parsed = parseRuleWrite({
      type: 'setalertrules',
      v: 1,
      id: 'i',
      kid: 'k',
      ts: 1,
      rules: [{ path: TANK, ring_from: 'whenever' }],
      proof: 'x'
    })
    expect(parsed?.rules[0].ring_from).toBe('whenever')
  })
})

describe('what rings, and what does not', () => {
  const now = 1_753_142_400_000

  it('rings for everything on a boat that was never given a list', () => {
    // The loud default, and the one mistake this file must not make is being quiet by accident.
    const store = new AlertRuleStore(dir)
    store.load()
    expect(store.rings(TANK, 'warning')).toBe(true)
    expect(store.rings(TANK, 'alarm')).toBe(true)
    expect(store.ts()).toBe(0)
  })

  it('mutes a path the owner said never', async () => {
    const store = new AlertRuleStore(dir)
    const phone = device()
    expect(await store.apply(write(phone, { ts: now }), now)).toBeUndefined()
    expect(store.rings(TANK, 'alarm')).toBe(false)
    expect(store.rings(TANK, 'warning')).toBe(false)
    // Silencing one condition says nothing about any other.
    expect(store.rings(BILGE, 'warning')).toBe(true)
  })

  it('lets the quiet half through unannounced when the floor is alarm', async () => {
    const store = new AlertRuleStore(dir)
    const phone = device()
    await store.apply(write(phone, { ts: now, rules: [{ path: TANK, ring_from: 'alarm' }] }), now)
    expect(store.rings(TANK, 'warning')).toBe(false)
    expect(store.rings(TANK, 'alarm')).toBe(true)
  })

  it('rings for both when the floor is warning, which is what she already did', async () => {
    const store = new AlertRuleStore(dir)
    const phone = device()
    await store.apply(write(phone, { ts: now, rules: [{ path: TANK, ring_from: 'warning' }] }), now)
    expect(store.rings(TANK, 'warning')).toBe(true)
    expect(store.rings(TANK, 'alarm')).toBe(true)
  })
})

describe('taking a list, and refusing one', () => {
  const now = 1_753_142_400_000

  it('answers with the list she stored, so a screen shows what she is going by', async () => {
    const store = new AlertRuleStore(dir)
    await store.apply(write(device(), { ts: now }), now)
    expect(store.rules()).toEqual([{ path: TANK, ring_from: 'never' }])
    expect(store.ts()).toBe(now)
  })

  it('replaces the list wholesale rather than merging it', async () => {
    const store = new AlertRuleStore(dir)
    const phone = device()
    await store.apply(write(phone, { ts: now, rules: [{ path: TANK, ring_from: 'never' }] }), now)
    await store.apply(
      write(phone, { ts: now + 1, rules: [{ path: BILGE, ring_from: 'alarm' }] }),
      now + 1
    )
    expect(store.rules()).toEqual([{ path: BILGE, ring_from: 'alarm' }])
    // The mute the second list did not carry is gone, which is what wholesale means.
    expect(store.rings(TANK, 'warning')).toBe(true)
  })

  it('refuses a list at or below the one she is going by', async () => {
    // A captured write must not be able to restore last week's preferences.
    const store = new AlertRuleStore(dir)
    const phone = device()
    await store.apply(write(phone, { ts: now }), now)
    expect((await store.apply(write(phone, { ts: now, rules: [] }), now))?.code).toBe('STALE')
    expect((await store.apply(write(phone, { ts: now - 1, rules: [] }), now))?.code).toBe('STALE')
    expect(store.rules()).toHaveLength(1)
  })

  it('refuses a list stamped far in the future, so a runaway clock cannot lock her owner out', async () => {
    const store = new AlertRuleStore(dir)
    const phone = device()
    const far = now + MAX_CLOCK_SKEW_MS + 1
    expect((await store.apply(write(phone, { ts: far }), now))?.code).toBe('STALE')
    // A phone and a boat disagree by seconds, and that has to keep working.
    const near = now + MAX_CLOCK_SKEW_MS - 1
    expect(await store.apply(write(phone, { ts: near }), now)).toBeUndefined()
  })

  it.each([
    ['a path that is not a notification', [{ path: 'tanks.fuel.0.currentLevel', ring_from: 'never' }]],
    ['the same path twice', [
      { path: TANK, ring_from: 'never' },
      { path: TANK, ring_from: 'alarm' }
    ]],
    ['a severity she does not know', [{ path: TANK, ring_from: 'whenever' }]]
  ])('refuses a list carrying %s, and says so', async (_what, rules) => {
    const store = new AlertRuleStore(dir)
    const refusal = await store.apply(write(device(), { ts: now, rules }), now)
    expect(refusal?.code).toBe('BAD_RULES')
    expect(store.rules()).toEqual([])
  })

  it('refuses a version this build does not speak', async () => {
    const store = new AlertRuleStore(dir)
    expect((await store.apply(write(device(), { ts: now, v: 2 }), now))?.code).toBe(
      'UNSUPPORTED_VERSION'
    )
  })

  it('does not go by a list it could not write down', async () => {
    // The other order would leave an owner looking at a screen that says his choice was saved
    // and a boat that forgets it on the next restart - the failure he discovers by not being
    // woken.
    const store = new AlertRuleStore(path.join(dir, 'nowhere'))
    const refusal = await store.apply(write(device(), { ts: now }), now)
    expect(refusal?.code).toBe('WRITE_FAILED')
    expect(store.rings(TANK, 'alarm')).toBe(true)
    expect(store.rules()).toEqual([])
  })
})

describe('across a restart, which Signal K performs on every config save', () => {
  const now = 1_753_142_400_000

  it('goes by the list she was given before she stopped', async () => {
    const first = new AlertRuleStore(dir)
    await first.apply(write(device(), { ts: now }), now)
    await first.flush()

    const second = new AlertRuleStore(dir)
    second.load()
    expect(second.rules()).toEqual([{ path: TANK, ring_from: 'never' }])
    expect(second.rings(TANK, 'alarm')).toBe(false)
    // The replay floor survives too, or a restart would be a way to reinstate an old list.
    expect(second.ts()).toBe(now)
    expect((await second.apply(write(device(), { ts: now }), now))?.code).toBe('STALE')
  })

  it.each([
    ['is not JSON', 'this is not json'],
    ['is a version she does not know', JSON.stringify({ v: 99, ts: 1, rules: [] })],
    ['is missing its timestamp', JSON.stringify({ v: 1, rules: [] })],
    ['carries a rule she cannot read', JSON.stringify({ v: 1, ts: 1, rules: [{ path: 7 }] })],
    [
      'carries a rule she would have refused',
      JSON.stringify({ v: 1, ts: 1, rules: [{ path: 'tanks.fuel.0', ring_from: 'never' }] })
    ]
  ])('rings for everything when the stored list %s', async (_what, contents) => {
    // Falling loud rather than quiet. A corrupt file that muted a boat would be a silence
    // nobody chose and nobody would notice until the night it mattered.
    fs.writeFileSync(path.join(dir, 'alertrules.json'), contents)
    const store = new AlertRuleStore(dir)
    store.load()
    expect(store.rings(TANK, 'alarm')).toBe(true)
    expect(store.rules()).toEqual([])
    expect(store.ts()).toBe(0)
  })
})

/**
 * The shipping module against the committed vectors.
 *
 * The reference implementation in dev/e2e-vectors is held to the same file separately. Both
 * are needed and neither substitutes: this one would stay green if the reference drifted, and
 * that one would stay green if the product code did. What they catch together is the fault a
 * single implementation cannot - code that reads its own output perfectly and is wrong in a
 * way only a second reader would notice. The third reader is CryptoKit, run by hand.
 */
describe('the committed cross-platform vectors', () => {
  const v = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'dev', 'e2e-vectors', 'rule-vectors.json'), 'utf8')
  )
  const un = (s: string): Buffer => Buffer.from(s, 'base64url')
  const phone = v.devices[0]
  const boatSide = { inboxPriv: un(v.boat_inbox.private), inboxPub: un(v.boat_inbox.public) }

  it('builds the committed proof input', () => {
    expect(proofInput({ ...v.write, boat: v.boat }).toString('hex')).toBe(
      v.expected_proof_input_hex
    )
  })

  it('makes the committed proof, and accepts it', () => {
    expect(
      makeRuleProof({
        req: v.write,
        boat: v.boat,
        devicePriv: un(phone.private),
        devicePub: un(phone.public),
        inboxPub: un(v.boat_inbox.public)
      })
    ).toBe(v.write.proof)
    expect(
      verifyRuleProof({ req: v.write, boat: v.boat, ...boatSide, devicePub: un(phone.public) })
    ).toBe(true)
  })

  it.each(Object.keys(v.must_not_verify as Record<string, unknown>))('refuses %s', (name) => {
    expect(
      verifyRuleProof({
        req: v.must_not_verify[name],
        boat: v.boat,
        ...boatSide,
        devicePub: un(phone.public)
      })
    ).toBe(false)
  })

  it('refuses the same write presented at another vessel', () => {
    expect(
      verifyRuleProof({
        req: v.other_boat.write,
        boat: v.other_boat.boat,
        ...boatSide,
        devicePub: un(phone.public)
      })
    ).toBe(false)
  })

  it('takes the committed list, so the vector is a list she would really store', async () => {
    // A vector that proved only the arithmetic would pass on a list the boat refuses, and the
    // phone would ship against bytes she never accepts.
    const store = new AlertRuleStore(dir)
    expect(await store.apply(v.write, v.write.ts)).toBeUndefined()
    expect(store.rules()).toEqual(v.write.rules)
    expect(store.rings('notifications.tanks.blackWater.0.currentLevel', 'alarm')).toBe(false)
    expect(store.rings('notifications.tanks.bilge.0.currentLevel', 'warning')).toBe(false)
    expect(store.rings('notifications.tanks.bilge.0.currentLevel', 'alarm')).toBe(true)
  })
})

/**
 * Two writes arriving together.
 *
 * The replay floor is a check against the stored timestamp followed by a disk write, and a
 * disk write yields. Nothing about the socket serialises these: every message starts its own
 * promise. So this is not a tidiness test - it is the floor itself, measured under the one
 * condition that defeats an unguarded version of it.
 */
describe('two writes in the same moment', () => {
  const now = 1_753_142_400_000

  it('lets the newer list win however the disk finishes them', async () => {
    // The attack: a carrier holds a sealed write it captured earlier - it cannot read it, but
    // it can deliver it - and releases it alongside the owner's newer one. Unguarded, both
    // read the floor before either raised it and the older list lands last.
    const store = new AlertRuleStore(dir)
    const phone = device()
    const older = write(phone, { ts: now, id: 'old', rules: [{ path: TANK, ring_from: 'never' }] })
    const newer = write(phone, { ts: now + 1, id: 'new', rules: [{ path: BILGE, ring_from: 'alarm' }] })

    const [newVerdict, oldVerdict] = await Promise.all([
      store.apply(newer, now + 1),
      store.apply(older, now + 1)
    ])

    expect(newVerdict).toBeUndefined()
    expect(oldVerdict?.code).toBe('STALE')
    expect(store.rules()).toEqual([{ path: BILGE, ring_from: 'alarm' }])
    // The floor must not have been dragged backwards, or every write the carrier captured
    // between the two timestamps becomes replayable at leisure.
    expect(store.ts()).toBe(now + 1)
    expect(store.rings(TANK, 'alarm')).toBe(true)

    // And what is on disk is what she is going by, not whichever rename finished last.
    await store.flush()
    const reloaded = new AlertRuleStore(dir)
    reloaded.load()
    expect(reloaded.rules()).toEqual([{ path: BILGE, ring_from: 'alarm' }])
    expect(reloaded.ts()).toBe(now + 1)
  })

  it('does not let one failed write poison the ones behind it', async () => {
    const store = new AlertRuleStore(dir)
    const phone = device()
    const [bad, good] = await Promise.all([
      store.apply(write(phone, { ts: now, rules: [{ path: 'not.a.notification', ring_from: 'never' }] }), now),
      store.apply(write(phone, { ts: now + 1 }), now + 1)
    ])
    expect(bad?.code).toBe('BAD_RULES')
    expect(good).toBeUndefined()
    expect(store.rules()).toEqual([{ path: TANK, ring_from: 'never' }])
  })
})
