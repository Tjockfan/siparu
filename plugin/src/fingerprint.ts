/**
 * The short string an owner compares by eye.
 *
 * A device her owner adds ashore reaches this boat as a public key handed over by the relay,
 * and she has no way to tell one that came from his phone from one the relay made up. That is
 * written down rather than hidden: the specification names the server as an accepted man in the
 * middle and names the antidote, which is a person standing on the boat comparing what her
 * screen says with what his phone says. This is the string they compare.
 *
 *   fp = SHA-256("siparu/device-fingerprint/v1" || pub)[0..10] in Crockford base32
 *
 * The input is the decoded 32 bytes and never the base64url text. The last character of a
 * 43-character encoding carries two bits no byte reads, so one key has four spellings; hashing
 * the text would let whoever passes the key along show the phone and the boat two different
 * strings for the same key, which is the exact deceit this exists to prevent.
 *
 * Eighty bits, because the attack is second preimage and not collision: the relay needs a key
 * that matches a string already on the owner's screen, not two that match each other. Forty
 * bits would be hours of GPU time against a primitive as cheap as X25519 key generation.
 *
 * Agreed with two implementations that share no code with this one - the reference in
 * dev/e2e-vectors and the app's CryptoKit version - against the committed vectors. A
 * disagreement here does not fail closed: it prints an accusation of tampering on an honest
 * pairing, and an owner who is wrongly alarmed twice stops looking the third time.
 */
import { createHash } from 'node:crypto'

const LABEL = 'siparu/device-fingerprint/v1'
const BYTES = 10
const GROUP = 4
/** Crockford base32: I, L, O and U are absent, because this is read off a screen by a person. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * @param pub the raw X25519 public half, 32 bytes
 * @throws if it is any other length, which is a caller that has not decoded what it was given
 */
export function deviceFingerprint(pub: Uint8Array): string {
  if (pub.length !== 32) throw new Error(`a device key is 32 bytes, this one is ${pub.length}`)
  const digest = createHash('sha256').update(LABEL).update(pub).digest()

  let out = ''
  let bits = 0
  let held = 0
  for (const byte of digest.subarray(0, BYTES)) {
    held = (held << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(held >> bits) & 31]
    }
  }
  return out.replace(new RegExp(`(.{${GROUP}})(?=.)`, 'g'), '$1-')
}

/**
 * The same string for a key as it arrives from the shore, or null if that key is unusable.
 *
 * Null rather than a throw, because the list it reads is assembled ashore and one bad row in it
 * must not take a vessel's screen off the air - the same rule the sealing code follows when it
 * names a bad key instead of refusing to send.
 */
export function fingerprintOfEncoded(pub: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(pub)) return null
  const raw = Buffer.from(pub, 'base64url')
  return raw.length === 32 ? deviceFingerprint(raw) : null
}
