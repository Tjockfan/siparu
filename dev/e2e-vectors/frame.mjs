/**
 * Reference implementation of the sealed telemetry frame, boat side.
 *
 * This is not the shipping code. It exists so the primitive set and the wire
 * format can be fixed before a line of transport is written: the boat runs
 * Node, the phone runs CryptoKit, and a mismatch between them is only
 * discovered by making both agree on the same bytes. Whatever survives here
 * goes into the spec; whatever does not is cheaper to lose now than after two
 * clients depend on it.
 *
 * It is deliberately a separate implementation from plugin/src/sealing.ts
 * rather than an import of it. Two implementations agreeing on committed
 * vectors is the property being tested, and it catches the class of fault a
 * single implementation never can: code that reads its own output perfectly
 * and is wrong in a way only a second reader would notice.
 *
 * Shape of one frame:
 *
 *   cleartext   version, boat id, timestamp, ephemeral public key, extensions
 *   sealed      one content key per authorised device, wrapped to that device
 *   sealed      the body, encrypted once under that content key
 *   signed      everything above, by the boat's long-lived identity key
 *
 * The content key is encrypted once and wrapped many times, rather than the
 * body being encrypted once per device: a boat with three screens sends one
 * body and three short wraps, not three bodies.
 *
 * Confidentiality and proof are separate layers on purpose. The encryption
 * keeps the relay from reading the frame; the signature is what lets it say
 * the frame arrived when it did and was not altered. Neither substitutes for
 * the other, and the signature covers the ciphertext, not the plaintext, so a
 * relay that cannot read a frame can still verify it.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify
} from 'node:crypto'

export const FRAME_VERSION = 1
export const MAX_DEVICES = 5

const KEY_WRAP_INFO = 'siparu/frame-key/v1'
const SIGNING_PREFIX = 'siparu-frame-v1\0'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const SIG_BYTES = 64

const KNOWN_FIELDS = new Set(['v', 'boat', 'ts', 'eph', 'nonce', 'body', 'keys', 'sig'])

export const b64u = (buf) => Buffer.from(buf).toString('base64url')

/**
 * Decode base64url, refusing any spelling but the canonical one.
 *
 * Node's decoder ignores characters outside the alphabet and accepts
 * non-canonical trailing bits, so many different strings decode to identical
 * bytes. Because the signature is computed over decoded bytes, a forgiving
 * decoder lets anyone in the middle rewrite a frame's text while keeping the
 * signature valid, and splits this implementation from Foundation's, which
 * rejects what Node accepts.
 */
export function strictDecode(value, expectedBytes) {
  if (typeof value !== 'string') throw new Error('expected a base64url string')
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('base64url field has invalid characters')
  const buf = Buffer.from(value, 'base64url')
  if (buf.toString('base64url') !== value) throw new Error('base64url field is not canonical')
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes, got ${buf.length}`)
  }
  return buf
}

/**
 * Length-prefixed field, so no two different values can produce the same
 * signing input. Thirty-two bits, because the same envelope will carry history
 * answers and a snapshot page runs to hundreds of kilobytes.
 */
function lp(buf) {
  const b = Buffer.from(buf)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(b.length)
  return Buffer.concat([head, b])
}

function u16be(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

function u64be(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

/**
 * Extension fields in canonical order. A later version can add a cleartext
 * field, the alarm severity flag first among them, and have it signed without
 * this function changing. Outside the signature such a field could be
 * rewritten in transit: an alarm downgraded to normal swallows the push.
 */
function extensionEntries(frame) {
  const out = []
  for (const key of Object.keys(frame).sort()) {
    if (KNOWN_FIELDS.has(key)) continue
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`extension field ${key} is not a legal name`)
    if (typeof frame[key] !== 'string') throw new Error(`extension field ${key} must be a string`)
    out.push([key, frame[key]])
  }
  return out
}

/** The exact bytes the boat signs and the relay verifies. */
export function signingInput(frame) {
  if (!Number.isInteger(frame.v) || frame.v < 0 || frame.v > 0xffff) {
    throw new Error('frame version must be an integer that fits sixteen bits')
  }
  if (!Number.isInteger(frame.ts) || frame.ts < 0) {
    throw new Error('frame timestamp must be a non-negative integer')
  }
  if (typeof frame.boat !== 'string') throw new Error('frame boat id must be a string')
  if (!Array.isArray(frame.keys)) throw new Error('frame keys must be an array')

  const parts = [
    Buffer.from(SIGNING_PREFIX, 'utf8'),
    u16be(frame.v),
    lp(Buffer.from(frame.boat, 'utf8')),
    u64be(frame.ts),
    lp(strictDecode(frame.eph, KEY_BYTES)),
    lp(strictDecode(frame.nonce, NONCE_BYTES)),
    lp(strictDecode(frame.body))
  ]

  parts.push(u16be(frame.keys.length))
  const seen = new Set()
  for (const k of frame.keys) {
    if (typeof k?.kid !== 'string' || k.kid.length === 0) throw new Error('wrapped key needs a kid')
    if (seen.has(k.kid)) throw new Error(`duplicate key id ${k.kid}`)
    seen.add(k.kid)
    parts.push(lp(Buffer.from(k.kid, 'utf8')), lp(strictDecode(k.wrap)))
  }

  const ext = extensionEntries(frame)
  parts.push(u16be(ext.length))
  for (const [key, value] of ext) {
    parts.push(lp(Buffer.from(key, 'utf8')), lp(Buffer.from(value, 'utf8')))
  }
  return Buffer.concat(parts)
}

/** Raw 32-byte public key of an X25519 or Ed25519 key object. */
export function rawPublic(key) {
  return Buffer.from(key.export({ format: 'jwk' }).x, 'base64url')
}

/** Raw 32-byte private scalar (X25519) or seed (Ed25519). */
export function rawPrivate(key) {
  return Buffer.from(key.export({ format: 'jwk' }).d, 'base64url')
}

export function x25519PublicFromRaw(raw) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) }, format: 'jwk' })
}

export function x25519PrivateFromRaw(rawPriv, rawPub) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64u(rawPub), d: b64u(rawPriv) },
    format: 'jwk'
  })
}

export function ed25519PublicFromRaw(raw) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' })
}

export function ed25519PrivateFromRaw(rawPriv, rawPub) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b64u(rawPub), d: b64u(rawPriv) },
    format: 'jwk'
  })
}

/**
 * Derive the key and nonce that wrap the content key for one device.
 *
 * Bound to the boat, the timestamp and the device's key id, so that two
 * devices on one frame never derive the same wrapping key and two frames never
 * do either. The nonce is derived rather than fixed at zero: zero would be
 * sound while every frame has a fresh ephemeral pair, but that rests entirely
 * on the random number generator, and a cloned SD card or a restored virtual
 * machine brings its state back. Deriving costs nothing and removes the single
 * point of failure.
 */
export function wrapSecrets(shared, ephPub, boat, ts, kid) {
  const info = Buffer.from(`${KEY_WRAP_INFO}/${boat}/${ts}/${kid}`, 'utf8')
  const out = Buffer.from(hkdfSync('sha256', shared, ephPub, info, KEY_BYTES + NONCE_BYTES))
  return { key: out.subarray(0, KEY_BYTES), nonce: out.subarray(KEY_BYTES) }
}

function aead(key, nonce, plaintext) {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([ct, c.getAuthTag()])
}

function unaead(key, nonce, sealed) {
  if (sealed.length < TAG_BYTES) throw new Error('sealed value is too short to hold a tag')
  const ct = sealed.subarray(0, sealed.length - TAG_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

/**
 * Seal one frame for a set of devices and sign it.
 *
 * `devices` are the raw X25519 public keys the account has authorised, each
 * with the key id the relay knows it by. `identity` is the boat's Ed25519
 * private key. `ephemeral` and `bodyNonce` are passed only by the vector
 * generator, which needs a fixed frame to commit; a boat generates both per
 * frame and never accepts them from a caller.
 */
export function sealFrame({
  boat,
  ts,
  plaintext,
  devices,
  identity,
  ephemeral,
  bodyNonce,
  extensions
}) {
  if (devices.length === 0) throw new Error('cannot seal a frame with no authorised devices')
  if (devices.length > MAX_DEVICES) throw new Error(`cannot seal to more than ${MAX_DEVICES} devices`)
  const eph = ephemeral ?? generateKeyPairSync('x25519')
  const ephPub = rawPublic(eph.publicKey)
  const cek = randomBytes(KEY_BYTES)
  const nonce = bodyNonce ?? randomBytes(NONCE_BYTES)

  const keys = devices.map((d) => {
    const shared = diffieHellman({
      privateKey: eph.privateKey,
      publicKey: x25519PublicFromRaw(d.pub)
    })
    const { key, nonce: wrapNonce } = wrapSecrets(shared, ephPub, boat, ts, d.kid)
    return { kid: d.kid, wrap: b64u(aead(key, wrapNonce, cek)) }
  })

  const frame = {
    v: FRAME_VERSION,
    boat,
    ts,
    eph: b64u(ephPub),
    nonce: b64u(nonce),
    body: b64u(aead(cek, nonce, Buffer.from(plaintext, 'utf8'))),
    keys,
    ...(extensions ?? {})
  }
  frame.sig = b64u(sign(null, signingInput(frame), identity))
  return frame
}

/**
 * What the relay can do without any ability to read: confirm the boat sent
 * this, unaltered. Answers false on a malformed frame rather than throwing,
 * because it runs on input from parties that have not been trusted yet.
 */
export function verifyFrame(frame, boatIdentityPub) {
  if (typeof frame !== 'object' || frame === null) return false
  try {
    const sig = strictDecode(frame.sig, SIG_BYTES)
    const { sig: _omit, ...unsigned } = frame
    if (unsigned.keys.length > MAX_DEVICES) return false
    return verify(null, signingInput(unsigned), boatIdentityPub, sig)
  } catch {
    return false
  }
}

/**
 * What only an authorised device can do: read it.
 *
 * The signature is checked here too, by the reader rather than only by the
 * relay. Decryption alone says nothing about `ts`, which travels in the open:
 * a relay that kept an old frame, moved its timestamp to now and passed it on
 * unchanged would leave a device showing a stale position as current.
 */
export function openFrame(frame, boatIdentityPub, kid, devicePrivRaw, devicePubRaw) {
  if (!verifyFrame(frame, boatIdentityPub)) throw new Error('frame signature does not verify')
  if (frame.v !== FRAME_VERSION) throw new Error(`unsupported frame version ${frame.v}`)
  const entry = frame.keys.find((k) => k.kid === kid)
  if (!entry) throw new Error(`frame carries no wrapped key for device ${kid}`)
  const ephPub = strictDecode(frame.eph, KEY_BYTES)
  const shared = diffieHellman({
    privateKey: x25519PrivateFromRaw(devicePrivRaw, devicePubRaw),
    publicKey: x25519PublicFromRaw(ephPub)
  })
  const { key, nonce } = wrapSecrets(shared, ephPub, frame.boat, frame.ts, kid)
  const cek = unaead(key, nonce, strictDecode(entry.wrap))
  return unaead(cek, strictDecode(frame.nonce, NONCE_BYTES), strictDecode(frame.body)).toString(
    'utf8'
  )
}
