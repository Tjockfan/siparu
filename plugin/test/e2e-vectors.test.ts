/**
 * The committed cross-platform vectors, pinned in CI.
 *
 * The frame format is agreed between two implementations in two languages, and
 * only one of them can be run here. What this guards is the half that can be:
 * if the Node reference or the vector file drifts, this goes red on the commit
 * that did it rather than at the point a phone fails to decrypt. The CryptoKit
 * side is run by hand against the same file (see the directory README), and
 * regenerating the vectors means running both again.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - reference implementation, plain JS outside the build
import { ed25519PublicFromRaw, openFrame, signingInput, unb64u, verifyFrame } from '../../dev/e2e-vectors/frame.mjs'

const dir = join(__dirname, '..', '..', 'dev', 'e2e-vectors')
const v = JSON.parse(readFileSync(join(dir, 'vectors.json'), 'utf8'))
const boatPub = ed25519PublicFromRaw(unb64u(v.boat_identity.public))

describe('sealed frame vectors', () => {
  it('builds the committed signing input', () => {
    expect(signingInput(v.frame).toString('hex')).toBe(v.expected_signing_input_hex)
  })

  it('verifies the boat signature', () => {
    expect(verifyFrame(v.frame, boatPub)).toBe(true)
  })

  it('opens the body on every authorised device', () => {
    for (const d of v.devices) {
      expect(openFrame(v.frame, d.kid, unb64u(d.private), unb64u(d.public))).toBe(
        v.expected_plaintext
      )
    }
  })

  it('will not open a wrapped key sealed to another device', () => {
    const [a, b] = v.devices
    expect(() => openFrame(v.frame, a.kid, unb64u(b.private), unb64u(b.public))).toThrow()
  })

  it.each(Object.keys(v.must_not_verify))('rejects a tampered frame: %s', (name) => {
    expect(verifyFrame(v.must_not_verify[name], boatPub)).toBe(false)
  })
})
