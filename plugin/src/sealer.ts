/**
 * How a report leaves this boat, which is sealed or not at all.
 *
 * There used to be a third answer here: report in the clear, for a vessel whose owner had
 * authorised no screen yet. It was how this shipped without taking anyone's live view away,
 * and it is gone. What it left behind was a way for the product to break its own promise
 * without anybody noticing, because a cleartext frame and a sealed one look the same from
 * the bridge and the same on a chart ashore. The list of screens arrives over a channel the
 * boat does not control, so as long as an empty list meant cleartext, whoever carried that
 * list decided whether she was private.
 *
 * So there are two answers. Report sealed (somebody is authorised), or send nothing at all
 * (nobody is, or not one of their keys can be used). The second is deliberately not a
 * fallback: silence is visible on her owner's screen, and a leak is not.
 */
import { verifyRuleProof, type ParsedRuleWrite } from './alertrules'
import type { AlertLevel, AlertNote, DevicePublicKey } from './contract'
import type { BoatKeyStore } from './keystore'
import {
  MAX_DEVICES,
  openRequest,
  publicFromPrivate,
  rawPrivate,
  sealFrame,
  type SealedFrame
} from './sealing'

export type SealVerdict =
  /** Sealed to every authorised screen. */
  | { mode: 'sealed'; frame: SealedFrame }
  /**
   * There is nobody she can seal this to.
   *
   * The caller sends nothing. A frame nobody can open is indistinguishable on the wire from
   * a healthy one, so sending it would leave the owner's connection indicator claiming all
   * is well while his screen never moves.
   */
  | { mode: 'blocked'; reason: string }

export interface SealerDeps {
  keys: BoatKeyStore
  /** The screens the shore says may read her, as the key poll last answered. */
  devices: () => DevicePublicKey[]
  /**
   * Whether anybody has ever been authorised to read this boat.
   *
   * It no longer decides anything about how she reports: without a cleartext path an empty
   * list is silence either way. What it still decides is which silence a skipper is looking
   * at, and those are not the same problem. A boat nobody has asked to read yet is waiting
   * for her owner to add a screen; a boat whose screens went away has lost something she
   * had, and the row ashore is where to look. An empty list looks identical in both cases,
   * so her own memory of having been told is the only thing that can tell them apart.
   */
  latched: () => boolean
  /** Her id ashore, which is signed into every frame. Absent until she is paired. */
  boatId: () => string | undefined
  debug: (msg: string) => void
}

/**
 * The block size a sealed sentence is padded up to before it is encrypted.
 *
 * Ciphertext length is the one thing about a note that a carrier and Apple can both measure,
 * and message lengths differ enough between conditions to be a hint about which one rang.
 * Padding to a block makes every ordinary note the same size on the wire. It is a cheap
 * measure against a weak channel, which is the right trade when the alternative is leaving a
 * hint in something the whole product is built to keep unreadable.
 */
export const NOTE_BLOCK_BYTES = 256

/** One sealed sentence, padded so its length says nothing about which condition it is. */
function paddedNote(note: unknown): string {
  const json = JSON.stringify(note)
  const bytes = Buffer.byteLength(json, 'utf8')
  const block = Math.ceil(bytes / NOTE_BLOCK_BYTES) * NOTE_BLOCK_BYTES
  // Trailing spaces, so the reader is an ordinary JSON.parse rather than a length header
  // both sides have to agree about.
  return json + ' '.repeat(block - bytes)
}

/** What became of the last thing she was asked to send. For diagnosis, never for a decision. */
export interface SealState {
  mode: 'sealed' | 'blocked' | 'none'
  /** Why nothing went out, in words a skipper can act on. Null unless blocked. */
  reason: string | null
}

export class Sealer {
  /** What was said about the last batch of unusable keys, so it is said once, not per frame. */
  private lastComplaint = ''
  /** What was said about the last unsealable note, for the same reason. */
  private lastNoteComplaint = ''
  private lastMode: SealState['mode'] = 'none'
  private lastReason: string | null = null

  constructor(private readonly deps: SealerDeps) {}

  /**
   * What she did with the last frame.
   *
   * Blocked is the state this whole file exists to make possible, and it is also the state
   * that looks, from every screen in the product, exactly like a boat that has lost her
   * connection: nothing arrives either way. So it is reported somewhere a person can read it,
   * rather than left in a debug log that is off by default.
   */
  state(): SealState {
    return { mode: this.lastMode, reason: this.lastReason }
  }

  /**
   * Seal one live report, carrying how loud she is as a signed extension.
   *
   * The severity is the one field a carrier is meant to read, because it has to know that a
   * notification is due; signing it is what stops it deciding that one is not. What the
   * condition actually is stays in the body.
   *
   * Sent on every frame, including when nothing is wrong. Ashore the bell rings on the rise
   * and the fall back to normal is what re-arms it, so a boat that mentioned her severity
   * only while something was wrong would ring for her first alarm of the day and stay silent
   * for every one after it.
   */
  seal(frame: unknown, alert?: AlertLevel, note?: AlertNote, risenAt?: number): SealVerdict {
    const extensions: Record<string, string> = {}
    if (alert) extensions.alert = alert
    // Which event the severity is about. Signed like the severity and for the same reason: a
    // carrier that could rewrite it would decide which alarms are new, which is the same
    // switch as deciding which ones are loud.
    //
    // Left off entirely while nothing audible has ever stood, so the ordinary quiet day sends
    // exactly what it sent before this existed - and an older shore, which never reads this
    // field, keeps working off the severity alone.
    if (risenAt !== undefined && risenAt > 0) extensions.alert_at = String(Math.trunc(risenAt))
    // A note that cannot be sealed does not stop the frame. The cost of leaving it out is a
    // generic notification, which is what every notification was until today; the cost of
    // refusing the frame would be a boat that goes quiet on her owner's screen because she
    // could not write a sentence.
    if (note) {
      const sealed = this.sealNote(note)
      if (sealed) extensions.note = sealed
    }
    return this.sealPayload(frame, Object.keys(extensions).length > 0 ? extensions : undefined)
  }

  /**
   * One sentence, sealed to the same screens and signed on its own.
   *
   * A whole frame rather than a bare ciphertext, because the carrier lifts this out and hands
   * it to Apple by itself: alone on that path it still has to prove whose it is and when it
   * was made. The signature is what stops a carrier writing its own sentence into a
   * notification, and `boat` and `ts` are what stop it replaying yesterday's.
   *
   * Its wrapped keys are inside its signature, so the carrier passes the block on whole. It
   * cannot drop the other devices' wraps to save room, and it is not asked to understand any
   * of it.
   */
  private sealNote(note: AlertNote): string | undefined {
    const devices = this.deps.devices()
    const boat = this.deps.boatId()
    const keys = this.deps.keys.get()
    if (devices.length === 0 || !boat || !keys) return undefined

    try {
      const { frame } = sealFrame({
        boat,
        ts: Date.now(),
        plaintext: paddedNote(note),
        devices: devices.slice(0, MAX_DEVICES).map((d) => ({
          kid: d.kid,
          pub: Buffer.from(d.pub, 'base64url')
        })),
        identity: keys.identity
      })
      this.lastNoteComplaint = ''
      return Buffer.from(JSON.stringify(frame), 'utf8').toString('base64url')
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'could not seal this note'
      if (reason !== this.lastNoteComplaint) {
        this.deps.debug(`sealing the alert note: ${reason}`)
        this.lastNoteComplaint = reason
      }
      return undefined
    }
  }

  /**
   * Seal an answer to a question the shore asked, carrying the request id as a signed
   * extension so that the screen waiting on it can tell which question it belongs to.
   *
   * The id is signed rather than only carried alongside: the relay routes by the copy in the
   * clear, and if the sealed answer did not name its own question a relay could hand a screen
   * the answer to a different one and the screen would have no way to tell.
   *
   * The answer goes to every authorised screen rather than only the asker, because a request
   * does not name its sender: nothing in the envelope says which device holds which key. The
   * relay delivers it to the one socket that asked, and the rest belong to the same owner.
   */
  answer(payload: unknown, id: string): SealVerdict {
    if (id.length === 0) return this.blocked('an answer with no question to match it')
    return this.sealPayload(payload, { id })
  }

  /**
   * Open a question sealed to this boat's inbox.
   *
   * Returns nothing rather than throwing on anything that is not a question addressed to her.
   * This runs on whatever arrives over the socket, and the relay can no longer sort it: an
   * envelope for another vessel, a stale key, or a passer-by's noise all arrive the same way,
   * and none of them is a fault worth interrupting a live link for.
   *
   * Opening one authorises nothing. It proves the sender knew a public key, which is public.
   * What may be asked is decided where it always was, by the narrow guards on each request
   * type, and every one of them is a read of her own store.
   */
  open(envelope: unknown): { id: string; plaintext: string } | undefined {
    const boat = this.deps.boatId()
    const keys = this.deps.keys.get()
    if (!boat || !keys) return undefined
    try {
      return openRequest(envelope, boat, rawPrivate(keys.inbox), publicFromPrivate(keys.inbox))
    } catch {
      return undefined
    }
  }

  /**
   * Whether a rule write was really made by the device it names.
   *
   * The only question of this kind the boat ever asks. Every other message from the shore is a
   * read, and a read needs no proof: the answer is sealed to her owner's screens whoever asked,
   * so a stranger learns nothing from a reply he cannot open. A write is different, because her
   * inbox key is public - without this, anybody who knew it could silence her alarms, and the
   * owner would find out the next time something went wrong and his phone stayed quiet.
   *
   * The device list is the one the key poll keeps current, so a screen removed ashore loses the
   * ability to write within one interval, exactly as it loses the ability to read. That is what
   * makes revocation mean something here, and it costs no extra machinery.
   *
   * False on anything at all: an unknown device, a boat that is not paired, a proof that does
   * not hold. The caller answers such a write with silence rather than a refusal.
   */
  proves(req: ParsedRuleWrite): boolean {
    const boat = this.deps.boatId()
    const keys = this.deps.keys.get()
    if (!boat || !keys) return false
    // The same slice the frame path applies, so writing and reading are the same authority. A
    // screen past the ceiling receives no frames at all (sealFrame skips it and names it in
    // `rejected`), and a device that cannot read a word she says has no business deciding when
    // her alarms are heard.
    //
    // Exactly one match, and a list carrying the same kid twice is refused rather than resolved
    // by taking the first. The list is assembled ashore over a channel the boat does not
    // control, so "which of these two keys did the owner mean" is a question with no safe
    // answer: taking either would let a duplicate row decide who may silence her.
    const named = this.deps
      .devices()
      .slice(0, MAX_DEVICES)
      .filter((d) => d.kid === req.kid)
    const [device] = named
    if (named.length !== 1 || !device) return false
    return verifyRuleProof({
      req,
      boat,
      inboxPriv: rawPrivate(keys.inbox),
      inboxPub: publicFromPrivate(keys.inbox),
      devicePub: Buffer.from(device.pub, 'base64url')
    })
  }

  private sealPayload(payload: unknown, extensions?: Record<string, string>): SealVerdict {
    const devices = this.deps.devices()
    // Nobody to seal to, so nothing goes. There is no other branch out of here, and that is
    // the whole point: the list arrives from ashore over a channel she does not control, and
    // if an empty one could put her back on the wire in the open then whoever carries the
    // list would decide whether she is private.
    if (devices.length === 0) {
      // Which silence this is, and what to do about it. Neither wording says "her owner
      // removed his screens", because the list also arrives empty when every key in it was
      // unusable and was dropped on the way in, and a skipper reading a diagnosis is owed one
      // that is true in both cases.
      //
      // The cure is named here rather than composed by the screen showing this, because only
      // this file knows that authorising a screen is the cure at all: the two silences below
      // are fixed that way and the two above - no pairing, no keys - are not.
      return this.blocked(
        this.deps.latched()
          ? 'the shore has named no screen this boat can seal to. Authorise one again to bring her back'
          : 'no screen has been authorised to read her yet. Add one in the Siparu app, or on her page ashore'
      )
    }

    const boat = this.deps.boatId()
    const keys = this.deps.keys.get()
    // Authorised screens exist and she cannot seal: not being paired, or having no keys, is
    // not a reason to send her position in the clear to people who are expecting otherwise.
    if (!boat) return this.blocked('this boat has no id ashore yet')
    if (!keys) return this.blocked('this boat has no keys of her own yet')

    try {
      const { frame: sealed, rejected } = sealFrame({
        boat,
        ts: Date.now(),
        plaintext: JSON.stringify(payload),
        // The ceiling is applied ashore, in the boat and in the database alike; the slice
        // here is what keeps a list that somehow arrived long from growing her frames.
        devices: devices.slice(0, MAX_DEVICES).map((d) => ({
          kid: d.kid,
          pub: Buffer.from(d.pub, 'base64url')
        })),
        identity: keys.identity,
        extensions
      })

      // One bad key does not silence her, but it does silence one screen, and a screen that
      // stops receiving looks exactly like a boat that has gone quiet. So it is said out
      // loud - once per change, because this runs every couple of seconds.
      const complaint = rejected.map((r) => `${r.kid}: ${r.reason}`).join(', ')
      if (complaint && complaint !== this.lastComplaint) {
        this.deps.debug(`sealing: skipped ${rejected.length} device(s) - ${complaint}`)
      }
      this.lastComplaint = complaint

      this.lastMode = 'sealed'
      this.lastReason = null
      return { mode: 'sealed', frame: sealed }
    } catch (e) {
      // sealFrame refuses when no device at all could be sealed to. That refusal is the
      // point: it arrives here as silence rather than as a cleartext frame.
      return this.blocked(e instanceof Error ? e.message : 'could not seal this frame')
    }
  }

  private blocked(reason: string): SealVerdict {
    if (reason !== this.lastComplaint) {
      this.deps.debug(`sealing blocked: ${reason}`)
      this.lastComplaint = reason
    }
    this.lastMode = 'blocked'
    this.lastReason = reason
    return { mode: 'blocked', reason }
  }
}
