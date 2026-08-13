/**
 * Generate the cross-platform vectors for the device key fingerprint.
 *
 * A fourth file rather than a line in an existing one, for the reason the others are kept
 * apart: regenerating a vector file means rerunning every verifier by hand, and a change to
 * how a key is displayed has no business costing a fresh pass over the frame format.
 *
 *   node dev/e2e-vectors/generate-fingerprint.mjs > dev/e2e-vectors/fingerprint-vectors.json
 *
 * Nothing secret is produced here. A fingerprint is computed from a public half alone, so the
 * file holds public keys and the strings they must print as, and can be read by anybody.
 */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { ALPHABET, FINGERPRINT_BITS, FINGERPRINT_LABEL, fingerprint } from './fingerprint.mjs'

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const rawPublic = (key) => Buffer.from(key.export({ format: 'jwk' }).x, 'base64url')

/**
 * A key whose digest begins with zero bits.
 *
 * Found rather than invented, because it is the case an encoder gets wrong quietly: one that
 * treats the ten bytes as a number and prints it without padding drops the leading zeros and
 * returns a shorter string, which agrees with every other implementation on every ordinary
 * key. Ten bits takes about a thousand tries.
 *
 * The bytes come from a counter rather than a key pair. Any 32 bytes are a well-formed X25519
 * public key encoding - the clamping is on the private side - and searching over generated
 * pairs would cost a scalar multiplication per try for nothing.
 */
function keyWithLeadingZeros() {
  for (let i = 0; ; i++) {
    const pub = createHash('sha256').update(`siparu/fingerprint-vector-search/${i}`).digest()
    if (fingerprint(pub).startsWith('00')) return pub
  }
}

const phone = rawPublic(generateKeyPairSync('x25519').publicKey)
const tablet = rawPublic(generateKeyPairSync('x25519').publicKey)
const padded = keyWithLeadingZeros()

const cases = [
  {
    note: 'an ordinary device key',
    public: b64u(phone),
    fingerprint: fingerprint(phone)
  },
  {
    note: 'a second screen on the same account, which must not read the same',
    public: b64u(tablet),
    fingerprint: fingerprint(tablet)
  },
  {
    note: 'digest begins with zero bits: the string is still sixteen characters',
    public: b64u(padded),
    fingerprint: fingerprint(padded)
  },
  {
    note: 'all zero bytes',
    public: b64u(Buffer.alloc(32)),
    fingerprint: fingerprint(Buffer.alloc(32))
  },
  {
    note: 'all bits set',
    public: b64u(Buffer.alloc(32, 0xff)),
    fingerprint: fingerprint(Buffer.alloc(32, 0xff))
  }
]

/**
 * One key, two spellings, one fingerprint.
 *
 * The last character of a 43-character base64url encoding carries two bits that no byte reads,
 * so every key has four spellings and every decoder accepts all of them. An implementation that
 * hashed the text rather than the bytes would print a different string for each, which hands
 * whoever passes the key along a way to make two honest parties disagree about a key neither of
 * them changed. The alias below is the same key with those spare bits set.
 */
const canonical = b64u(phone)
const alias = canonical.slice(0, -1) + B64URL[B64URL.indexOf(canonical.slice(-1)) + 1]

process.stdout.write(
  JSON.stringify(
    {
      label: FINGERPRINT_LABEL,
      bits: FINGERPRINT_BITS,
      alphabet: ALPHABET,
      group: 4,
      cases,
      alias: { public: alias, fingerprint: fingerprint(phone) }
    },
    null,
    2
  ) + '\n'
)
