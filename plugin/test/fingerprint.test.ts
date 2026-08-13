/**
 * The committed fingerprint vectors, held against both implementations that run here.
 *
 * Two describes rather than one file each, because the two failures are different and both
 * matter: the reference drifting from the vectors, and the shipping module drifting from the
 * reference. A single check against the module would stay green if both moved together, which
 * is exactly what a transcription error looks like.
 *
 * The third implementation is the app's, in CryptoKit, and it is held to this same file by the
 * phone's own test suite. Regenerating the vectors means rerunning that one too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - reference implementation, plain JS outside the build
import { fingerprint as reference } from '../../dev/e2e-vectors/fingerprint.mjs'
import { deviceFingerprint, fingerprintOfEncoded } from '../src/fingerprint'

const vectors = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'dev', 'e2e-vectors', 'fingerprint-vectors.json'), 'utf8')
) as {
  cases: { note: string; public: string; fingerprint: string }[]
  alias: { public: string; fingerprint: string }
}

const raw = (b64u: string) => Buffer.from(b64u, 'base64url')

describe('device fingerprint vectors', () => {
  it('the reference prints the committed strings', () => {
    for (const c of vectors.cases) {
      expect(reference(raw(c.public)), c.note).toBe(c.fingerprint)
    }
  })

  it('the shipping module prints the committed strings', () => {
    for (const c of vectors.cases) {
      expect(deviceFingerprint(raw(c.public)), c.note).toBe(c.fingerprint)
    }
  })

  /**
   * The deceit the format exists to prevent. Whoever passes a key along chooses how it is
   * spelled, and if the spelling changed the string, a relay could show the boat and the phone
   * two different fingerprints for one key and neither of them would be looking at a lie about
   * the key itself.
   */
  it('reads the same for a key spelled with its spare bits set', () => {
    expect(raw(vectors.alias.public)).toEqual(raw(vectors.cases[0].public))
    expect(fingerprintOfEncoded(vectors.alias.public)).toBe(vectors.alias.fingerprint)
  })

  it('gives two screens on one account different strings', () => {
    const [phone, tablet] = vectors.cases
    expect(deviceFingerprint(raw(phone.public))).not.toBe(deviceFingerprint(raw(tablet.public)))
  })
})

describe('what it prints', () => {
  it('is sixteen characters in four groups, always', () => {
    for (const c of vectors.cases) {
      expect(deviceFingerprint(raw(c.public)), c.note).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/
      )
    }
  })

  /**
   * Not a style rule. This is read off one screen and compared with another, in whatever font
   * each of them happens to use, by somebody who has decided to be suspicious. A capital I next
   * to a 1 is how that comparison fails in the direction where the owner concludes he is under
   * attack and is not.
   */
  it('never uses a letter that can be read as another character', () => {
    const printed = vectors.cases.map((c) => deviceFingerprint(raw(c.public))).join('')
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(printed).not.toContain(ambiguous)
    }
  })
})

describe('keys it will not print', () => {
  it('refuses a key that is not 32 bytes, rather than fingerprinting the wrong thing', () => {
    expect(() => deviceFingerprint(Buffer.alloc(31))).toThrow()
    expect(() => deviceFingerprint(Buffer.alloc(33))).toThrow()
  })

  it('returns null for a row from the shore that is not a key', () => {
    expect(fingerprintOfEncoded('')).toBeNull()
    expect(fingerprintOfEncoded('not-a-key')).toBeNull()
    // 43 characters of the right alphabet is the shape; anything else is a row to drop, not a
    // reason to stop showing the ones that are fine.
    expect(fingerprintOfEncoded('A'.repeat(42))).toBeNull()
    expect(fingerprintOfEncoded('A'.repeat(44))).toBeNull()
    expect(fingerprintOfEncoded('+'.repeat(43))).toBeNull()
  })
})
