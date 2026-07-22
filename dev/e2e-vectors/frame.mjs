/**
 * Reference implementation of the sealed telemetry frame, boat side.
 *
 * This is not the shipping code. It exists so the primitive set can be fixed
 * before a line of transport is written: the boat runs Node, the phone runs
 * CryptoKit, and a mismatch between them is only discovered by making both
 * agree on the same bytes. Whatever survives here goes into the spec; whatever
 * does not is cheaper to lose now than after two clients depend on it.
 *
 * Shape of one frame:
 *
 *   cleartext   version, boat id, timestamp, ephemeral public key
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

/** Domain separation, so a key derived here can never be mistaken for one derived elsewhere. */
const KEY_WRAP_INFO = 'siparu/frame-key/v1'
const SIGNING_PREFIX = 'siparu-frame-v1\0'

/**
 * The nonce for a key wrap is fixed at twelve zero bytes, and that is safe here
 * for one reason only: the wrapping key is derived from an ephemeral key pair
 * generated for this frame alone, so the key/nonce pair cannot repeat. Reuse an
 * ephemeral key across two frames and this becomes a catastrophic bug rather
 * than an economy, which is why the ephemeral pair is generated inside sealFrame
 * and never passed in from outside except by the vector generator.
 */
const WRAP_NONCE = Buffer.alloc(12, 0)

export const b64u = (buf) => Buffer.from(buf).toString('base64url')
export const unb64u = (str) => Buffer.from(str, 'base64url')

/** Length-prefixed field, so no two different frames can produce the same signing input. */
function lp(buf) {
  const b = Buffer.from(buf)
  const head = Buffer.alloc(2)
  head.writeUInt16BE(b.length)
  return Buffer.concat([head, b])
}

function u64be(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

/**
 * The exact bytes the boat signs and the relay verifies.
 *
 * Built from raw fields with explicit lengths rather than from re-serialised
 * JSON: two JSON encoders that disagree about key order or spacing would break
 * every signature, and the two encoders here are written in different languages.
 */
export function signingInput(frame) {
  const parts = [
    Buffer.from(SIGNING_PREFIX, 'utf8'),
    Buffer.from([frame.v]),
    lp(Buffer.from(frame.boat, 'utf8')),
    u64be(frame.ts),
    lp(unb64u(frame.eph)),
    lp(unb64u(frame.nonce)),
    lp(unb64u(frame.body))
  ]
  const count = Buffer.alloc(2)
  count.writeUInt16BE(frame.keys.length)
  parts.push(count)
  for (const k of frame.keys) {
    parts.push(lp(Buffer.from(k.kid, 'utf8')), lp(unb64u(k.wrap)))
  }
  return Buffer.concat(parts)
}

/** Raw 32-byte public key of an X25519 or Ed25519 key object. */
export function rawPublic(key) {
  return unb64u(key.export({ format: 'jwk' }).x)
}

/** Raw 32-byte private scalar (X25519) or seed (Ed25519) of a key object. */
export function rawPrivate(key) {
  return unb64u(key.export({ format: 'jwk' }).d)
}

export function x25519PublicFromRaw(raw) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) },
    format: 'jwk'
  })
}

export function x25519PrivateFromRaw(rawPriv, rawPub) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64u(rawPub), d: b64u(rawPriv) },
    format: 'jwk'
  })
}

export function ed25519PublicFromRaw(raw) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) },
    format: 'jwk'
  })
}

export function ed25519PrivateFromRaw(rawPriv, rawPub) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b64u(rawPub), d: b64u(rawPriv) },
    format: 'jwk'
  })
}

/**
 * Derive the key that wraps the content key for one device.
 *
 * The salt is the ephemeral public key and the info binds the derivation to
 * this device's key id, so two devices on the same frame never share a
 * wrapping key even though they share an ephemeral pair.
 */
export function wrapKeyFor(sharedSecret, ephPub, kid) {
  return Buffer.from(
    hkdfSync('sha256', sharedSecret, ephPub, Buffer.from(`${KEY_WRAP_INFO}/${kid}`, 'utf8'), 32)
  )
}

function aead(key, nonce, plaintext, aad) {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  if (aad) c.setAAD(aad)
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([ct, c.getAuthTag()])
}

function unaead(key, nonce, sealed, aad) {
  const ct = sealed.subarray(0, sealed.length - 16)
  const tag = sealed.subarray(sealed.length - 16)
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  if (aad) d.setAAD(aad)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

/**
 * Seal one frame for a set of devices and sign it.
 *
 * `devices` are the raw X25519 public keys the account has authorised, each
 * with the key id the relay knows it by. `identity` is the boat's Ed25519
 * private key. `ephemeral` is only ever passed by the vector generator, which
 * needs a fixed frame to commit; production generates it per frame.
 */
export function sealFrame({ boat, ts, plaintext, devices, identity, ephemeral, bodyNonce }) {
  const eph = ephemeral ?? generateKeyPairSync('x25519')
  const ephPub = rawPublic(eph.publicKey)
  const cek = randomBytes(32)
  const nonce = bodyNonce ?? randomBytes(12)

  const keys = devices.map((d) => {
    const shared = diffieHellman({
      privateKey: eph.privateKey,
      publicKey: x25519PublicFromRaw(d.pub)
    })
    const wk = wrapKeyFor(shared, ephPub, d.kid)
    return { kid: d.kid, wrap: b64u(aead(wk, WRAP_NONCE, cek, null)) }
  })

  const frame = {
    v: FRAME_VERSION,
    boat,
    ts,
    eph: b64u(ephPub),
    nonce: b64u(nonce),
    body: b64u(aead(cek, nonce, Buffer.from(plaintext, 'utf8'), null)),
    keys
  }
  frame.sig = b64u(sign(null, signingInput(frame), identity))
  return frame
}

/** What the relay can do without any ability to read: confirm the boat sent this, unaltered. */
export function verifyFrame(frame, boatIdentityPub) {
  return verify(null, signingInput(frame), boatIdentityPub, unb64u(frame.sig))
}

/** What a device can do that the relay cannot: read it. */
export function openFrame(frame, kid, devicePrivRaw, devicePubRaw) {
  const entry = frame.keys.find((k) => k.kid === kid)
  if (!entry) throw new Error(`no wrapped key for device ${kid}`)
  const shared = diffieHellman({
    privateKey: x25519PrivateFromRaw(devicePrivRaw, devicePubRaw),
    publicKey: x25519PublicFromRaw(unb64u(frame.eph))
  })
  const wk = wrapKeyFor(shared, unb64u(frame.eph), kid)
  const cek = unaead(wk, WRAP_NONCE, unb64u(entry.wrap), null)
  return unaead(cek, unb64u(frame.nonce), unb64u(frame.body), null).toString('utf8')
}
