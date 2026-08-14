/**
 * Reference implementation of the device approval MAC.
 *
 * Not the shipping code and not an import of it. Two implementations in two languages
 * (the plugin in Node, the app in CryptoKit) must agree on these bytes exactly, and a
 * reference transcribed from either would prove nothing. The byte-building below is
 * written against the specification's words, with its own arithmetic.
 *
 * What it is for. A device list assembled ashore arrives at the boat over carriers she
 * does not trust. An entry is believed only when a device she already trusts vouched
 * for it, and the vouching is this MAC: computed by the approver from its own private
 * half and the boat's inbox public half, verified by the boat from her inbox private
 * half and the approver's public half. X25519 hands both pairs the same shared secret,
 * so no new credential exists on either side.
 *
 *   ikm   = X25519(approver_priv, inbox_pub) = X25519(inbox_priv, approver_pub)
 *   key   = HKDF-SHA256(ikm, salt = approver_pub,
 *                       info = "siparu/device-approval/v1/<boat>/<approver_kid>/<subject_kid>",
 *                       len = 32)
 *   mac   = HMAC-SHA256(key, input)
 *   input = "siparu/device-approval/v1"
 *        || u16be(1) || lp(boat) || lp(approver_kid) || lp(subject_kid) || lp(subject_pub)
 *
 * lp is a 32-bit big-endian length prefix over the raw bytes. subject_pub is the
 * DECODED 32 bytes, never the base64url text that carried them: one key has four
 * spellings and the MAC must not care which one the carrier chose.
 */
import { createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto'

export const APPROVAL_LABEL = 'siparu/device-approval/v1'
export const APPROVAL_VERSION = 1

/** 32-bit big-endian length prefix, written out by hand on purpose. */
function field(bytes) {
  const b = Buffer.from(bytes)
  const len = b.length
  return Buffer.concat([
    Buffer.from([Math.floor(len / 0x1000000) % 256, Math.floor(len / 0x10000) % 256, Math.floor(len / 0x100) % 256, len % 256]),
    b
  ])
}

export function approvalInput(boat, approverKid, subjectKid, subjectPub) {
  if (subjectPub.length !== 32) throw new Error('a device key is 32 bytes')
  return Buffer.concat([
    Buffer.from(APPROVAL_LABEL, 'utf8'),
    Buffer.from([Math.floor(APPROVAL_VERSION / 256), APPROVAL_VERSION % 256]),
    field(Buffer.from(boat, 'utf8')),
    field(Buffer.from(approverKid, 'utf8')),
    field(Buffer.from(subjectKid, 'utf8')),
    field(subjectPub)
  ])
}

const xPriv = (raw, pub) =>
  createPrivateKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'X25519', d: raw.toString('base64url'), x: pub.toString('base64url') }
  })
const xPub = (raw) =>
  createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') } })

function macFromShared(shared, approverPub, boat, approverKid, subjectKid, subjectPub) {
  const info = `${APPROVAL_LABEL}/${boat}/${approverKid}/${subjectKid}`
  const key = Buffer.from(hkdfSync('sha256', shared, approverPub, info, 32))
  return createHmac('sha256', key)
    .update(approvalInput(boat, approverKid, subjectKid, subjectPub))
    .digest()
}

/** The device's door in: its own private half and the boat's inbox public half. */
export function deviceMac({ approverPriv, approverPub, inboxPub, boat, approverKid, subjectKid, subjectPub }) {
  const shared = diffieHellman({
    privateKey: xPriv(approverPriv, approverPub),
    publicKey: xPub(inboxPub)
  })
  return macFromShared(shared, approverPub, boat, approverKid, subjectKid, subjectPub)
}

/** The boat's door in: her inbox private half and the approver's public half. */
export function boatMac({ inboxPriv, inboxPub, approverPub, boat, approverKid, subjectKid, subjectPub }) {
  const shared = diffieHellman({
    privateKey: xPriv(inboxPriv, inboxPub),
    publicKey: xPub(approverPub)
  })
  return macFromShared(shared, approverPub, boat, approverKid, subjectKid, subjectPub)
}
