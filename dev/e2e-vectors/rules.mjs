/**
 * Reference implementation of the rule write proof, both sides.
 *
 * This is not the shipping code, and it is not an import of it. The property being tested is
 * that two implementations written independently agree on the same committed bytes, and that
 * catches the class of fault a single implementation never can: code that reads its own
 * output perfectly and is wrong in a way only a second reader would notice.
 *
 * What it fixes is the one message that travels in the other direction and is not a read. The
 * boat's inbox key is public, so a write accepted on the same terms as a read would let
 * anybody who knew it silence an owner's alarms. The proof is what closes that, and it is made
 * with the X25519 private half the device already holds to open her frames - no new credential
 * exists to be stolen, because whoever has that key is already reading every report she sends.
 *
 *   ikm   = X25519(device_priv, inbox_pub)       the boat computes the mirror,
 *                                                X25519(inbox_priv, device_pub)
 *   key   = HKDF-SHA256(ikm, salt = device_pub,
 *                       info = "siparu/rule-proof/v1/<boat>/<kid>/<id>", len = 32)
 *   proof = HMAC-SHA256(key, proofInput)
 *
 * The proof input is built from raw fields with explicit lengths rather than from re-serialised
 * JSON, for the same reason the frame signing input is: the implementations that have to agree
 * on these bytes are written in different languages, and a disagreement between their JSON
 * encoders about key order or spacing would refuse every write in the fleet at once.
 */
import { createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto'

export const RULE_PROOF_VERSION = 1

const PROOF_INFO = 'siparu/rule-proof/v1'
const PROOF_PREFIX = 'siparu/rule-proof/v1'
const KEY_BYTES = 32

const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** Length-prefixed field, four bytes of length, so no two values can produce the same bytes. */
function lp(buf) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(buf.length)
  return Buffer.concat([head, buf])
}

function u16be(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

function u32be(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function u64be(n) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

const utf8 = (s) => Buffer.from(s, 'utf8')

/**
 * The exact bytes both ends compute the proof over.
 *
 * Rules are covered in the order they were sent rather than sorted, so a carrier that
 * reordered them fails the check; that order is also the order the boat stores them in.
 */
export function proofInput({ v, boat, kid, id, ts, rules }) {
  const parts = [utf8(PROOF_PREFIX), u16be(v), lp(utf8(boat)), lp(utf8(kid)), lp(utf8(id)), u64be(ts), u32be(rules.length)]
  for (const rule of rules) parts.push(lp(utf8(rule.path)), lp(utf8(rule.ring_from)))
  return Buffer.concat(parts)
}

function x25519Private(priv, pub) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64u(pub), d: b64u(priv) },
    format: 'jwk'
  })
}

function x25519Public(raw) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) }, format: 'jwk' })
}

function proofKey(shared, devicePub, boat, kid, id) {
  const info = utf8(`${PROOF_INFO}/${boat}/${kid}/${id}`)
  return Buffer.from(hkdfSync('sha256', shared, devicePub, info, KEY_BYTES))
}

/** The device's side: prove this list was written by the holder of this device key. */
export function makeProof({ req, boat, devicePriv, devicePub, inboxPub }) {
  const shared = diffieHellman({
    privateKey: x25519Private(devicePriv, devicePub),
    publicKey: x25519Public(inboxPub)
  })
  const key = proofKey(shared, devicePub, boat, req.kid, req.id)
  return createHmac('sha256', key).update(proofInput({ ...req, boat })).digest('base64url')
}

/** The boat's side: the same key, reached from the other end of the agreement. */
export function checkProof({ req, boat, inboxPriv, inboxPub, devicePub }) {
  const shared = diffieHellman({
    privateKey: x25519Private(inboxPriv, inboxPub),
    publicKey: x25519Public(devicePub)
  })
  const key = proofKey(shared, devicePub, boat, req.kid, req.id)
  const expected = createHmac('sha256', key).update(proofInput({ ...req, boat })).digest()
  const offered = Buffer.from(req.proof, 'base64url')
  return offered.length === expected.length && offered.equals(expected)
}
