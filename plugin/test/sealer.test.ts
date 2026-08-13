import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DevicePublicKey } from '../src/contract'
import { BoatKeyStore } from '../src/keystore'
import { Sealer } from '../src/sealer'
import { MAX_DEVICES, openFrame, publicFromPrivate, rawPrivate, rawPublic, verifyFrame } from '../src/sealing'
import { makeRuleProof, type ParsedRuleWrite } from '../src/alertrules'
import { generateKeyPairSync } from 'crypto'

/**
 * How a report leaves this boat, which is sealed or not at all.
 *
 * The interesting cases are all on one side of it: what she does when something is wrong.
 * A boat that quietly fell back to cleartext would look identical from the bridge to one
 * that never sealed at all, and nobody would find out until it mattered. There is no longer
 * a branch that could do it, and the tests here are what keep one from growing back.
 */

let dir: string
let keys: BoatKeyStore

/** A screen, with the private half kept here so a test can actually read what she sent. */
function device(kid: string) {
  const pair = generateKeyPairSync('x25519')
  return {
    kid,
    priv: pair.privateKey,
    pub: rawPublic(pair.publicKey),
    wire: { kid, pub: rawPublic(pair.publicKey).toString('base64url') } as DevicePublicKey
  }
}

function sealer(
  devices: DevicePublicKey[],
  over: { boatId?: string | undefined; latched?: boolean } = {}
) {
  const said: string[] = []
  const s = new Sealer({
    keys,
    devices: () => devices,
    // A vessel that has never been told anybody is watching, unless a case says otherwise.
    latched: () => over.latched ?? false,
    boatId: () => ('boatId' in over ? over.boatId : 'boat-0001'),
    debug: (m) => said.push(m)
  })
  return { s, said }
}

const FRAME = { ts: 1_753_142_400_000, lat: 43.5528, lon: 7.0174, sog: 6.2 }

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-sealer-'))
  keys = new BoatKeyStore(dir)
  keys.load()
  await keys.ensure()
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('deciding how a frame goes out', () => {
  it('sends nothing at all while nobody is authorised', () => {
    // The state every boat is in until her owner adds a screen. She used to report in the
    // clear here; now she keeps her own history and sends none of it, because there is
    // nobody who could be sent it privately.
    const verdict = sealer([]).s.seal(FRAME)
    expect(verdict.mode).toBe('blocked')
    if (verdict.mode === 'blocked') expect(verdict.reason).toContain('authorised')
  })

  it('seals to an authorised screen, and that screen can read it', () => {
    const phone = device('kid-phone')
    const verdict = sealer([phone.wire]).s.seal(FRAME)

    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return

    const identityPub = keys.get()!.identity
    // End to end: what she sent verifies as hers, and opens to exactly what she meant.
    expect(verifyFrame(verdict.frame, identityPub)).toBe(true)
    const opened = openFrame(
      verdict.frame,
      identityPub,
      phone.kid,
      Buffer.from(phone.priv.export({ format: 'jwk' }).d as string, 'base64url'),
      phone.pub
    )
    expect(JSON.parse(opened)).toEqual(FRAME)
  })

  it('carries how loud she is in the clear, and under her signature', () => {
    // The one field a carrier is meant to read, because it has to know a notification is due.
    // Signed rather than only carried alongside: that is what stops the carrier rewriting an
    // alarm to normal and swallowing the notification, so both halves are checked here.
    const phone = device('kid-phone')
    const verdict = sealer([phone.wire]).s.seal(FRAME, 'alarm')

    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return

    const identityPub = keys.get()!.identity
    expect(verdict.frame.alert).toBe('alarm')
    expect(verifyFrame(verdict.frame, identityPub)).toBe(true)
    // The downgrade a carrier would attempt, refused: the frame no longer verifies at all.
    expect(verifyFrame({ ...verdict.frame, alert: 'normal' }, identityPub)).toBe(false)
  })

  it('says nothing about severity when the caller names none', () => {
    // The frame path and the answer path both seal without one. An `alert` field that
    // appeared as undefined or empty would be a severity the shore has to interpret, and the
    // honest wire for "not stated" is no field at all.
    const verdict = sealer([device('kid-phone').wire]).s.seal(FRAME)
    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return
    expect('alert' in verdict.frame).toBe(false)
  })

  it('puts nothing readable on the wire', () => {
    const verdict = sealer([device('kid-phone').wire]).s.seal(FRAME)
    const wire = JSON.stringify(verdict)
    expect(wire).not.toContain('43.55')
    expect(wire).not.toContain('lat')
    expect(wire).not.toContain('sog')
  })

  it('seals one body to several screens rather than one body each', () => {
    const many = [device('a').wire, device('b').wire, device('c').wire]
    const verdict = sealer(many).s.seal(FRAME)

    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return
    expect(verdict.frame.keys.map((k) => k.kid)).toEqual(['a', 'b', 'c'])
  })

  it('keeps sealing when one screen carries an unusable key', () => {
    // The list is assembled ashore, over a channel the boat does not control. One bad row
    // in it must never take a vessel off the air; it takes one screen off, and says so.
    const good = device('kid-good')
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    const { s, said } = sealer([good.wire, bad])

    const verdict = s.seal(FRAME)
    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return
    expect(verdict.frame.keys.map((k) => k.kid)).toEqual(['kid-good'])
    expect(said.join(' ')).toContain('kid-bad')
  })

  it('sends NOTHING rather than falling back when no authorised screen can be sealed to', () => {
    // The load-bearing case. Screens are authorised, so somebody is expecting privacy; not
    // one of their keys can be used. Cleartext here would be a silent betrayal, and silence
    // is at least visible on her owner's screen.
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    expect(sealer([bad]).s.seal(FRAME).mode).toBe('blocked')
  })

  it('sends nothing when she has no id ashore', () => {
    expect(sealer([device('kid-phone').wire], { boatId: undefined }).s.seal(FRAME).mode).toBe(
      'blocked'
    )
  })

  it('sends nothing when she has no keys of her own', () => {
    const empty = new BoatKeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'siparu-nokeys-')))
    empty.load()
    const s = new Sealer({
      keys: empty,
      devices: () => [device('kid-phone').wire],
      latched: () => true,
      boatId: () => 'boat-0001',
      debug: () => {}
    })
    expect(s.seal(FRAME).mode).toBe('blocked')
  })

  it('complains once about the same bad key, not once per frame', () => {
    // This runs every couple of seconds. A log line per frame is a log nobody reads.
    const good = device('kid-good')
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    const { s, said } = sealer([good.wire, bad])

    s.seal(FRAME)
    s.seal(FRAME)
    s.seal(FRAME)

    expect(said).toHaveLength(1)
  })

  it('never hands the caller anything but a sealed frame or a refusal', () => {
    // The guard against a cleartext branch growing back. Every shape of trouble this class
    // knows about, and not one of them may answer with the frame it was given: an authorised
    // screen with a broken key, a boat with no id ashore, a boat with no keys of her own, and
    // the ordinary boat nobody has authorised yet.
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    const cases = [
      sealer([]).s,
      sealer([], { latched: true }).s,
      sealer([bad]).s,
      sealer([bad], { latched: true }).s,
      sealer([device('kid-phone').wire], { boatId: undefined }).s
    ]
    for (const s of cases) {
      const verdict = s.seal(FRAME)
      expect(verdict.mode).toBe('blocked')
      expect(JSON.stringify(verdict)).not.toContain('43.55')
    }
  })
})

/**
 * An empty list is not a way back onto the wire in the open.
 *
 * The device list arrives over a channel she does not control - a relay build that renamed a
 * field, a row deleted by an operator, a carrier that would rather read her - and every one
 * of those arrives as a list with nothing in it. What she does about it is the same in all
 * cases and it is silence; what changes is only what she says about it, so that a skipper
 * looking at a boat that has stopped reporting can tell which problem he has.
 */
describe('an empty list is silence, and it says which silence', () => {
  it('sends nothing when the screens she had are gone', () => {
    const verdict = sealer([], { latched: true }).s.seal(FRAME)

    expect(verdict.mode).toBe('blocked')
    // And it says why, because a boat that has gone quiet looks like a boat with no signal.
    // Worded for both ways of arriving here: her owner removed his screens, or every key the
    // shore sent was unusable and was dropped before it got this far.
    if (verdict.mode === 'blocked') expect(verdict.reason).toContain('no screen')
  })

  it('tells the two silences apart, because a skipper acts on them differently', () => {
    // One is a boat waiting to be given a screen; the other has lost the screens she had, and
    // the row ashore is where to look. The list is empty either way, so her own memory of
    // having been told is the only thing that can tell them apart.
    const first = sealer([]).s.seal(FRAME)
    const lost = sealer([], { latched: true }).s.seal(FRAME)
    if (first.mode !== 'blocked' || lost.mode !== 'blocked') throw new Error('expected silence')

    expect(first.reason).toContain('no screen has been authorised to read her yet')
    expect(lost.reason).not.toBe(first.reason)
    // And each names its own way out, because the screen showing this cannot work out which
    // cure applies: two of the four silences this class reports are not fixed by a screen.
    expect(first.reason).toMatch(/Add one/)
    expect(lost.reason).toMatch(/Authorise one again/)
  })

  it('reports what became of her last frame, for a screen that has to explain the silence', () => {
    // Blocked and disconnected are the same thing to look at: nothing arrives. The pairing
    // panel reports the socket as healthy, correctly, because the socket is healthy.
    const { s } = sealer([], { latched: true })
    expect(s.state()).toEqual({ mode: 'none', reason: null })

    s.seal(FRAME)
    expect(s.state().mode).toBe('blocked')
    expect(s.state().reason).toContain('no screen')

    const phone = device('kid-phone')
    const sealing = sealer([phone.wire], { latched: true })
    sealing.s.seal(FRAME)
    expect(sealing.s.state()).toEqual({ mode: 'sealed', reason: null })
  })

  it('answers a question with silence rather than in the clear', () => {
    // Her recorded past follows her present. An archive reply is a whole voyage rather than
    // one position, so a rule that only guarded live frames would leak the larger half.
    expect(sealer([], { latched: true }).s.answer({ rows: [] }, 'req-1').mode).toBe('blocked')
    expect(sealer([]).s.answer({ rows: [] }, 'req-1').mode).toBe('blocked')
  })
})

/**
 * The sentence a pocket gets.
 *
 * The body of a frame only reaches a screen somebody is looking at. The note is what reaches
 * a phone on a bedside table: the carrier lifts it out of the frame and hands it to Apple
 * without being able to read a word, and the device writes its own notification from it.
 * Everything here is about it arriving able to prove whose it is.
 */
describe('the sealed sentence a notification is written from', () => {
  const NOTE = {
    path: 'notifications.tanks.blackWater.0.currentLevel',
    state: 'alarm' as const,
    message: 'Holding tank is nearly full.',
    since: 1_753_142_000_000
  }

  /** The note as a device receives it: lifted out of the frame and parsed. */
  function noteFrameOf(frame: Record<string, unknown>) {
    expect(typeof frame.note).toBe('string')
    return JSON.parse(Buffer.from(frame.note as string, 'base64url').toString('utf8'))
  }

  it('travels sealed, signed as hers, and opens to the sentence', () => {
    const phone = device('kid-phone')
    const { s } = sealer([phone.wire])

    const verdict = s.seal(FRAME, 'alarm', NOTE)
    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return

    const identityPub = keys.get()!.identity
    const note = noteFrameOf(verdict.frame as unknown as Record<string, unknown>)

    // Alone on the push path it has to stand up by itself: her signature is what stops a
    // carrier writing its own sentence into somebody's notification.
    expect(verifyFrame(note, identityPub)).toBe(true)
    const opened = openFrame(
      note,
      identityPub,
      phone.kid,
      Buffer.from(phone.priv.export({ format: 'jwk' }).d as string, 'base64url'),
      phone.pub
    )
    expect(JSON.parse(opened)).toEqual(NOTE)
    // And it names the boat and the moment, so a carrier cannot replay yesterday's alarm.
    expect(note.boat).toBe('boat-0001')
    expect(typeof note.ts).toBe('number')
  })

  it('says nothing about which condition rang through its own length', () => {
    // Ciphertext length is the one thing about a note that a carrier and Apple can both
    // measure, and sentences differ enough between conditions to hint at which one it was.
    const phone = device('kid-phone')
    const { s } = sealer([phone.wire])

    const short = s.seal(FRAME, 'alarm', { ...NOTE, message: 'Low.' })
    const long = s.seal(FRAME, 'alarm', { ...NOTE, message: 'Holding tank is nearly full.' })
    if (short.mode !== 'sealed' || long.mode !== 'sealed') throw new Error('expected sealed')

    const a = noteFrameOf(short.frame as unknown as Record<string, unknown>)
    const b = noteFrameOf(long.frame as unknown as Record<string, unknown>)
    expect(a.body.length).toBe(b.body.length)
  })

  it('is absent while she is quiet', () => {
    // Sent while a bell is due and not otherwise. A note on every frame would be a steady
    // stream of ciphertext saying nothing, and one on a quiet boat would be a lie.
    const { s } = sealer([device('kid-phone').wire])
    const verdict = s.seal(FRAME, 'normal')
    if (verdict.mode !== 'sealed') throw new Error('expected sealed')
    expect((verdict.frame as unknown as Record<string, unknown>).note).toBeUndefined()
  })

  it('reaches every authorised screen, not only the first', () => {
    // The carrier passes the block on whole because the wraps are inside its signature. If
    // only one device were sealed to, the others would get a notification they cannot read.
    const one = device('kid-one')
    const two = device('kid-two')
    const { s } = sealer([one.wire, two.wire])

    const verdict = s.seal(FRAME, 'warning', NOTE)
    if (verdict.mode !== 'sealed') throw new Error('expected sealed')
    const note = noteFrameOf(verdict.frame as unknown as Record<string, unknown>)
    expect(note.keys.map((k: { kid: string }) => k.kid)).toEqual(['kid-one', 'kid-two'])
  })

  it('is left out rather than taking the frame down with it', () => {
    // A note that cannot be sealed costs a generic notification, which is what every
    // notification was until today. Refusing the frame would cost the owner her live screen.
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    const good = device('kid-good')
    const { s } = sealer([good.wire, bad])

    const verdict = s.seal(FRAME, 'alarm', NOTE)
    expect(verdict.mode).toBe('sealed')
  })
})

/**
 * The one write she takes, and the only question of authorisation she ever asks.
 *
 * Every other message from the shore is a read, and a read needs no proof: the answer is
 * sealed to her owner's screens whoever asked, so a stranger learns nothing from a reply he
 * cannot open. This is where that stops being true, because her inbox key is public.
 */
/** A write as a real device makes one, against this boat's actual inbox key. */
function ruleWrite(
  dev: ReturnType<typeof device>,
  over: { kid?: string; boat?: string; ts?: number } = {}
): ParsedRuleWrite {
  const req = {
    v: 1,
    id: 'req-1',
    kid: over.kid ?? dev.kid,
    ts: over.ts ?? 1_753_142_400_000,
    rules: [{ path: 'notifications.tanks.blackWater.0.currentLevel', ring_from: 'never' }]
  }
  const inbox = keys.get()
  if (!inbox) throw new Error('the boat has no keys')
  return {
    ...req,
    proof: makeRuleProof({
      req,
      boat: over.boat ?? 'boat-0001',
      devicePriv: rawPrivate(dev.priv),
      devicePub: dev.pub,
      inboxPub: publicFromPrivate(inbox.inbox)
    })
  }
}

describe('proving a rule write came from a screen she seals to', () => {
  it('accepts a write from a screen on her list', () => {
    const phone = device('kid-phone')
    expect(sealer([phone.wire]).s.proves(ruleWrite(phone))).toBe(true)
  })

  it('refuses a write from a device she has never been told about', () => {
    // Revocation, and it costs no machinery: a screen removed ashore loses the ability to
    // write within one key poll, exactly as it loses the ability to read.
    const phone = device('kid-phone')
    const removed = device('kid-removed')
    expect(sealer([phone.wire]).s.proves(ruleWrite(removed))).toBe(false)
  })

  it('refuses a write that borrows an authorised kid without its key', () => {
    // The attack the layer exists for: knowing a boat's inbox key and the id of one of her
    // screens must not be enough to silence her.
    const phone = device('kid-phone')
    const stranger = device('kid-stranger')
    expect(sealer([phone.wire]).s.proves(ruleWrite(stranger, { kid: phone.kid }))).toBe(false)
  })

  it('refuses a write proved against another vessel', () => {
    const phone = device('kid-phone')
    expect(sealer([phone.wire]).s.proves(ruleWrite(phone, { boat: 'boat-9999' }))).toBe(false)
  })

  it('refuses everything while she is not paired', () => {
    const phone = device('kid-phone')
    expect(sealer([phone.wire], { boatId: undefined }).s.proves(ruleWrite(phone))).toBe(false)
  })

  it('refuses a write when the shore list names the same device twice', () => {
    // Two rows with one kid and different keys is a question with no safe answer: taking
    // either would let a duplicate row ashore decide who may silence her.
    const phone = device('kid-phone')
    const twin = device('kid-phone')
    expect(sealer([phone.wire, twin.wire]).s.proves(ruleWrite(phone))).toBe(false)
  })
})

/**
 * Writing and reading are the same authority.
 *
 * A screen past the device ceiling receives no frames at all - sealFrame skips it and names it
 * in `rejected`. A device that cannot read a word she says has no business deciding when her
 * alarms are heard, and the two paths applying different ceilings is how that would happen.
 */
describe('the device ceiling applies to a write as well as a frame', () => {
  it('refuses a write from a screen past the ceiling that cannot read her frames', () => {
    const within = Array.from({ length: MAX_DEVICES }, (_, i) => device(`kid-${i}`))
    const beyond = device('kid-beyond')
    const list = [...within.map((d) => d.wire), beyond.wire]

    // First the premise: this screen really is shut out of the frames.
    const verdict = sealer(list).s.seal(FRAME)
    expect(verdict.mode).toBe('sealed')
    if (verdict.mode === 'sealed') {
      expect(verdict.frame.keys.map((k) => k.kid)).not.toContain('kid-beyond')
    }
    // And therefore it cannot silence her either.
    expect(sealer(list).s.proves(ruleWrite(beyond))).toBe(false)
    expect(sealer(list).s.proves(ruleWrite(within[0]))).toBe(true)
  })
})
