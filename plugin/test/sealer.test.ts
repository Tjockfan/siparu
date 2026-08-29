import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DevicePublicKey } from '../src/contract'
import { BoatKeyStore } from '../src/keystore'
import { Sealer } from '../src/sealer'
import { openFrame, rawPublic, verifyFrame } from '../src/sealing'
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

  it('puts nothing readable on the wire', () => {
    const verdict = sealer([device('kid-phone').wire]).s.seal(FRAME)
    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return
    // The position digits are checked against the whole wire: base64url has no dot, so
    // "43.55" can only appear as a number that leaked in the clear.
    expect(JSON.stringify(verdict)).not.toContain('43.55')
    // The field names are not: ciphertext is uniform random bytes, and about one frame in
    // five hundred spells "lat" or "sog" somewhere inside its base64 (measured; this test
    // used to go red on it). The claim is about the cleartext surface, so the sealed blobs
    // are blanked - their unreadability is proven end to end by the opening test above,
    // and the field list itself is pinned by the one below.
    const { body: _b, eph: _e, nonce: _n, sig: _s, keys: wrapped, ...clear } = verdict.frame
    const readable = JSON.stringify({ ...clear, kids: wrapped.map((k) => k.kid) })
    expect(readable).not.toContain('lat')
    expect(readable).not.toContain('sog')
  })

  it('sends exactly the eight frame fields and not one more', () => {
    // The whole cleartext surface of a live report, pinned. A field added here is a field
    // the carrier can read, and it must cost a deliberate edit of this list to add one.
    const verdict = sealer([device('kid-phone').wire]).s.seal(FRAME)
    expect(verdict.mode).toBe('sealed')
    if (verdict.mode !== 'sealed') return
    expect(Object.keys(verdict.frame).sort()).toEqual([
      'boat',
      'body',
      'eph',
      'keys',
      'nonce',
      'sig',
      'ts',
      'v'
    ])
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

  it('reports the screen a sealed frame left out, and heals when the list does', () => {
    // The debug complaint was the only place these went, and it is off by default. The
    // health surface reads this instead, so the answer survives the log being off.
    const good = device('kid-good')
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    const list = [good.wire, bad]
    const { s } = sealer(list)

    expect(s.rejections()).toEqual([])
    s.seal(FRAME)
    expect(s.rejections()).toEqual([{ kid: 'kid-bad', reason: expect.any(String) }])

    // The shore withdraws the broken row; the next frame wraps to everyone it names.
    list.pop()
    s.seal(FRAME)
    expect(s.rejections()).toEqual([])
  })

  it('reports a duplicate key id as the duplicate it is', () => {
    // The database refuses duplicates ashore, so one arriving here is the carrier's own
    // work - exactly the row worth a name on the health surface.
    const phone = device('kid-phone')
    const twin: DevicePublicKey = { kid: 'kid-phone', pub: device('kid-x').wire.pub }
    const { s } = sealer([phone.wire, twin])
    s.seal(FRAME)
    expect(s.rejections()).toEqual([
      { kid: 'kid-phone', reason: expect.stringContaining('duplicate') }
    ])
  })

  it('clears the rejections when she stops sealing: they describe a frame that went out', () => {
    const good = device('kid-good')
    const bad: DevicePublicKey = { kid: 'kid-bad', pub: 'A'.repeat(43) }
    const list = [good.wire, bad]
    const { s } = sealer(list, { latched: true })

    s.seal(FRAME)
    expect(s.rejections()).toHaveLength(1)

    // Everyone withdrawn: she is blocked, no frame goes out, and a list describing the
    // last one that did would be a stale answer to a different question.
    list.length = 0
    expect(s.seal(FRAME).mode).toBe('blocked')
    expect(s.rejections()).toEqual([])
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

