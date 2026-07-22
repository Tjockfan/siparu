/**
 * The shipping sealer, held to the same vectors as the reference.
 *
 * Two things are being proven here and they are not the same thing. First,
 * that this module agrees with the committed vectors, which is what makes it
 * agree with CryptoKit. Second, that a frame it produces itself can be opened
 * by the independent reference implementation, which is what catches the
 * failure the vectors alone cannot: a sealer that reads its own output
 * perfectly and is wrong in a way only another implementation would notice.
 */
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_DEVICES,
  type DeviceKey,
  type SealedFrame,
  ed25519PublicFromRaw,
  openFrame,
  rawPrivate,
  rawPublic,
  sealFrame,
  signingInput,
  verifyFrame,
  x25519PrivateFromRaw
} from '../src/sealing'
// @ts-expect-error - reference implementation, plain JS outside the build
import * as reference from '../../dev/e2e-vectors/frame.mjs'

const dir = join(__dirname, '..', '..', 'dev', 'e2e-vectors')
const v = JSON.parse(readFileSync(join(dir, 'vectors.json'), 'utf8'))
/** Key material out of the vector file, which is trusted input, not wire input. */
const un = (s: string): Buffer => Buffer.from(s, 'base64url')
const boatPub = ed25519PublicFromRaw(un(v.boat_identity.public))

describe('sealing, against the committed vectors', () => {
  it('builds the same signing input', () => {
    expect(signingInput(v.frame).toString('hex')).toBe(v.expected_signing_input_hex)
  })

  it('verifies a frame it did not seal', () => {
    expect(verifyFrame(v.frame, boatPub)).toBe(true)
  })

  it('opens a frame it did not seal, on every device', () => {
    for (const d of v.devices) {
      expect(openFrame(v.frame, boatPub, d.kid, un(d.private), un(d.public))).toBe(
        v.expected_plaintext
      )
    }
  })

  it.each(Object.keys(v.must_not_verify))('rejects a tampered frame: %s', (name) => {
    expect(verifyFrame(v.must_not_verify[name], boatPub)).toBe(false)
  })

  it('covers every attack the vector file carries', () => {
    // The vectors are the contract with the other two implementations. If one
    // is added there and this suite keeps passing without exercising it, the
    // guard has quietly narrowed.
    expect(Object.keys(v.must_not_verify).sort()).toEqual([
      'alert_downgraded',
      'body_bit_flipped',
      'body_whitespace',
      'eph_respelled',
      'ts_rewritten',
      'version_rewritten',
      'wraps_swapped'
    ])
  })
})

describe('sealing a fresh frame', () => {
  const identity = generateKeyPairSync('ed25519')
  const identityPub = ed25519PublicFromRaw(rawPublic(identity.publicKey))
  const devices: (DeviceKey & { priv: Buffer })[] = ['phone', 'tablet'].map((kid) => {
    const kp = generateKeyPairSync('x25519')
    return { kid, pub: rawPublic(kp.publicKey), priv: rawPrivate(kp.privateKey) }
  })
  const plaintext = JSON.stringify({ lat: 43.55, lon: 7.01, sog: 6.2 })
  const seal = (
    over: Partial<Parameters<typeof sealFrame>[0]> = {}
  ): ReturnType<typeof sealFrame> =>
    sealFrame({
      boat: 'boat-test',
      ts: 1_753_142_400_000,
      plaintext,
      devices: devices.map(({ kid, pub }) => ({ kid, pub })),
      identity: identity.privateKey,
      ...over
    })

  it('signs what it sealed', () => {
    expect(verifyFrame(seal().frame, identityPub)).toBe(true)
  })

  it('every authorised device can read it', () => {
    const { frame } = seal()
    for (const d of devices) {
      expect(openFrame(frame, identityPub, d.kid, d.priv, d.pub)).toBe(plaintext)
    }
  })

  it('the reference implementation can read it', () => {
    // The cross-check that matters: an implementation written separately opens
    // what this one sealed. Reading back one's own output proves only symmetry.
    const { frame } = seal()
    const d = devices[0]!
    expect(reference.openFrame(frame, identityPub, d.kid, d.priv, d.pub)).toBe(plaintext)
    expect(reference.verifyFrame(frame, identityPub)).toBe(true)
  })

  it('a device cannot read a wrap sealed to another', () => {
    const { frame } = seal()
    const [a, b] = devices as [(typeof devices)[0], (typeof devices)[0]]
    expect(() => openFrame(frame, identityPub, a.kid, b.priv, b.pub)).toThrow(/authenticate|decrypt|tag/i)
  })

  it('names the device when it holds no wrap at all', () => {
    // Distinct from the case above, and the comment on openFrame claims both.
    const { frame } = seal()
    const d = devices[0]!
    expect(() => openFrame(frame, identityPub, 'never-paired', d.priv, d.pub)).toThrow(
      /no wrapped key for device never-paired/
    )
  })

  it('never reuses an ephemeral key, a content key or a nonce', () => {
    const a = seal().frame
    const b = seal().frame
    expect(a.eph).not.toBe(b.eph)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.body).not.toBe(b.body)
    expect(a.keys[0]!.wrap).not.toBe(b.keys[0]!.wrap)
  })

  it('puts nothing on the wire but the boat, the time and the extensions', () => {
    const { frame } = seal({ extensions: { alert: 'warning' } })
    // Not a substring search: base64 hides any substring whether or not it is
    // encrypted, so a scan for "43.55" stays green with the cipher removed.
    // What actually distinguishes sealed from merely encoded is that the body
    // does not decode to legible content.
    const decoded = Buffer.from(frame.body, 'base64url').toString('utf8')
    expect(() => JSON.parse(decoded) as unknown).toThrow()
    expect(decoded).not.toContain('lat')
    // And the field list is pinned, so a later cleartext field cannot be added
    // without this test being read again. That is the point: the alarm flag is
    // already one such field, and each new one widens what the relay sees.
    expect(Object.keys(frame).sort()).toEqual([
      'alert',
      'boat',
      'body',
      'eph',
      'keys',
      'nonce',
      'sig',
      'ts',
      'v'
    ])
    expect(frame.boat).toBe('boat-test')
    expect(frame.ts).toBe(1_753_142_400_000)
  })

  it('signs its extension fields', () => {
    const { frame } = seal({ extensions: { alert: 'alarm' } })
    const downgraded = { ...frame, alert: 'normal' }
    expect(verifyFrame(downgraded, identityPub)).toBe(false)
  })

  it('refuses to seal a frame nobody can open', () => {
    expect(() => seal({ devices: [] })).toThrow(/no authorised device could open/)
  })

  it('seals to the ceiling and reports who was left out', () => {
    const many = Array.from({ length: MAX_DEVICES + 2 }, (_, i) => {
      const kp = generateKeyPairSync('x25519')
      return { kid: `d${i}`, pub: rawPublic(kp.publicKey) }
    })
    const { frame, rejected } = seal({ devices: many })
    // The boat keeps reporting rather than falling silent, which is what a
    // hard throw here would have caused the moment an account authorised one
    // device too many.
    expect(frame.keys).toHaveLength(MAX_DEVICES)
    expect(rejected.map((r) => r.kid)).toEqual([`d${MAX_DEVICES}`, `d${MAX_DEVICES + 1}`])
    expect(rejected[0]!.reason).toContain(String(MAX_DEVICES))
  })

  it('skips an unusable device key instead of silencing the boat', () => {
    // The device list is assembled ashore. One malformed or hostile public key
    // must not stop every other screen from receiving.
    const good = devices[0]!
    const { frame, rejected } = seal({
      devices: [
        { kid: 'broken', pub: Buffer.alloc(31) },
        { kid: 'hostile', pub: Buffer.alloc(32) },
        { kid: good.kid, pub: good.pub }
      ]
    })
    expect(frame.keys.map((k) => k.kid)).toEqual([good.kid])
    expect(rejected.map((r) => r.kid).sort()).toEqual(['broken', 'hostile'])
    expect(openFrame(frame, identityPub, good.kid, good.priv, good.pub)).toBe(plaintext)
  })

  it('skips a duplicate key id rather than sealing it twice', () => {
    const d = devices[0]!
    const { frame, rejected } = seal({
      devices: [
        { kid: d.kid, pub: d.pub },
        { kid: d.kid, pub: devices[1]!.pub }
      ]
    })
    expect(frame.keys).toHaveLength(1)
    expect(rejected[0]).toEqual({ kid: d.kid, reason: 'duplicate key id' })
  })
})

describe('verifying hostile input', () => {
  const identity = generateKeyPairSync('ed25519')
  const identityPub = ed25519PublicFromRaw(rawPublic(identity.publicKey))
  const { frame } = sealFrame({
    boat: 'boat-test',
    ts: 1_753_142_400_000,
    plaintext: '{}',
    devices: [{ kid: 'phone', pub: rawPublic(generateKeyPairSync('x25519').publicKey) }],
    identity: identity.privateKey
  })

  // The relay runs verifyFrame on input from clients that have not
  // authenticated. "This is not a valid frame" has to be an answer, not an
  // exception thrown inside a request handler.
  it.each([
    ['not an object', 42],
    ['null', null],
    ['missing signature', { ...frame, sig: undefined }],
    ['non-string boat', { ...frame, boat: null }],
    ['fractional timestamp', { ...frame, ts: 1.5 }],
    ['negative timestamp', { ...frame, ts: -1 }],
    ['version beyond sixteen bits', { ...frame, v: 70_000 }],
    ['string version', { ...frame, v: '1' }],
    ['keys not an array', { ...frame, keys: {} }],
    ['numeric kid', { ...frame, keys: [{ kid: 42, wrap: 'AA' }] }],
    ['duplicate kid', { ...frame, keys: [frame.keys[0], frame.keys[0]] }],
    ['more keys than the ceiling', { ...frame, keys: Array(MAX_DEVICES + 1).fill(frame.keys[0]) }],
    ['non-canonical signature', { ...frame, sig: `${frame.sig}=` }],
    ['illegal extension name', { ...frame, Alert: 'warning' }],
    ['non-string extension', { ...frame, alert: 7 }]
  ])('answers false rather than throwing: %s', (_name, bad) => {
    expect(verifyFrame(bad, identityPub)).toBe(false)
  })
})

describe('key material round-trips', () => {
  it('rebuilds a private key that agrees exactly as the original does', () => {
    // Reading the public half back out of the reconstructed key would prove
    // nothing: it is the value that was passed in. Agreement is what proves
    // the private scalar survived the trip.
    const mine = generateKeyPairSync('x25519')
    const theirs = generateKeyPairSync('x25519')
    const pub = rawPublic(mine.publicKey)
    const priv = rawPrivate(mine.privateKey)
    expect(pub).toHaveLength(32)
    expect(priv).toHaveLength(32)

    const { diffieHellman } = require('node:crypto') as typeof import('node:crypto')
    const original = diffieHellman({ privateKey: mine.privateKey, publicKey: theirs.publicKey })
    const rebuilt = diffieHellman({
      privateKey: x25519PrivateFromRaw(priv, pub),
      publicKey: theirs.publicKey
    })
    expect(rebuilt.equals(original)).toBe(true)
  })
})

describe('the frame type', () => {
  it('allows an extension field without a cast', () => {
    // The alarm severity flag has to be expressible, and a type that forbade
    // it would push every caller into `as unknown as`.
    const frame: SealedFrame = {
      v: 1,
      boat: 'b',
      ts: 1,
      eph: '',
      nonce: '',
      body: '',
      keys: [],
      sig: '',
      alert: 'warning'
    }
    expect(frame.alert).toBe('warning')
  })
})
