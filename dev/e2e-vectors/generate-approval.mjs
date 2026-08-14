/**
 * Generate the cross-platform vectors for the device approval MAC.
 *
 * Its own file, like the fingerprint's, and for the same reason: regenerating a
 * vector file means rerunning every verifier by hand, and a change to how devices
 * vouch for each other has no business costing a fresh pass over the frame format.
 *
 *   node dev/e2e-vectors/generate-approval.mjs > dev/e2e-vectors/approval-vectors.json
 *
 * The private halves committed here are minted for the vectors and exist nowhere
 * else. They are what lets a second implementation recompute the MACs, and they
 * authorise nothing.
 */
import { generateKeyPairSync } from 'node:crypto'
import { APPROVAL_LABEL, APPROVAL_VERSION, approvalInput, boatMac, deviceMac } from './approval.mjs'

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const jwk = (key) => key.export({ format: 'jwk' })
const pair = () => {
  const { privateKey } = generateKeyPairSync('x25519')
  const j = jwk(privateKey)
  return { priv: Buffer.from(j.d, 'base64url'), pub: Buffer.from(j.x, 'base64url') }
}

const BOAT = 'b7e0a9d2-31c4-4f66-8a02-5d9c41e7f310'
const inbox = pair()
const anchor = pair()
const later = pair()
const tablet = pair()

function vector(note, approver, approverKid, subject, subjectKid, boat = BOAT) {
  const args = {
    approverPriv: approver.priv,
    approverPub: approver.pub,
    inboxPub: inbox.pub,
    boat,
    approverKid,
    subjectKid,
    subjectPub: subject.pub
  }
  const mac = deviceMac(args)
  const fromBoat = boatMac({
    inboxPriv: inbox.priv,
    inboxPub: inbox.pub,
    approverPub: approver.pub,
    boat,
    approverKid,
    subjectKid,
    subjectPub: subject.pub
  })
  if (!mac.equals(fromBoat)) throw new Error('the two doors into the derivation disagree')
  return {
    note,
    boat,
    approver: { kid: approverKid, private: b64u(approver.priv), public: b64u(approver.pub) },
    subject: { kid: subjectKid, public: b64u(subject.pub) },
    input_hex: approvalInput(boat, approverKid, subjectKid, subject.pub).toString('hex'),
    mac: b64u(mac)
  }
}

const cases = [
  vector('the anchor vouching for a later phone', anchor, 'anchor-phone-0001', later, 'later-phone-0002'),
  vector('that phone vouching for a tablet in turn', later, 'later-phone-0002', tablet, 'family-tablet-03'),
  vector(
    'same keys, another vessel: the boat id splits the derivation',
    anchor,
    'anchor-phone-0001',
    later,
    'later-phone-0002',
    '0d3f2b18-9c55-47ab-b1e4-77a6c2d90e44'
  )
]

/**
 * One key, two spellings, one MAC. The last character of a 43-character base64url
 * encoding carries two bits no byte reads. The MAC is over the DECODED bytes, so a
 * carrier respelling the subject key must change nothing - an implementation that
 * MACs the text it received would refuse an honest approval whenever the spelling
 * drifted between the row that was approved and the row that was served.
 *
 * The +1 below is always a legal alias, not luck: a canonical encoding of 32 bytes
 * leaves the final character's two slack bits clear, so its alphabet index is a
 * multiple of four and the next index re-reads to the same bytes.
 */
const canonical = b64u(later.pub)
const alias = canonical.slice(0, -1) + B64URL[B64URL.indexOf(canonical.slice(-1)) + 1]

process.stdout.write(
  JSON.stringify(
    {
      label: APPROVAL_LABEL,
      version: APPROVAL_VERSION,
      inbox: { private: b64u(inbox.priv), public: b64u(inbox.pub) },
      cases,
      alias: { subject_public: alias, same_mac_as_case: 0 }
    },
    null,
    2
  ) + '\n'
)
