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
import type { DevicePublicKey } from './contract'
import type { BoatKeyStore } from './keystore'
import {
  MAX_DEVICES,
  openRequest,
  publicFromPrivate,
  rawPrivate,
  sealFrame,
  type RejectedDevice,
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

/** What became of the last thing she was asked to send. For diagnosis, never for a decision. */
export interface SealState {
  mode: 'sealed' | 'blocked' | 'none'
  /** Why nothing went out, in words a skipper can act on. Null unless blocked. */
  reason: string | null
}

export class Sealer {
  /** What was said about the last batch of unusable keys, so it is said once, not per frame. */
  private lastComplaint = ''
  private lastMode: SealState['mode'] = 'none'
  private lastReason: string | null = null
  /** Who her last sealed frame could not be wrapped to. Empty while nothing is going out. */
  private lastRejected: RejectedDevice[] = []

  constructor(private readonly deps: SealerDeps) {}

  /**
   * The screens her last sealed frame left out, for the health surface.
   *
   * The debug line in sealPayload was the only place these went before, and it is off by
   * default: a screen that stops receiving looked exactly like a boat gone quiet, from
   * every surface a person actually reads. Cleared when she is blocked - no frame went
   * out at all, and a list describing one that did would be a stale answer to a
   * different question.
   */
  rejections(): RejectedDevice[] {
    return this.lastRejected
  }

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

  /** Seal one live report. */
  seal(frame: unknown): SealVerdict {
    return this.sealPayload(frame)
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
      this.lastRejected = rejected

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
    this.lastRejected = []
    return { mode: 'blocked', reason }
  }
}
