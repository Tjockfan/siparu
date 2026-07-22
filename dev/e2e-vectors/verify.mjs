/**
 * Verify the committed vectors on Node, the side the boat runs.
 *
 * The Swift verifier in this directory checks the same file with CryptoKit.
 * Both must pass, on the supported Node floor, before the frame format is
 * written into the spec.
 *
 *   node dev/e2e-vectors/verify.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ed25519PublicFromRaw, openFrame, signingInput, unb64u, verifyFrame } from './frame.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const v = JSON.parse(readFileSync(join(here, 'vectors.json'), 'utf8'))

let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const boatPub = ed25519PublicFromRaw(unb64u(v.boat_identity.public))

check(
  'signing input matches the committed bytes',
  signingInput(v.frame).toString('hex') === v.expected_signing_input_hex
)

check('the boat signature verifies', verifyFrame(v.frame, boatPub))

for (const d of v.devices) {
  let plaintext = null
  try {
    plaintext = openFrame(v.frame, d.kid, unb64u(d.private), unb64u(d.public))
  } catch (err) {
    console.log(`      ${d.kid}: ${err.message}`)
  }
  check(`device ${d.kid} opens the body`, plaintext === v.expected_plaintext)
}

/** A device must not be able to read a frame that was not sealed to it. */
{
  const [a, b] = v.devices
  let opened = false
  try {
    openFrame(v.frame, a.kid, unb64u(b.private), unb64u(b.public))
    opened = true
  } catch {
    opened = false
  }
  check('a device cannot open the wrapped key of another', !opened)
}

for (const [name, frame] of Object.entries(v.must_not_verify)) {
  check(`tampered frame rejected: ${name}`, !verifyFrame(frame, boatPub))
}

console.log(failures === 0 ? '\nall vectors pass' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
