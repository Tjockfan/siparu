/**
 * Reference implementation of the sealed question, shore to boat.
 *
 * Not the shipping code and not an import of it. The question travels the other
 * way from a frame and is opened by the one party that never opens a frame: the
 * boat. Two implementations seal one (the phone in CryptoKit, the browser in
 * WebCrypto) and one opens it (the plugin in Node), and none of the three shares
 * a line with this file. A drift in the derivation on the opening side leaves
 * every sealer's own tests green, because none of them ever opens what it
 * sealed; this reference and the committed vectors are what turn it red.
 *
 * Shape of one question:
 *
 *   type  "ask"                   for the relay, which routes by shape and cannot read the rest
 *   v     1
 *   id    cleartext               the relay routes the answer back by it
 *   eph   32 bytes, base64url     ephemeral X25519 public key, this question only
 *   body  ciphertext || tag       the request, under ChaCha20-Poly1305
 *
 *   key || nonce = HKDF-SHA256(
 *       ikm  = X25519(eph_priv, inbox_pub),
 *       salt = eph_pub,
 *       info = "siparu/request-key/v1/<boat>/<id>",
 *       len  = 44)
 *
 * No signature: a device holds no signing key, and opening a question proves
 * only that the sender knew a public key. No wrap: one body goes to one boat.
 * The boat and the id are bound into the derivation rather than carried, so a
 * question captured on its way to one vessel derives nothing at another, and a
 * carrier that rewrote the id costs itself the plaintext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync
} from 'node:crypto'

export const REQUEST_VERSION = 1
export const REQUEST_KEY_INFO = 'siparu/request-key/v1'

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** Decode base64url and insist the text was the canonical spelling of the bytes it carries. */
function strictDecode(value, expectedBytes) {
  if (typeof value !== 'string') throw new Error('expected a base64url string')
  const out = Buffer.from(value, 'base64url')
  if (b64u(out) !== value) throw new Error('not canonical base64url')
  if (expectedBytes !== undefined && out.length !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes, got ${out.length}`)
  }
  return out
}

const xPriv = (raw, pub) =>
  createPrivateKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'X25519', d: raw.toString('base64url'), x: pub.toString('base64url') }
  })
const xPub = (raw) =>
  createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') } })

/** The one derivation both ends have to agree on, written out here on its own. */
export function requestSecrets(shared, ephPub, boat, id) {
  const info = `${REQUEST_KEY_INFO}/${boat}/${id}`
  const out = Buffer.from(hkdfSync('sha256', shared, ephPub, info, KEY_BYTES + NONCE_BYTES))
  return { key: out.subarray(0, KEY_BYTES), nonce: out.subarray(KEY_BYTES) }
}

/** The device's side: seal one question to a boat's inbox. */
export function sealRequest({ boat, id, plaintext, inbox }) {
  if (inbox.length !== KEY_BYTES) throw new Error('inbox public key must be 32 bytes')
  if (typeof id !== 'string' || id.length === 0) throw new Error('a question needs an id')
  const eph = generateKeyPairSync('x25519')
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url')
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: xPub(inbox) })
  const { key, nonce } = requestSecrets(shared, ephPub, boat, id)
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()])
  return {
    type: 'ask',
    v: REQUEST_VERSION,
    id,
    eph: b64u(ephPub),
    body: b64u(Buffer.concat([ct, c.getAuthTag()]))
  }
}

/** The boat's side: open a question addressed to her, or throw. */
export function openRequest(envelope, boat, inboxPrivRaw, inboxPubRaw) {
  if (!envelope || typeof envelope !== 'object') throw new Error('not a request envelope')
  if (envelope.type !== 'ask') throw new Error('not a question')
  if (envelope.v !== REQUEST_VERSION) throw new Error(`unsupported request version ${envelope.v}`)
  if (typeof envelope.id !== 'string' || envelope.id.length === 0) {
    throw new Error('request id must be a string')
  }
  const ephPub = strictDecode(envelope.eph, KEY_BYTES)
  const sealed = strictDecode(envelope.body)
  if (sealed.length < TAG_BYTES) throw new Error('body is too short to hold a tag')
  const shared = diffieHellman({
    privateKey: xPriv(inboxPrivRaw, inboxPubRaw),
    publicKey: xPub(ephPub)
  })
  const { key, nonce } = requestSecrets(shared, ephPub, boat, envelope.id)
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_BYTES)), d.final()]).toString(
    'utf8'
  )
}
