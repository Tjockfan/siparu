/**
 * The switch between reporting in the clear and reporting sealed.
 *
 * A boat seals as soon as there is somebody to seal to, and not before. That is the whole
 * rule, and everything awkward about this file comes from the one thing it must never do:
 * fall back to cleartext once she has started. A vessel that quietly reverted because a key
 * looked wrong, or because the list came back empty on a bad poll, would be a vessel whose
 * confidentiality depends on the weather - and nobody would notice, because a cleartext
 * frame and a sealed one look the same from the bridge.
 *
 * So there are three answers here, not two. Report in the clear (nobody is authorised),
 * report sealed (somebody is), or send nothing at all (somebody is authorised and not one
 * of their keys can be used). The third is deliberately not a fallback: silence is visible
 * on her owner's screen, and a leak is not.
 */
import type { DevicePublicKey } from './contract'
import type { BoatKeyStore } from './keystore'
import { MAX_DEVICES, sealFrame, type SealedFrame } from './sealing'

export type SealVerdict =
  /** Nobody has been authorised. She reports as she always has. */
  | { mode: 'clear' }
  /** Sealed to every authorised screen. */
  | { mode: 'sealed'; frame: SealedFrame }
  /**
   * Screens are authorised and none of them could be sealed to.
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
  /** Her id ashore, which is signed into every frame. Absent until she is paired. */
  boatId: () => string | undefined
  debug: (msg: string) => void
}

export class Sealer {
  /** What was said about the last batch of unusable keys, so it is said once, not per frame. */
  private lastComplaint = ''

  constructor(private readonly deps: SealerDeps) {}

  /** Whether frames are going out sealed right now. For the screen, and for the fallback
   *  path, which must not carry in the clear what this one is encrypting. */
  active(): boolean {
    return this.deps.devices().length > 0
  }

  seal(frame: unknown): SealVerdict {
    const devices = this.deps.devices()
    if (devices.length === 0) return { mode: 'clear' }

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
        plaintext: JSON.stringify(frame),
        // The ceiling is applied ashore, in the boat and in the database alike; the slice
        // here is what keeps a list that somehow arrived long from growing her frames.
        devices: devices.slice(0, MAX_DEVICES).map((d) => ({
          kid: d.kid,
          pub: Buffer.from(d.pub, 'base64url')
        })),
        identity: keys.identity
      })

      // One bad key does not silence her, but it does silence one screen, and a screen that
      // stops receiving looks exactly like a boat that has gone quiet. So it is said out
      // loud - once per change, because this runs every couple of seconds.
      const complaint = rejected.map((r) => `${r.kid}: ${r.reason}`).join(', ')
      if (complaint && complaint !== this.lastComplaint) {
        this.deps.debug(`sealing: skipped ${rejected.length} device(s) - ${complaint}`)
      }
      this.lastComplaint = complaint

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
    return { mode: 'blocked', reason }
  }
}
