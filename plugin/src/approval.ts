/**
 * How a boat decides which screens on a shore-assembled list are really her owner's.
 *
 * The device list arrives over the relay from a database, and both of those are
 * carriers: nothing about arriving on that road proves her owner ever consented to a
 * row. The proof is an approval, minted on a device her owner already holds and
 * verifiable by nobody but this vessel. It is a MAC and not a signature, and that is
 * the design rather than a shortcut: the only party with any stake in the answer is
 * the only party holding a half that can compute it, so a signature's third-party
 * verifiability would buy nothing and cost a second key on every device (the
 * specification's rule that a device needs no signing key stays true).
 *
 * The key agreement is the same X25519 the sealing already runs, between halves that
 * already exist. A device proves itself with the private key it decrypts frames
 * with; the boat verifies with the inbox key those frames are sealed back to. No new
 * credential is created that could be stolen, and whoever has either half was
 * already inside the tent.
 *
 * Trust is rooted in the ANCHOR: the first device of a pairing, whose kid and pub
 * the boat records for herself at the moment somebody stands at her screen and
 * approves the pairing (anchor.ts). From there acceptance is a fixpoint over the
 * answer: the anchor's approvals always verify, because her pub is on this boat's
 * own disk; any accepted entry's approvals verify next, because acceptance is what
 * made its pub trustworthy. An approver absent from both places is exactly the
 * carrier vouching for itself, and is refused.
 *
 * A boat with no anchor on disk was paired before any of this shipped. She behaves
 * as she always has - shape-checked pass-through - and says so in her status, so the
 * cure (re-pair to pin) is named instead of implied. Once an anchor exists there is
 * no road back to pass-through short of unpairing, which only happens aboard.
 *
 * What the chain proves is ADDITION and nothing more. An approval never expires and
 * trust is rebuilt from the answer on every poll, so removal stays with the shore: an
 * honest carrier drops the row and the boat stops sealing to it within a poll, while a
 * hostile one can keep serving a row - and its approval - for as long as it likes. The
 * cure for a device whose private key may be in the wrong hands is a re-pairing
 * aboard, which replaces the root, never a deletion ashore.
 */
import { createHmac, diffieHellman, hkdfSync, timingSafeEqual, type KeyObject } from 'crypto'
import type { DevicePublicKey } from './contract'
import { lp, publicFromPrivate, u16be, x25519PublicFromRaw } from './sealing'

const LABEL = 'siparu/device-approval/v1'
const APPROVAL_VERSION = 1
const KEY_BYTES = 32
export const MAC_BYTES = 32

/** What the boat wrote down about the first device of this pairing. */
export interface DeviceAnchor {
  kid: string
  /** Raw 32-byte X25519 public key, base64url, exactly as it appears on the list. */
  pub: string
}

/**
 * The bytes both ends MAC. Length-prefixed raw fields, never re-serialised JSON, for
 * the reason the frame's signing input is (two implementations in two languages must
 * agree on bytes, and their JSON encoders never reliably will).
 */
export function approvalInput(
  boat: string,
  approverKid: string,
  subjectKid: string,
  subjectPub: Buffer
): Buffer {
  return Buffer.concat([
    Buffer.from(LABEL, 'utf8'),
    u16be(APPROVAL_VERSION),
    lp(Buffer.from(boat, 'utf8')),
    lp(Buffer.from(approverKid, 'utf8')),
    lp(Buffer.from(subjectKid, 'utf8')),
    lp(subjectPub)
  ])
}

/**
 * One derivation, two doors in. The device walks in with its own private half and
 * the boat's inbox public; the boat with her inbox private and the device's public.
 * X25519 gives them the same shared secret either way, and everything after is
 * deterministic from it.
 */
function approvalKey(
  shared: Buffer,
  approverPub: Buffer,
  boat: string,
  approverKid: string,
  subjectKid: string
): Buffer {
  const info = `${LABEL}/${boat}/${approverKid}/${subjectKid}`
  return Buffer.from(hkdfSync('sha256', shared, approverPub, info, KEY_BYTES))
}

/** The device's side: mint the approval. Also the reference the vectors are cut from. */
export function computeApproval(opts: {
  /** The approver's own X25519 private key, the one it opens frames with. */
  approverPriv: KeyObject
  /** The boat's inbox public half, raw 32 bytes. */
  inboxPub: Buffer
  boat: string
  approverKid: string
  subjectKid: string
  /** The key being vouched for, raw 32 bytes, never the base64url text. */
  subjectPub: Buffer
}): Buffer {
  const shared = diffieHellman({
    privateKey: opts.approverPriv,
    publicKey: x25519PublicFromRaw(opts.inboxPub)
  })
  // Salted with the approver's own pub, derived from the private half rather than
  // handed in beside it: two arguments that must agree are one argument too many.
  const approverPub = publicFromPrivate(opts.approverPriv)
  const key = approvalKey(shared, approverPub, opts.boat, opts.approverKid, opts.subjectKid)
  return createHmac('sha256', key)
    .update(approvalInput(opts.boat, opts.approverKid, opts.subjectKid, opts.subjectPub))
    .digest()
}

/** The boat's side: would she accept this approval? */
export function verifyApproval(opts: {
  inboxPriv: KeyObject
  /** The approver's public half, raw 32 bytes, from her own trusted pool. */
  approverPub: Buffer
  boat: string
  approverKid: string
  subjectKid: string
  subjectPub: Buffer
  mac: Buffer
}): boolean {
  if (opts.mac.length !== MAC_BYTES) return false
  let expected: Buffer
  try {
    const shared = diffieHellman({
      privateKey: opts.inboxPriv,
      publicKey: x25519PublicFromRaw(opts.approverPub)
    })
    const key = approvalKey(shared, opts.approverPub, opts.boat, opts.approverKid, opts.subjectKid)
    expected = createHmac('sha256', key)
      .update(approvalInput(opts.boat, opts.approverKid, opts.subjectKid, opts.subjectPub))
      .digest()
  } catch {
    // A pub that is not a point on the curve, a key object of the wrong type: an
    // approval that cannot even be computed is an approval that does not verify.
    return false
  }
  return timingSafeEqual(expected, opts.mac)
}

/** An entry she will not seal to, and the reason in words her status can carry. */
export interface SkippedDevice {
  kid: string
  reason: string
}

export interface AcceptResult {
  /** Anchor rows first, then the order acceptance reached them. The sealer does not care. */
  accepted: DevicePublicKey[]
  /** Pinned mode only; empty on a pass-through. */
  skipped: SkippedDevice[]
  /** Whether an anchor governed this answer at all. */
  pinned: boolean
}

/**
 * The fixpoint. Which entries of the shore's answer this boat seals to.
 *
 * `anchor` is what her disk says: null for a boat that has never pinned (every
 * vessel paired before this shipped), 'broken' for a file she wrote once and can no
 * longer read. Broken accepts NOBODY - she had pinned, and loosening because a
 * sector tore would make corruption the carrier's way of asking for the old,
 * trusting boat back. Silence with a named reason is the whole philosophy here.
 */
export function acceptDevices(opts: {
  anchor: DeviceAnchor | null | 'broken'
  entries: DevicePublicKey[]
  inboxPriv: KeyObject | undefined
  boat: string | undefined
}): AcceptResult {
  const { anchor, entries, inboxPriv, boat } = opts

  if (anchor === null) {
    return { accepted: [...entries], skipped: [], pinned: false }
  }

  const skipped: SkippedDevice[] = []
  if (anchor === 'broken' || !boat) {
    return {
      accepted: [],
      skipped: entries.map((e) => ({
        kid: e.kid,
        reason:
          anchor === 'broken'
            ? 'the anchor on disk cannot be read; re-pair to pin the screens again'
            : 'the boat is not paired'
      })),
      pinned: true
    }
  }

  /** Public halves she trusts as approvers: the anchor from disk, then each accepted entry. */
  const trusted = new Map<string, Buffer>()
  const anchorPub = decodePub(anchor.pub)
  if (anchorPub) trusted.set(anchor.kid, anchorPub)

  const accepted: DevicePublicKey[] = []
  const pending = new Map<DevicePublicKey, string>()

  for (const entry of entries) {
    if (entry.kid === anchor.kid) {
      // Compared as BYTES, like every other place a key is judged. One key has four
      // base64url spellings, and the anchor's row arrives by a different road than the
      // record on disk; a text comparison would let a carrier respell one character and
      // black out the owner's first screen while printing an accusation of key
      // substitution about a key nobody changed.
      const entryPub = decodePub(entry.pub)
      if (anchorPub && entryPub?.equals(anchorPub)) {
        accepted.push(entry)
      } else {
        skipped.push({
          kid: entry.kid,
          reason: 'carries the anchor id over a different key'
        })
      }
      continue
    }
    pending.set(entry, '')
  }

  // Each pass accepts what the current pool can vouch for and widens the pool with
  // it. Five entries at most, so the worst case is a handful of cheap agreements,
  // and the order the shore happened to send the list in stops mattering.
  let grew = true
  while (grew) {
    grew = false
    for (const [entry] of pending) {
      const verdict = admissible(entry, trusted, inboxPriv, boat)
      if (verdict === true) {
        accepted.push(entry)
        const pub = decodePub(entry.pub)
        if (pub) trusted.set(entry.kid, pub)
        pending.delete(entry)
        grew = true
      } else {
        pending.set(entry, verdict)
      }
    }
  }

  for (const [entry, reason] of pending) {
    skipped.push({ kid: entry.kid, reason })
  }

  return { accepted, skipped, pinned: true }
}

/**
 * True to accept, or the reason not to, in words.
 *
 * Every voucher the entry carries is tried, and one that verifies is enough. The shore
 * hands over all of them precisely because it cannot tell which one this boat can use:
 * the anchor is on her disk and nowhere else, so a voucher from a device retired ashore
 * may be the only verifiable one on the row while a voucher from a device still listed
 * chains to nothing.
 */
function admissible(
  entry: DevicePublicKey,
  trusted: Map<string, Buffer>,
  inboxPriv: KeyObject | undefined,
  boat: string
): true | string {
  const approvals = entry.approvals ?? []
  if (approvals.length === 0) {
    return 'carries no approval from a device this boat trusts'
  }
  if (!inboxPriv) {
    return 'the boat holds no inbox key yet to verify the approval with'
  }
  const subjectPub = decodePub(entry.pub)
  const refusals: Refusal[] = []
  for (const { by, mac } of approvals) {
    const approverPub = trusted.get(by)
    if (!approverPub) {
      refusals.push({ rank: 2, text: `approved by "${by}", which this boat does not trust` })
      continue
    }
    const raw = decodeMac(mac)
    if (!subjectPub || !raw) {
      refusals.push({ rank: 1, text: 'the approval is malformed' })
      continue
    }
    const ok = verifyApproval({
      inboxPriv,
      approverPub,
      boat,
      approverKid: by,
      subjectKid: entry.kid,
      subjectPub,
      mac: raw
    })
    if (ok) return true
    refusals.push({ rank: 0, text: 'the approval does not verify' })
  }
  return worst(refusals)
}

/** One rejected voucher. Lower rank is the more alarming thing to say out loud. */
interface Refusal {
  rank: number
  text: string
}

/**
 * The one sentence a row's refusals are worth on a status page.
 *
 * The most alarming first: a voucher from a device she DOES trust that fails to verify
 * is either corruption or somebody forging, where an unverifiable approver is the
 * ordinary shape of a chain that has not reached this row yet. The count rides along
 * once there is more than one, because an owner mid-approval and a list somebody is
 * stuffing read identically without it.
 */
function worst(refusals: Refusal[]): string {
  const first = refusals.reduce((best, r) => (r.rank < best.rank ? r : best))
  return refusals.length === 1
    ? first.text
    : `${first.text} (${refusals.length} approvals, none accepted)`
}

function decodePub(pub: string): Buffer | null {
  const raw = Buffer.from(pub, 'base64url')
  return raw.length === 32 ? raw : null
}

function decodeMac(mac: string): Buffer | null {
  const raw = Buffer.from(mac, 'base64url')
  return raw.length === MAC_BYTES ? raw : null
}
