/**
 * Sealing a frame for the owner's devices, and signing it for the relay.
 *
 * The boat encrypts what she reports so that the service carrying it cannot
 * read it, and signs it so that the same service can still swear it arrived
 * when it did and was not altered. Those are two separate layers and neither
 * stands in for the other: the encryption is the privacy, the signature is the
 * proof, and the signature deliberately covers the ciphertext so that a relay
 * with no key can still verify.
 *
 * The suite is X25519 for agreement, HKDF-SHA256 for derivation,
 * ChaCha20-Poly1305 for encryption and Ed25519 for signatures. It was not
 * chosen for elegance: it is the set that exists natively in both Node and
 * CryptoKit and has been proven against the same vectors on both, down to
 * armv7 on the Node 20 floor, which is the hardware this plugin ships to. The
 * vectors in dev/e2e-vectors are the contract between the two implementations,
 * and this module is held to them by test.
 *
 * Two rules run through the whole file and explain most of its shape:
 *
 *   Everything on the wire is parsed strictly before it is trusted. A frame
 *   arrives from a party we have decided not to trust, so a decoder that
 *   accepts sloppy input hands that party the ability to alter bytes without
 *   breaking a signature.
 *
 *   Everything present is signed. The signature covers unknown fields as well
 *   as known ones, so a field added in a later version cannot be born outside
 *   the signature and quietly rewritten in transit.
 *
 * Read-only, like everything else here: this seals what the boat already
 * measures. Nothing in this file emits a delta, writes to Signal K or takes a
 * command.
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
  verify,
  type KeyObject
} from 'crypto'

export const FRAME_VERSION = 1

/**
 * The most devices one boat will seal to. Not a paywall: every device is
 * already a chore for the owner to set up, so charging for them would be
 * charging for friction. This is the technical ceiling, and it bounds frame
 * growth, since each device adds a wrapped key to every frame the boat sends.
 *
 * The account is where this is enforced, and the boat carries the same number
 * so that a list arriving over-long cannot make her frames grow without bound.
 * Raising it therefore takes a release on both sides, not a server switch.
 */
export const MAX_DEVICES = 5

/** Domain separation, so a key derived here can never collide with one derived elsewhere. */
const KEY_WRAP_INFO = 'siparu/frame-key/v1'
const SIGNING_PREFIX = 'siparu-frame-v1\0'

/** Raw byte lengths, checked on the way in rather than assumed. */
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const SIG_BYTES = 64

/** The fields this version defines. Anything else on a frame is an extension. */
const KNOWN_FIELDS = new Set(['v', 'boat', 'ts', 'eph', 'nonce', 'body', 'keys', 'sig'])

/** One device authorised to read this boat, as the account knows it. */
export interface DeviceKey {
  /**
   * Key id the relay and the boat both refer to this device by. Opaque and
   * random by specification: it travels in the clear on every frame, so a
   * readable one ("owner-iphone") would hand the relay a device inventory it
   * is otherwise not entitled to.
   */
  kid: string
  /** Raw 32-byte X25519 public key. */
  pub: Buffer
}

/** One content key, wrapped to one device. */
export interface WrappedKey {
  kid: string
  wrap: string
}

/**
 * A sealed frame, as it goes on the wire. Only `boat` and `ts` are legible in
 * transit. Extension fields added by later versions are permitted and are
 * covered by the signature; they must be strings, so that two implementations
 * cannot disagree about how to serialise them.
 */
export interface SealedFrame {
  v: number
  boat: string
  ts: number
  /** Ephemeral X25519 public key, this frame only. */
  eph: string
  nonce: string
  /** The report, encrypted once under a content key. */
  body: string
  /** That content key, wrapped separately to each authorised device. */
  keys: WrappedKey[]
  /** Ed25519 over the ciphertext, the cleartext metadata and any extensions. */
  sig: string
  [extension: string]: unknown
}

const b64u = (buf: Buffer): string => buf.toString('base64url')

/**
 * Decode base64url, refusing anything that is not the one canonical spelling
 * of its bytes.
 *
 * Node's decoder is forgiving: it ignores characters outside the alphabet and
 * accepts non-canonical trailing bits, so several different strings decode to
 * identical bytes. Since the signature is computed over decoded bytes, a
 * forgiving decoder lets anyone in the middle rewrite a frame's text while
 * keeping its signature valid. It also splits the two implementations apart,
 * because Foundation rejects what Node accepts, and a frame Node calls
 * authentic can crash a phone.
 */
function strictDecode(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string') throw new Error('expected a base64url string')
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('base64url field has invalid characters')
  const buf = Buffer.from(value, 'base64url')
  // Re-encoding is the cheapest test for a canonical spelling: it catches both
  // stray padding and trailing bits that decode to nothing.
  if (buf.toString('base64url') !== value) throw new Error('base64url field is not canonical')
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes, got ${buf.length}`)
  }
  return buf
}

/**
 * Length-prefixed field: no two different values can produce the same signing
 * input. The prefix is 32 bits rather than 16 because the same envelope will
 * carry history answers, and a snapshot page can run to hundreds of kilobytes.
 * A 16-bit prefix would have made that a hard 64 KiB wall that could not be
 * moved once the format was in the field.
 */
function lp(buf: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(buf.length)
  return Buffer.concat([head, buf])
}

function u16be(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

function u64be(n: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

/**
 * Extension fields, in one canonical order, so that a later version can add a
 * field and have it signed without this function being touched.
 *
 * The alarm severity flag is the first of these and shows why it matters: it
 * is cleartext by necessity, since the relay has to know a push is due. If it
 * were outside the signature a hostile relay could downgrade an alarm to
 * normal and swallow the notification, or invent one that never happened.
 *
 * Keys are restricted to lower-case ASCII so that sorting cannot differ
 * between implementations, and values to strings so that number formatting
 * cannot either.
 */
function extensionEntries(frame: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = []
  for (const key of Object.keys(frame).sort()) {
    if (KNOWN_FIELDS.has(key)) continue
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`extension field ${key} is not a legal name`)
    const value = frame[key]
    if (typeof value !== 'string') throw new Error(`extension field ${key} must be a string`)
    out.push([key, value])
  }
  return out
}

/**
 * The exact bytes the boat signs and the relay verifies.
 *
 * Built from raw fields with explicit lengths rather than from re-serialised
 * JSON. The two implementations that have to agree on these bytes are written
 * in different languages, and any disagreement between their JSON encoders
 * about key order or spacing would break every signature in the fleet at once.
 *
 * `ts` is inside the signature on purpose: rewriting a departure time is the
 * attack the proof layer exists to defeat.
 */
export function signingInput(frame: Record<string, unknown>): Buffer {
  const v = frame.v
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new Error('frame version must be an integer that fits sixteen bits')
  }
  const ts = frame.ts
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts < 0) {
    throw new Error('frame timestamp must be a non-negative integer')
  }
  if (typeof frame.boat !== 'string') throw new Error('frame boat id must be a string')
  if (!Array.isArray(frame.keys)) throw new Error('frame keys must be an array')

  const parts: Buffer[] = [
    Buffer.from(SIGNING_PREFIX, 'utf8'),
    u16be(v),
    lp(Buffer.from(frame.boat, 'utf8')),
    u64be(ts),
    lp(strictDecode(frame.eph, KEY_BYTES)),
    lp(strictDecode(frame.nonce, NONCE_BYTES)),
    lp(strictDecode(frame.body))
  ]

  parts.push(u16be(frame.keys.length))
  const seen = new Set<string>()
  for (const entry of frame.keys as unknown[]) {
    if (typeof entry !== 'object' || entry === null) throw new Error('wrapped key must be an object')
    const { kid, wrap } = entry as { kid?: unknown; wrap?: unknown }
    if (typeof kid !== 'string' || kid.length === 0) throw new Error('wrapped key needs a kid')
    // A repeated kid would leave an honest device picking the first wrap it
    // finds, which may not be the one sealed to it. The list is assembled from
    // an account the boat does not control, so this is checked, not assumed.
    if (seen.has(kid)) throw new Error(`duplicate key id ${kid}`)
    seen.add(kid)
    parts.push(lp(Buffer.from(kid, 'utf8')), lp(strictDecode(wrap)))
  }

  const ext = extensionEntries(frame)
  parts.push(u16be(ext.length))
  for (const [key, value] of ext) {
    parts.push(lp(Buffer.from(key, 'utf8')), lp(Buffer.from(value, 'utf8')))
  }
  return Buffer.concat(parts)
}

/** Raw 32-byte public key of an X25519 or Ed25519 key object. */
export function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string }
  if (!jwk.x) throw new Error('key has no public component')
  return Buffer.from(jwk.x, 'base64url')
}

/** Raw 32-byte private scalar (X25519) or seed (Ed25519). */
export function rawPrivate(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { d?: string }
  if (!jwk.d) throw new Error('key has no private component')
  return Buffer.from(jwk.d, 'base64url')
}

function x25519PublicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(raw) }, format: 'jwk' })
}

export function x25519PrivateFromRaw(priv: Buffer, pub: Buffer): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: b64u(pub), d: b64u(priv) },
    format: 'jwk'
  })
}

export function ed25519PublicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(raw) }, format: 'jwk' })
}

export function ed25519PrivateFromRaw(priv: Buffer, pub: Buffer): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: b64u(pub), d: b64u(priv) },
    format: 'jwk'
  })
}

/**
 * Derive the key and nonce that wrap the content key for one device.
 *
 * Salted with the ephemeral public key and bound to the boat, the timestamp
 * and the device's key id, so that two devices on one frame never derive the
 * same wrapping key, and two frames never do either.
 *
 * The nonce is derived rather than fixed at zero. Zero would be sound on the
 * stated invariant that every frame has a fresh ephemeral pair, but that
 * invariant rests entirely on the random number generator never repeating,
 * and on this hardware there is a real way for it to repeat: an SD card image
 * cloned between vessels, or a virtual machine restored from a snapshot,
 * brings back the generator state with it. A repeated ephemeral pair under a
 * fixed nonce is an immediate keystream reuse. Deriving the nonce, and mixing
 * the timestamp in, costs nothing and removes the single point of failure.
 */
function wrapSecrets(
  shared: Buffer,
  ephPub: Buffer,
  boat: string,
  ts: number,
  kid: string
): { key: Buffer; nonce: Buffer } {
  const info = Buffer.from(`${KEY_WRAP_INFO}/${boat}/${ts}/${kid}`, 'utf8')
  const out = Buffer.from(hkdfSync('sha256', shared, ephPub, info, KEY_BYTES + NONCE_BYTES))
  return { key: out.subarray(0, KEY_BYTES), nonce: out.subarray(KEY_BYTES) }
}

function aead(key: Buffer, nonce: Buffer, plaintext: Buffer): Buffer {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([ct, c.getAuthTag()])
}

function unaead(key: Buffer, nonce: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new Error('sealed value is too short to hold a tag')
  const ct = sealed.subarray(0, sealed.length - TAG_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: TAG_BYTES })
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

/** One device the boat could not seal to, and why. Surfaced, never swallowed. */
export interface RejectedDevice {
  kid: string
  reason: string
}

export interface SealResult {
  frame: SealedFrame
  /**
   * Devices left out of this frame. Empty on a healthy boat. A caller must
   * report these rather than discard them: a device that silently stops
   * receiving looks exactly like a boat that has gone quiet.
   */
  rejected: RejectedDevice[]
}

export interface SealOptions {
  boat: string
  ts: number
  /** The report, already serialised. */
  plaintext: string
  /** Every device the account has authorised. */
  devices: DeviceKey[]
  /** The boat's long-lived Ed25519 identity key. */
  identity: KeyObject
  /**
   * Cleartext fields carried beside the sealed body, signed but not encrypted.
   * The alarm severity flag lives here. Keys must be lower-case ASCII and
   * values strings.
   */
  extensions?: Record<string, string>
}

/**
 * Seal one frame for every authorised device, and sign it.
 *
 * The body is encrypted once, under a content key generated here; that key is
 * then wrapped separately per device. A boat with three screens sends one body
 * and three short wraps, not three bodies.
 *
 * One bad key does not stop the boat. The device list is assembled ashore and
 * arrives over a channel the boat does not control, so a single malformed or
 * hostile public key must not be able to silence a vessel: the offender is
 * skipped and named in `rejected`, and the frame goes out to everyone else.
 * Only when nothing is left does this refuse, because a frame nobody can open
 * is indistinguishable on the wire from a healthy one, and would leave the
 * owner's connection indicator claiming all is well.
 */
export function sealFrame(opts: SealOptions): SealResult {
  const eph = generateKeyPairSync('x25519')
  const ephPub = rawPublic(eph.publicKey)
  const cek = randomBytes(KEY_BYTES)
  const nonce = randomBytes(NONCE_BYTES)

  const rejected: RejectedDevice[] = []
  const keys: WrappedKey[] = []
  const seen = new Set<string>()

  for (const d of opts.devices) {
    if (keys.length >= MAX_DEVICES) {
      rejected.push({ kid: d.kid, reason: `beyond the ceiling of ${MAX_DEVICES} devices` })
      continue
    }
    if (seen.has(d.kid)) {
      rejected.push({ kid: d.kid, reason: 'duplicate key id' })
      continue
    }
    try {
      if (d.pub.length !== KEY_BYTES) throw new Error(`public key is ${d.pub.length} bytes`)
      const shared = diffieHellman({
        privateKey: eph.privateKey,
        publicKey: x25519PublicFromRaw(d.pub)
      })
      const { key, nonce: wrapNonce } = wrapSecrets(shared, ephPub, opts.boat, opts.ts, d.kid)
      keys.push({ kid: d.kid, wrap: b64u(aead(key, wrapNonce, cek)) })
      seen.add(d.kid)
    } catch (err) {
      rejected.push({ kid: d.kid, reason: err instanceof Error ? err.message : 'unusable key' })
    }
  }

  if (keys.length === 0) {
    throw new Error('cannot seal a frame no authorised device could open')
  }

  const unsigned: Record<string, unknown> = {
    v: FRAME_VERSION,
    boat: opts.boat,
    ts: opts.ts,
    eph: b64u(ephPub),
    nonce: b64u(nonce),
    body: b64u(aead(cek, nonce, Buffer.from(opts.plaintext, 'utf8'))),
    keys,
    ...(opts.extensions ?? {})
  }
  const frame = {
    ...unsigned,
    sig: b64u(sign(null, signingInput(unsigned), opts.identity))
  } as SealedFrame
  return { frame, rejected }
}

/**
 * What a party with no key can still establish: this boat sent this frame, and
 * nothing altered it in flight.
 *
 * Returns false rather than throwing on anything malformed. The relay calls
 * this on every frame that arrives, including frames from a client that has
 * not authenticated yet, so "this is not a valid frame" has to be an answer
 * and not an exception: the two are the same thing to a caller, and only one
 * of them is safe to run in a request handler.
 */
export function verifyFrame(frame: unknown, boatIdentityPub: KeyObject): boolean {
  if (typeof frame !== 'object' || frame === null) return false
  const record = frame as Record<string, unknown>
  try {
    const sig = strictDecode(record.sig, SIG_BYTES)
    const { sig: _omit, ...unsigned } = record
    if ((unsigned.keys as unknown[]).length > MAX_DEVICES) return false
    return verify(null, signingInput(unsigned), boatIdentityPub, sig)
  } catch {
    return false
  }
}

/**
 * What only an authorised device can do: read it.
 *
 * The signature is checked first, and by the reader, not only by the relay.
 * Decryption on its own proves nothing about the cleartext metadata: `ts`
 * travels in the open, so a relay that kept yesterday's frame from a quiet
 * anchorage, moved its timestamp to now and passed it on unchanged would have
 * a device showing a stale position as current. The proof layer only protects
 * the owner if the owner's own device runs it.
 *
 * Replay of a whole frame at its original timestamp is not caught here, and
 * cannot be by a stateless function: a reader that wants that must remember
 * the newest timestamp it has accepted and refuse anything older.
 */
export function openFrame(
  frame: SealedFrame,
  boatIdentityPub: KeyObject,
  kid: string,
  priv: Buffer,
  pub: Buffer
): string {
  if (!verifyFrame(frame, boatIdentityPub)) throw new Error('frame signature does not verify')
  if (frame.v !== FRAME_VERSION) throw new Error(`unsupported frame version ${String(frame.v)}`)
  const entry = frame.keys.find((k) => k.kid === kid)
  if (!entry) throw new Error(`frame carries no wrapped key for device ${kid}`)
  const ephPub = strictDecode(frame.eph, KEY_BYTES)
  const shared = diffieHellman({
    privateKey: x25519PrivateFromRaw(priv, pub),
    publicKey: x25519PublicFromRaw(ephPub)
  })
  const { key, nonce } = wrapSecrets(shared, ephPub, frame.boat, frame.ts, kid)
  const cek = unaead(key, nonce, strictDecode(entry.wrap))
  return unaead(cek, strictDecode(frame.nonce, NONCE_BYTES), strictDecode(frame.body)).toString(
    'utf8'
  )
}
