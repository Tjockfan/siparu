/**
 * Generate the cross-platform vectors for the rule write proof.
 *
 * Kept apart from the frame vectors on purpose. Regenerating a vector file means every
 * verifier has to be rerun by hand, including the CryptoKit one, and there is no reason for a
 * change to this message to cost a fresh pass over the frame format that did not change.
 *
 * Every key here is generated for this file and used nowhere else. They are published
 * deliberately: a test vector with a secret key is a test vector nobody can run.
 *
 *   node dev/e2e-vectors/generate-rules.mjs > dev/e2e-vectors/rule-vectors.json
 */
import { generateKeyPairSync } from 'node:crypto'
import { RULE_PROOF_VERSION, makeProof, proofInput } from './rules.mjs'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const raw = (key, half) => Buffer.from(key.export({ format: 'jwk' })[half], 'base64url')

const inbox = generateKeyPairSync('x25519')
const inboxPub = raw(inbox.publicKey, 'x')
const inboxPriv = raw(inbox.privateKey, 'd')

const phone = generateKeyPairSync('x25519')
const devicePub = raw(phone.publicKey, 'x')
const devicePriv = raw(phone.privateKey, 'd')

/** A second screen, so a verifier can prove a proof does not travel between devices. */
const tablet = generateKeyPairSync('x25519')
const tabletPub = raw(tablet.publicKey, 'x')
const tabletPriv = raw(tablet.privateKey, 'd')

const boat = 'boat-0001'

/**
 * A list shaped like one a real owner writes: a tank he has heard enough about, a bilge
 * float he wants only when it is serious, and one he left loud. The third entry matters -
 * a list that only ever carried mutes would not prove the ordinary case travels too.
 */
const req = {
  v: RULE_PROOF_VERSION,
  id: 'ZG8tbm90LWNvdW50LXVw',
  kid: 'kid-phone-a',
  ts: 1_753_142_400_000,
  rules: [
    { path: 'notifications.tanks.blackWater.0.currentLevel', ring_from: 'never' },
    { path: 'notifications.tanks.bilge.0.currentLevel', ring_from: 'alarm' },
    { path: 'notifications.electrical.batteries.house.voltage', ring_from: 'warning' }
  ]
}

const proof = makeProof({ req, boat, devicePriv, devicePub, inboxPub })

/** A list whose rules a carrier put in a different order. It must not verify. */
const reordered = { ...req, rules: [...req.rules].reverse(), proof }

/** The same list, readdressed to another vessel. It must not verify there. */
const otherBoat = { boat: 'boat-9999', write: { ...req, proof } }

/** A proof made by the tablet, presented under the phone's key id. It must not verify. */
const borrowedKid = {
  ...req,
  proof: makeProof({
    req: { ...req, kid: 'kid-tablet-b' },
    boat,
    devicePriv: tabletPriv,
    devicePub: tabletPub,
    inboxPub
  })
}

/** One field moved, one vector each. Each is an attack rather than an illustration. */
const tampered = {
  rules_reordered: reordered,
  ts_rewritten: { ...req, ts: req.ts + 1, proof },
  id_rewritten: { ...req, id: 'another-request', proof },
  ring_relaxed: {
    ...req,
    rules: req.rules.map((r, i) => (i === 0 ? { ...r, ring_from: 'warning' } : r)),
    proof
  },
  rule_dropped: { ...req, rules: req.rules.slice(1), proof },
  path_rewritten: {
    ...req,
    rules: req.rules.map((r, i) => (i === 0 ? { ...r, path: 'notifications.tanks.fuel.0' } : r)),
    proof
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      note:
        'Cross-platform vectors for the alert rule write proof, the one message a device ' +
        'writes to a boat. All keys here are test-only and published on purpose. Generated ' +
        'by dev/e2e-vectors/generate-rules.mjs.',
      version: RULE_PROOF_VERSION,
      suite: { agreement: 'X25519', kdf: 'HKDF-SHA256', mac: 'HMAC-SHA256' },
      boat,
      boat_inbox: { public: b64u(inboxPub), private: b64u(inboxPriv) },
      devices: [
        { kid: 'kid-phone-a', public: b64u(devicePub), private: b64u(devicePriv) },
        { kid: 'kid-tablet-b', public: b64u(tabletPub), private: b64u(tabletPriv) }
      ],
      /** Hex, so a verifier finds WHERE its own bytes diverge rather than only that they did. */
      expected_proof_input_hex: proofInput({ ...req, boat }).toString('hex'),
      write: { ...req, proof },
      other_boat: otherBoat,
      must_not_verify: { ...tampered, kid_borrowed: borrowedKid }
    },
    null,
    2
  )}\n`
)
