/**
 * Generate the cross-platform test vectors.
 *
 * Run this once, commit the output, and never let it drift silently: the point
 * of the file is that two implementations in two languages agree on the same
 * fixed bytes. Regenerating it is a deliberate act, taken when the frame format
 * changes, and both verifiers must be rerun after.
 *
 * Every key in the output is generated for this file and used nowhere else.
 * They are published deliberately: a test vector with a secret key is a test
 * vector nobody can run.
 *
 *   node dev/e2e-vectors/generate.mjs > dev/e2e-vectors/vectors.json
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { FRAME_VERSION, b64u, rawPrivate, rawPublic, sealFrame, signingInput } from './frame.mjs'

/** Plain decoding, for building tampered vectors on purpose. Wire input goes through strictDecode. */
const unb64u = (s) => Buffer.from(s, 'base64url')

const identity = generateKeyPairSync('ed25519')
const ephemeral = generateKeyPairSync('x25519')

const devices = ['phone-a', 'tablet-b'].map((kid) => {
  const kp = generateKeyPairSync('x25519')
  return {
    kid,
    pub: rawPublic(kp.publicKey),
    priv: rawPrivate(kp.privateKey)
  }
})

/**
 * A body shaped like the live frame the boat already sends, so the vector
 * exercises a realistic length rather than a word. The values are invented.
 */
const plaintext = JSON.stringify({
  ts: 1753142400000,
  lat: 43.5528,
  lon: 7.0174,
  sog: 6.2,
  cog: 2.41,
  heading_true: 2.38,
  wind_speed_true: 8.4,
  wind_direction_true: 3.02,
  depth: 24.6,
  air_pressure_pa: 101_320,
  water_temp_k: 295.15,
  paths: {
    'propulsion.port.revolutions': 21.5,
    'tanks.fuel.0.currentLevel': 0.62
  }
})

const frame = sealFrame({
  boat: 'boat-0001',
  ts: 1753142400000,
  plaintext,
  devices,
  identity: identity.privateKey,
  ephemeral,
  bodyNonce: randomBytes(12),
  // The cleartext alarm severity, the first extension field the format
  // carries. It is in the vectors from the start so that both implementations
  // sign extensions from the start: a field that arrives after the signing
  // input is settled is a field that arrives unsigned.
  extensions: { alert: 'warning' }
})

/** A frame whose ciphertext moved by one bit. The signature must fail on it. */
const bodyFlipped = structuredClone(frame)
{
  const b = unb64u(bodyFlipped.body)
  b[0] ^= 0x01
  bodyFlipped.body = b64u(b)
}

/**
 * A frame whose timestamp was rewritten in transit. This is the attack the
 * proof layer exists to defeat, so it gets its own vector: the relay witnesses
 * arrival, and a frame claiming a different departure must not verify.
 */
const tsChanged = structuredClone(frame)
tsChanged.ts = frame.ts + 3_600_000

/** A frame with one device's wrapped key swapped for the other's. */
const wrapSwapped = structuredClone(frame)
{
  const [a, b] = wrapSwapped.keys
  wrapSwapped.keys = [
    { kid: a.kid, wrap: b.wrap },
    { kid: b.kid, wrap: a.wrap }
  ]
}

/**
 * A frame whose ephemeral key was respelled without changing a single decoded
 * byte. A forgiving base64 decoder verifies this happily, because the
 * signature is computed over decoded bytes: the text can be rewritten in
 * flight while the signature stays valid. Both implementations must reject the
 * spelling, not merely the bytes.
 */
const ephRespelled = structuredClone(frame)
{
  // Thirty-two bytes encode to forty-three characters, and the last of those
  // carries four meaningful bits and two spare ones. Flipping the lowest spare
  // bit picks a different character that decodes to exactly the same bytes.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const last = ephRespelled.eph.slice(-1)
  ephRespelled.eph = ephRespelled.eph.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1]
  // The vector is worthless unless the bytes really are identical: that is the
  // whole point, a signature over decoded bytes cannot tell the two apart.
  if (!unb64u(ephRespelled.eph).equals(unb64u(frame.eph))) {
    throw new Error('respelling changed the decoded bytes, the vector would prove nothing')
  }
  if (ephRespelled.eph === frame.eph) throw new Error('respelling did not change the text')
}

/** A frame with whitespace pushed into the ciphertext text. Same bytes to a lax decoder. */
const bodyWhitespace = structuredClone(frame)
bodyWhitespace.body = `${bodyWhitespace.body.slice(0, 8)}\n${bodyWhitespace.body.slice(8)}`

/**
 * A frame relabelled as version 257. With an eight-bit version field this
 * collides with version 1 and verifies, which is a downgrade path through the
 * version negotiation the spec relies on.
 */
const versionRewritten = structuredClone(frame)
versionRewritten.v = 257

/**
 * A frame whose alarm severity was downgraded in transit. This is why
 * extension fields are signed: unsigned, a hostile relay could turn an alarm
 * into a normal reading and swallow the notification the owner was owed.
 */
const alertDowngraded = structuredClone(frame)
alertDowngraded.alert = 'normal'

process.stdout.write(
  `${JSON.stringify(
    {
      note:
        'Cross-platform vectors for the sealed telemetry frame. All keys here are ' +
        'test-only and published on purpose. Generated by dev/e2e-vectors/generate.mjs.',
      frame_version: FRAME_VERSION,
      suite: {
        agreement: 'X25519',
        kdf: 'HKDF-SHA256',
        aead: 'ChaCha20-Poly1305',
        signature: 'Ed25519'
      },
      boat_identity: {
        public: b64u(rawPublic(identity.publicKey)),
        private: b64u(rawPrivate(identity.privateKey))
      },
      devices: devices.map((d) => ({
        kid: d.kid,
        public: b64u(d.pub),
        private: b64u(d.priv)
      })),
      expected_plaintext: plaintext,
      /** Hex, so a verifier can find where its own signing input diverges rather than only that it did. */
      expected_signing_input_hex: signingInput(frame).toString('hex'),
      frame,
      must_not_verify: {
        body_bit_flipped: bodyFlipped,
        ts_rewritten: tsChanged,
        wraps_swapped: wrapSwapped,
        eph_respelled: ephRespelled,
        body_whitespace: bodyWhitespace,
        version_rewritten: versionRewritten,
        alert_downgraded: alertDowngraded
      }
    },
    null,
    2
  )}\n`
)
