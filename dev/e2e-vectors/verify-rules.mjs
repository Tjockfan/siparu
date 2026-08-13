/**
 * Verify the committed rule write vectors on Node, the side the boat runs.
 *
 * The Swift verifier beside it checks the same file with CryptoKit. Both must pass, on the
 * supported Node floor, before a phone is wired to write anything.
 *
 *   node dev/e2e-vectors/verify-rules.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { checkProof, makeProof, proofInput } from './rules.mjs'

/** Key material out of the vector file, which is trusted input, not wire input. */
const unb64u = (s) => Buffer.from(s, 'base64url')

const here = dirname(fileURLToPath(import.meta.url))
const v = JSON.parse(readFileSync(join(here, 'rule-vectors.json'), 'utf8'))

let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const inboxPub = unb64u(v.boat_inbox.public)
const inboxPriv = unb64u(v.boat_inbox.private)
const phone = v.devices[0]
const phonePub = unb64u(phone.public)
const phonePriv = unb64u(phone.private)

check(
  'proof input matches the committed bytes',
  proofInput({ ...v.write, boat: v.boat }).toString('hex') === v.expected_proof_input_hex
)

check(
  'the boat reaches the same proof from her end of the agreement',
  checkProof({ req: v.write, boat: v.boat, inboxPriv, inboxPub, devicePub: phonePub })
)

check(
  'the device recomputes the committed proof',
  makeProof({
    req: v.write,
    boat: v.boat,
    devicePriv: phonePriv,
    devicePub: phonePub,
    inboxPub
  }) === v.write.proof
)

check(
  'the same write does not verify at another vessel',
  !checkProof({
    req: v.other_boat.write,
    boat: v.other_boat.boat,
    inboxPriv,
    inboxPub,
    devicePub: phonePub
  })
)

for (const [name, write] of Object.entries(v.must_not_verify)) {
  check(
    `refused: ${name}`,
    !checkProof({ req: write, boat: v.boat, inboxPriv, inboxPub, devicePub: phonePub })
  )
}

console.log(failures === 0 ? '\nall rule vectors pass' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
