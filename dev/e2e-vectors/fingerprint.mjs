/**
 * Reference implementation of the device key fingerprint.
 *
 * Not the shipping code and not an import of it. Three products compute this string from the
 * same key and a person compares them by eye, so the property worth pinning is that
 * implementations written separately agree character for character. A fingerprint that differs
 * between the phone and the boat's own screen is worse than none: it reports an attack on every
 * honest pairing, and an owner who sees that twice stops looking.
 *
 * What it is for. Later devices are added from the account without a trip to the boat, so the
 * server hands the boat a public key and the boat believes it. A malicious or compromised
 * server could substitute one of its own and read everything sealed from that point on. The
 * antidote named in the specification is verification by eye: the app and the boat's own screen
 * show the same short string, and an owner aboard can confirm they match.
 *
 *   fp = SHA-256("siparu/device-fingerprint/v1" || pub)[0..10] in Crockford base32
 *
 * Three decisions in that line, each of which would be expensive to change later.
 *
 * The input is the DECODED 32 bytes, never the base64url text that carries them. The last
 * character of a 43-character encoding holds two bits that no byte reads, so one key has
 * several spellings; hashing the text would let whoever relays it show two honest parties two
 * different strings for one key. The same class of fault was found in the frame signature on
 * 22 July and the fix is the same: hash what the key IS.
 *
 * Eighty bits, because the attack is second preimage rather than collision. The server does not
 * need two keys that agree with each other, it needs one that agrees with a string already on
 * the owner's screen, and X25519 key generation is cheap enough that forty bits is hours of GPU
 * time. Eighty is out of reach and still short enough to read aloud.
 *
 * Crockford base32 with the ambiguous letters removed, in groups of four. What this format is
 * read by is a person holding a phone next to a screen, and I, L, O and U in a font they did
 * not choose is how that comparison goes wrong in the honest direction.
 */
import { createHash } from 'node:crypto'

/** Domain separation: this digest is a fingerprint of a device key and nothing else. */
export const FINGERPRINT_LABEL = 'siparu/device-fingerprint/v1'
export const FINGERPRINT_BITS = 80

/** Crockford base32: digits, then the alphabet without I, L, O or U. */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const GROUP = 4

/**
 * The string shown to a person, groups included, because the groups are part of what is
 * compared. Two products that agreed on the characters and disagreed on the dashes would send
 * an owner looking for a difference that is not there.
 */
export function fingerprint(pub) {
  if (pub.length !== 32) throw new Error(`a device key is 32 bytes, this one is ${pub.length}`)
  const digest = createHash('sha256')
    .update(Buffer.from(FINGERPRINT_LABEL, 'utf8'))
    .update(Buffer.from(pub))
    .digest()

  // Deliberately not the same arithmetic as the shipping implementations: a big integer read
  // most significant bit first, rather than a running bit buffer. Two implementations that
  // agree because one was transcribed from the other prove nothing.
  let n = 0n
  for (const byte of digest.subarray(0, FINGERPRINT_BITS / 8)) n = (n << 8n) | BigInt(byte)

  let out = ''
  for (let shift = FINGERPRINT_BITS - 5; shift >= 0; shift -= 5) {
    out += ALPHABET[Number((n >> BigInt(shift)) & 31n)]
  }
  return out.match(new RegExp(`.{${GROUP}}`, 'g')).join('-')
}
