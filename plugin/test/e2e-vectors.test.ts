/**
 * The committed cross-platform vectors, pinned in CI against the reference.
 *
 * The frame format is agreed between three implementations and only two of
 * them run here. What this guards is the reference: if it or the vector file
 * drifts, this goes red on the commit that did it rather than at the point a
 * phone fails to decrypt. The CryptoKit side is run by hand against the same
 * file (see the directory README), and regenerating the vectors means running
 * all three again.
 *
 * The shipping module is held to the same vectors separately, in
 * sealing.test.ts. Both are needed: this file would stay green if the product
 * code drifted, and that one would stay green if the reference did.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - reference implementation, plain JS outside the build
import { ed25519PublicFromRaw, openFrame, signingInput, verifyFrame } from '../../dev/e2e-vectors/frame.mjs'
// @ts-expect-error - reference implementation, plain JS outside the build
import { approvalInput, boatMac, deviceMac } from '../../dev/e2e-vectors/approval.mjs'

const dir = join(__dirname, '..', '..', 'dev', 'e2e-vectors')
const v = JSON.parse(readFileSync(join(dir, 'vectors.json'), 'utf8'))
/** Key material out of the vector file, which is trusted input, not wire input. */
const un = (s: string): Buffer => Buffer.from(s, 'base64url')
const boatPub = ed25519PublicFromRaw(un(v.boat_identity.public))

describe('sealed frame vectors', () => {
  it('builds the committed signing input', () => {
    expect(signingInput(v.frame).toString('hex')).toBe(v.expected_signing_input_hex)
  })

  it('verifies the boat signature', () => {
    expect(verifyFrame(v.frame, boatPub)).toBe(true)
  })

  it('opens the body on every authorised device', () => {
    for (const d of v.devices) {
      expect(openFrame(v.frame, boatPub, d.kid, un(d.private), un(d.public))).toBe(
        v.expected_plaintext
      )
    }
  })

  it('will not open a wrapped key sealed to another device', () => {
    const [a, b] = v.devices
    expect(() => openFrame(v.frame, boatPub, a.kid, un(b.private), un(b.public))).toThrow()
  })

  it('will not open a frame whose timestamp was rewritten', () => {
    // The reader runs the proof layer itself. A device that only decrypted
    // would show a replayed frame as a current position.
    const d = v.devices[0]
    expect(() =>
      openFrame(v.must_not_verify.ts_rewritten, boatPub, d.kid, un(d.private), un(d.public))
    ).toThrow(/signature does not verify/)
  })

  it.each(Object.keys(v.must_not_verify))('rejects a tampered frame: %s', (name) => {
    expect(verifyFrame(v.must_not_verify[name], boatPub)).toBe(false)
  })
})

describe('device approval vectors', () => {
  const a = JSON.parse(readFileSync(join(dir, 'approval-vectors.json'), 'utf8'))

  it.each(a.cases.map((c: { note: string }, i: number) => [c.note, i]))(
    'recomputes the committed MAC from both doors: %s',
    (_note, i) => {
      const c = a.cases[i as number]
      const args = {
        boat: c.boat,
        approverKid: c.approver.kid,
        subjectKid: c.subject.kid,
        subjectPub: un(c.subject.public)
      }
      expect(
        approvalInput(c.boat, c.approver.kid, c.subject.kid, un(c.subject.public)).toString('hex')
      ).toBe(c.input_hex)
      expect(
        deviceMac({
          ...args,
          approverPriv: un(c.approver.private),
          approverPub: un(c.approver.public),
          inboxPub: un(a.inbox.public)
        }).toString('base64url')
      ).toBe(c.mac)
      expect(
        boatMac({
          ...args,
          inboxPriv: un(a.inbox.private),
          inboxPub: un(a.inbox.public),
          approverPub: un(c.approver.public)
        }).toString('base64url')
      ).toBe(c.mac)
    }
  )

  it("does not care which of a key's four spellings the carrier chose", () => {
    // The MAC is over the decoded bytes. The alias below is the same key with a
    // spare bit of the last character set, which every decoder accepts.
    const c = a.cases[a.alias.same_mac_as_case]
    expect(a.alias.subject_public).not.toBe(c.subject.public)
    expect(
      deviceMac({
        boat: c.boat,
        approverKid: c.approver.kid,
        subjectKid: c.subject.kid,
        subjectPub: un(a.alias.subject_public),
        approverPriv: un(c.approver.private),
        approverPub: un(c.approver.public),
        inboxPub: un(a.inbox.public)
      }).toString('base64url')
    ).toBe(c.mac)
  })
})

