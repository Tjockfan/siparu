/**
 * The approval that lets a boat stop trusting the carrier.
 *
 * Two layers are proven here. The MAC itself: both ends derive the same key
 * from opposite halves (approver private + inbox public aboard the device,
 * inbox private + approver public aboard the boat), and every field of the
 * input is load-bearing, so tampering with any one of them refuses the
 * approval. And the chain: which entries of a shore-assembled device list a
 * pinned boat will actually seal to, rooted in the anchor she witnessed at
 * pairing, with every refusal named rather than silent.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acceptDevices,
  approvalInput,
  computeApproval,
  verifyApproval
} from '../src/approval'
import type { DevicePublicKey } from '../src/contract'
import { rawPublic, x25519PrivateFromRaw } from '../src/sealing'

const BOAT = '1e8b7c1a-4a52-4d2f-9c3e-b1a2c3d4e5f6'

interface TestDevice {
  kid: string
  priv: KeyObject
  pub: Buffer
}

function device(kid: string): TestDevice {
  const pair = generateKeyPairSync('x25519')
  return { kid, priv: pair.privateKey, pub: rawPublic(pair.publicKey) }
}

const inbox = generateKeyPairSync('x25519')
const inboxPub = rawPublic(inbox.publicKey)

/** An approval of `subject` made by `approver`, as it would arrive off the wire. */
function approved(...approvers: TestDevice[]): (subject: TestDevice) => DevicePublicKey {
  return (subject) => ({
    kid: subject.kid,
    pub: subject.pub.toString('base64url'),
    approvals: approvers.map((approver) => ({
      by: approver.kid,
      mac: computeApproval({
        approverPriv: approver.priv,
        inboxPub,
        boat: BOAT,
        approverKid: approver.kid,
        subjectKid: subject.kid,
        subjectPub: subject.pub
      }).toString('base64url')
    }))
  })
}

/** The common case: one voucher, from one approver. */
function approvedBy(approver: TestDevice, subject: TestDevice): DevicePublicKey {
  return approved(approver)(subject)
}

function bare(d: TestDevice): DevicePublicKey {
  return { kid: d.kid, pub: d.pub.toString('base64url') }
}

function anchorOf(d: TestDevice): { kid: string; pub: string } {
  return { kid: d.kid, pub: d.pub.toString('base64url') }
}

describe('the approval MAC', () => {
  const a = device('anchor-phone-a1')
  const b = device('later-phone-b2')

  const macOf = (over?: Partial<Parameters<typeof computeApproval>[0]>): Buffer =>
    computeApproval({
      approverPriv: a.priv,
      inboxPub,
      boat: BOAT,
      approverKid: a.kid,
      subjectKid: b.kid,
      subjectPub: b.pub,
      ...over
    })

  it('verifies from the other pair of halves', () => {
    expect(
      verifyApproval({
        inboxPriv: inbox.privateKey,
        approverPub: a.pub,
        boat: BOAT,
        approverKid: a.kid,
        subjectKid: b.kid,
        subjectPub: b.pub,
        mac: macOf()
      })
    ).toBe(true)
  })

  it.each([
    ['boat', { boat: 'f0000000-0000-0000-0000-000000000000' }],
    ['approver kid', { approverKid: 'someone-else-9' }],
    ['subject kid', { subjectKid: 'someone-else-9' }],
    ['subject pub', { subjectPub: rawPublic(generateKeyPairSync('x25519').publicKey) }]
  ] as const)('refuses when the %s differs between the two ends', (_name, change) => {
    expect(
      verifyApproval({
        inboxPriv: inbox.privateKey,
        approverPub: a.pub,
        boat: BOAT,
        approverKid: a.kid,
        subjectKid: b.kid,
        subjectPub: b.pub,
        mac: macOf(change)
      })
    ).toBe(false)
  })

  it('refuses a MAC of the wrong length before comparing anything', () => {
    expect(
      verifyApproval({
        inboxPriv: inbox.privateKey,
        approverPub: a.pub,
        boat: BOAT,
        approverKid: a.kid,
        subjectKid: b.kid,
        subjectPub: b.pub,
        mac: macOf().subarray(0, 16)
      })
    ).toBe(false)
  })

  it('refuses a flipped bit in the MAC itself', () => {
    const mac = macOf()
    mac[0] ^= 0x01
    expect(
      verifyApproval({
        inboxPriv: inbox.privateKey,
        approverPub: a.pub,
        boat: BOAT,
        approverKid: a.kid,
        subjectKid: b.kid,
        subjectPub: b.pub,
        mac
      })
    ).toBe(false)
  })

  it('refuses a MAC minted by a key that is not the named approver', () => {
    const impostor = device(a.kid)
    const mac = computeApproval({
      approverPriv: impostor.priv,
      inboxPub,
      boat: BOAT,
      approverKid: a.kid,
      subjectKid: b.kid,
      subjectPub: b.pub
    })
    expect(
      verifyApproval({
        inboxPriv: inbox.privateKey,
        approverPub: a.pub,
        boat: BOAT,
        approverKid: a.kid,
        subjectKid: b.kid,
        subjectPub: b.pub,
        mac
      })
    ).toBe(false)
  })

  it('builds a length-prefixed input, so no two field splits collide', () => {
    const one = approvalInput(BOAT, 'ab', 'c', Buffer.alloc(32, 7))
    const two = approvalInput(BOAT, 'a', 'bc', Buffer.alloc(32, 7))
    expect(one.equals(two)).toBe(false)
  })
})

describe('what a pinned boat accepts', () => {
  const a = device('anchor-phone-a1')
  const b = device('later-phone-b2')
  const c = device('later-tablet-c3')

  const accept = (
    entries: DevicePublicKey[],
    anchor: { kid: string; pub: string } | null | 'broken' = anchorOf(a)
  ) =>
    acceptDevices({
      anchor,
      entries,
      inboxPriv: inbox.privateKey,
      boat: BOAT
    })

  it('accepts the anchor itself', () => {
    const out = accept([bare(a)])
    expect(out.pinned).toBe(true)
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid])
    expect(out.skipped).toEqual([])
  })

  it('accepts a device the anchor approved, and one that device approved in turn', () => {
    const out = accept([bare(a), approvedBy(a, b), approvedBy(b, c)])
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid, b.kid, c.kid])
  })

  it('reaches a chained device regardless of the order the list arrives in', () => {
    const out = accept([approvedBy(b, c), approvedBy(a, b), bare(a)])
    expect(out.accepted.map((d) => d.kid).sort()).toEqual([a.kid, b.kid, c.kid].sort())
  })

  it('still honours the anchor approvals after the anchor row was removed ashore', () => {
    const out = accept([approvedBy(a, b)])
    expect(out.accepted.map((d) => d.kid)).toEqual([b.kid])
  })

  it('skips and names an entry with no approval at all', () => {
    const out = accept([bare(a), bare(b)])
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid])
    expect(out.skipped).toHaveLength(1)
    expect(out.skipped[0].kid).toBe(b.kid)
    expect(out.skipped[0].reason).toContain('approval')
  })

  it('skips an entry approved by a device that is neither anchor nor accepted', () => {
    // b never appears on the list, so its vouching for c is unverifiable:
    // the only place b's public key could come from is the carrier.
    const out = accept([bare(a), approvedBy(b, c)])
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid])
    expect(out.skipped[0].kid).toBe(c.kid)
  })

  it('skips an entry whose MAC does not verify', () => {
    const forged = {
      ...approvedBy(a, b),
      approvals: [{ by: a.kid, mac: Buffer.alloc(32, 9).toString('base64url') }]
    }
    const out = accept([bare(a), forged])
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid])
    expect(out.skipped[0].kid).toBe(b.kid)
  })

  it.each([
    ['first', (retired: DevicePublicKey, listed: DevicePublicKey) => [retired, listed]],
    ['last', (retired: DevicePublicKey, listed: DevicePublicKey) => [listed, retired]]
  ] as const)(
    'reaches a screen over a retired anchor voucher carried %s, past a listed one that cannot chain',
    (_where, order) => {
      // The shore cannot tell which of these two verifies: it does not know who the
      // anchor is, by design. c sits on the list and looks like the better bet from
      // ashore, but nobody vouched for c, so its voucher for b chains to nothing. The
      // anchor a was retired from the account after the owner upgraded his phone -
      // exactly the flow the design promises not to black out - and its voucher
      // verifies against the pub on her own disk. Handed one voucher rather than both,
      // a boat would go dark on her owner's only screen with nobody at fault.
      const both = approved(a, c)(b)
      const [x, y] = order(
        { by: both.approvals![0].by, mac: both.approvals![0].mac },
        { by: both.approvals![1].by, mac: both.approvals![1].mac }
      )
      const out = accept([bare(c), { ...both, approvals: [x, y] }])
      expect(out.accepted.map((d) => d.kid)).toEqual([b.kid])
      expect(out.skipped.map((s) => s.kid)).toEqual([c.kid])
    }
  )

  it('carries a voucher through a device accepted later in the same answer', () => {
    // b's only good voucher is from c, and c is only accepted once the anchor's
    // voucher for it verifies. Neither entry is acceptable on the first look, so
    // this is the fixpoint doing its job over a list that carries several vouchers
    // per row rather than one.
    const stranger = device('stranger-d4')
    const out = accept([approved(stranger, c)(b), bare(a), approvedBy(a, c)])
    expect(out.accepted.map((d) => d.kid).sort()).toEqual([a.kid, b.kid, c.kid].sort())
    expect(out.skipped).toEqual([])
  })

  it('names how many vouchers it refused when a screen carries several', () => {
    const stranger = device('stranger-d4')
    const out = accept([bare(a), approved(stranger, c)(b)])
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid])
    expect(out.skipped[0].kid).toBe(b.kid)
    // The count is the diagnosis: one refused voucher is an owner mid-approval, and
    // several is a list somebody is stuffing. Both read the same without it.
    expect(out.skipped[0].reason).toContain('2')
  })

  it('refuses a stranger wearing the anchor kid over a different key', () => {
    const impostor = device(a.kid)
    const out = accept([bare(impostor)])
    expect(out.accepted).toEqual([])
    expect(out.skipped[0].kid).toBe(a.kid)
  })

  it('accepts the anchor whatever spelling of its key the carrier chose', () => {
    // One key has four base64url spellings; the row and the disk arrive by different
    // roads. Matched as text, a carrier could respell one character, black out the
    // owner's first screen alone, and have the boat print an accusation of key
    // substitution about a key nobody changed.
    const canonical = a.pub.toString('base64url')
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const alias = canonical.slice(0, -1) + b64[b64.indexOf(canonical.slice(-1)) + 1]
    expect(alias).not.toBe(canonical)
    const out = accept([{ kid: a.kid, pub: alias }])
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid])
    expect(out.skipped).toEqual([])
  })

  it('accepts nobody while the boat is not paired, and says which fault that is', () => {
    // Reachable in the window between an unpair landing and the anchor cache
    // catching up. Pinned with no boat id must not loosen into pass-through.
    const out = acceptDevices({
      anchor: anchorOf(a),
      entries: [bare(a)],
      inboxPriv: inbox.privateKey,
      boat: undefined
    })
    expect(out.pinned).toBe(true)
    expect(out.accepted).toEqual([])
    expect(out.skipped[0].reason).toContain('not paired')
  })

  it('accepts nobody over a broken anchor, because loosening on a torn sector is the attack', () => {
    const out = accept([bare(a), approvedBy(a, b)], 'broken')
    expect(out.pinned).toBe(true)
    expect(out.accepted).toEqual([])
    expect(out.skipped).toHaveLength(2)
  })

  it('passes everything through unpinned, which is every boat paired before this shipped', () => {
    const out = accept([bare(a), bare(b)], null)
    expect(out.pinned).toBe(false)
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid, b.kid])
    expect(out.skipped).toEqual([])
  })

  it('accepts only the anchor while the boat has no inbox key to verify with', () => {
    const out = acceptDevices({
      anchor: anchorOf(a),
      entries: [bare(a), approvedBy(a, b)],
      inboxPriv: undefined,
      boat: BOAT
    })
    expect(out.accepted.map((d) => d.kid)).toEqual([a.kid])
    expect(out.skipped[0].kid).toBe(b.kid)
  })
})

describe('the shipping module, against the committed vectors', () => {
  // The reference is held to the same file in e2e-vectors.test.ts. Both are needed:
  // that one stays green if this module drifts, and this one stays green if the
  // reference does. The CryptoKit side gets its verifier when the app learns to
  // approve (slice C of the design doc) and will be held to this same file.
  const dir = join(__dirname, '..', '..', 'dev', 'e2e-vectors')
  const v = JSON.parse(readFileSync(join(dir, 'approval-vectors.json'), 'utf8'))
  const un = (s: string): Buffer => Buffer.from(s, 'base64url')

  it.each(v.cases.map((c: { note: string }, i: number) => [c.note, i]))(
    'computes and verifies the committed MAC: %s',
    (_note, i) => {
      const c = v.cases[i as number]
      expect(
        approvalInput(c.boat, c.approver.kid, c.subject.kid, un(c.subject.public)).toString('hex')
      ).toBe(c.input_hex)
      expect(
        computeApproval({
          approverPriv: x25519PrivateFromRaw(un(c.approver.private), un(c.approver.public)),
          inboxPub: un(v.inbox.public),
          boat: c.boat,
          approverKid: c.approver.kid,
          subjectKid: c.subject.kid,
          subjectPub: un(c.subject.public)
        }).toString('base64url')
      ).toBe(c.mac)
      expect(
        verifyApproval({
          inboxPriv: x25519PrivateFromRaw(un(v.inbox.private), un(v.inbox.public)),
          approverPub: un(c.approver.public),
          boat: c.boat,
          approverKid: c.approver.kid,
          subjectKid: c.subject.kid,
          subjectPub: un(c.subject.public),
          mac: un(c.mac)
        })
      ).toBe(true)
    }
  )
})

