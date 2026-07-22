/**
 * The boat telling the shore who she is.
 *
 * Her identity key signs every sealed frame and her inbox key receives what a device
 * seals back to her, and neither is any use to anybody until the public halves are
 * somewhere a phone can fetch them. That somewhere is the account, reached through
 * the relay, authenticated by the token she already holds.
 *
 * Two rules shape everything below.
 *
 * The keys are made only once she is PAIRED. An unpaired vessel has nobody to talk
 * to, and a key pair generated on a machine that is only ever going to run the local
 * dashboard is a credential created for no reason (the specification says the same:
 * created at first pairing, kept for life).
 *
 * Publishing is write-once ashore, so it does not matter how often she says it: the
 * same pair is not a change and the shore answers 'ok' either way. She therefore keeps
 * no memory across a restart of whether it landed.
 *
 * The same call answers the other question she needs asked continuously - which screens
 * her owner has authorised - so the two share a poll rather than each having their own.
 * A device added ashore starts receiving within one interval, and a device removed stops
 * within one, which is what revocation means in practice.
 *
 * Read-only, like everything else here: this talks outbound to the relay and never to
 * Signal K. Nothing in this file emits a delta or a PUT.
 */
import type { DevicePublicKey } from './contract'
import type { BoatKeyStore } from './keystore'
import type { RemoteLink } from './remotelink'

export type KeySyncState =
  /** Not paired, or not tried yet. */
  | 'idle'
  /** The shore holds her keys. Nothing more to do until she is paired again. */
  | 'published'
  /**
   * The shore holds DIFFERENT keys for this boat, and refused to replace them.
   *
   * Not a transient error and not retried. It means this vessel's row ashore was
   * published by another copy of her - a restored SD card, a cloned virtual machine -
   * or that her own keys.json was lost and rebuilt. Devices recognise her by the keys
   * ashore, so sealed reporting cannot work until she is unlinked and paired again.
   */
  | 'mismatch'
  /** The relay did not answer, or refused. She keeps trying. */
  | 'failing'

export interface KeySyncStatus {
  state: KeySyncState
  /** In words a skipper can act on, null while nothing is wrong. */
  lastError: string | null
  /** How many screens the shore says may read her. Zero until her owner adds one. */
  devices: number
}

export interface KeySyncDeps {
  relayUrl: string
  getRemote: () => RemoteLink | undefined
  keys: BoatKeyStore
  debug: (msg: string) => void
  /** Retry interval. Minutes in production; tests need it shorter. */
  intervalMs?: number
}

/**
 * How often she asks.
 *
 * Five minutes is the cost of adding a screen: a device her owner authorises ashore starts
 * receiving within one interval, and one he removes stops within one. Faster would buy him
 * seconds on an errand he runs once a year, and cost every boat in the fleet a request every
 * time. Slower would make revocation feel broken.
 */
const DEFAULT_INTERVAL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 20_000
const MAX_BACKOFF_MS = 30 * 60_000

export class KeySync {
  private timer: NodeJS.Timeout | null = null
  private inFlight: AbortController | null = null
  private readonly intervalMs: number
  private stopped = false
  private failures = 0
  private state: KeySyncState = 'idle'
  private lastError: string | null = null
  private published = false
  private deviceList: DevicePublicKey[] = []

  constructor(private readonly deps: KeySyncDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.schedule(this.intervalMs)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // A request still in the air outlives the plugin that started it: Signal K restarts
    // plugins on every config save, so this is routine rather than exotic.
    this.inFlight?.abort()
    this.inFlight = null
  }

  status(): KeySyncStatus {
    return { state: this.state, lastError: this.lastError, devices: this.deviceList.length }
  }

  /**
   * The screens she may seal to, as the shore last answered.
   *
   * Empty means exactly that: nobody is authorised, and she reports in the clear as she
   * always has. It is never a stand-in for "we could not ask" - a failed poll leaves the
   * previous answer in place rather than emptying it, because a boat that quietly stopped
   * sealing because a request timed out would be a boat whose promise depends on the weather.
   */
  devices(): DevicePublicKey[] {
    return this.deviceList
  }

  /** A new pairing is a new life ashore: the previous link's verdict is not hers, and
   *  neither are the screens the last account had authorised. */
  reset(): void {
    this.failures = 0
    this.state = 'idle'
    this.lastError = null
    this.published = false
    this.deviceList = []
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, delayMs)
  }

  private async tick(): Promise<void> {
    const remote = this.deps.getRemote()

    // Not paired: no keys are made and nothing is sent. The timer keeps running, so
    // pairing her mid-passage publishes without waiting for a restart.
    if (!remote) {
      if (!this.stopped) this.schedule(this.intervalMs)
      return
    }

    await this.poll(remote)

    // stop() may have landed while the request was in the air; rescheduling here would
    // resurrect a stopped instance on a token that may already be stale.
    if (this.stopped) return

    // The poll never ends: the device list is a live answer, not a one-time fact. Only the
    // gap widens, and only while she is failing.
    this.schedule(
      this.failures === 0
        ? this.intervalMs
        : Math.min(this.intervalMs * 2 ** (this.failures - 1), MAX_BACKOFF_MS)
    )
  }

  private async poll(remote: RemoteLink): Promise<void> {
    // Generated here rather than at pairing time so that a boat which was paired before this
    // code existed - every vessel already in service - makes hers on the next start instead
    // of having to be paired again for a feature she never asked for.
    await this.deps.keys.ensure()
    const pub = this.deps.keys.publicKeys()
    if (!pub) {
      // ensure() answered and there are still no keys: the disk refused the write. Nothing to
      // publish, and publishing keys the boat could not keep would be worse than not trying -
      // she would be recorded ashore under an identity she cannot sign with.
      this.failures++
      this.state = 'failing'
      this.lastError = 'Could not create the keys for this boat on disk.'
      this.deps.debug('keysync: no keys to publish')
      return
    }

    const controller = new AbortController()
    this.inFlight = controller
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      // Her keys ride along until the shore has confirmed them, and stop being sent once it
      // has: after that this is a read, and there is nothing to say that has not been said.
      const res = await fetch(`${this.deps.relayUrl}/keys`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${remote.boatToken}`
        },
        body: JSON.stringify(
          this.published ? {} : { identity: pub.identity, inbox: pub.inbox }
        ),
        signal: controller.signal
      })

      if (!res.ok) {
        this.failures++
        this.state = 'failing'
        this.lastError =
          res.status === 401
            ? 'Siparu no longer recognises this boat. Pair her again.'
            : `Siparu refused the keys for this boat (${res.status}).`
        this.deps.debug(`keysync: ${this.lastError}`)
        return
      }

      const answer = (await res.json()) as { keys?: unknown; devices?: unknown }

      if (answer?.keys === 'mismatch') {
        // Not transient and not retried away: the row ashore was written by another copy of
        // her, or her own key file was lost and rebuilt. Devices recognise her by what is
        // ashore, so the cure is an unlink and a fresh pairing. The poll goes on, because the
        // device list is still worth having: what she cannot do is change the identity.
        this.state = 'mismatch'
        this.lastError =
          'Siparu already holds different keys for this boat. Unlink her and pair again.'
        this.deps.debug(`keysync: ${this.lastError}`)
        this.published = true
      } else if (answer?.keys === 'ok') {
        this.published = true
        this.state = 'published'
        this.lastError = null
      } else if (!this.published) {
        // A 200 that confirmed nothing, from a boat that still needs confirming: an older
        // relay that knows nothing about keys, or a newer one speaking a word this build has
        // not learned. Refused rather than assumed good, because a boat certain she is
        // published while the shore holds nothing would seal to screens that cannot verify her.
        this.failures++
        this.state = 'failing'
        this.lastError = 'Siparu did not confirm the keys for this boat.'
        this.deps.debug('keysync: no verdict in the relay answer')
        return
      }

      this.deviceList = readDevices(answer?.devices)
      this.failures = 0
    } catch (e) {
      this.failures++
      // A mismatch is the actionable thing and it outlives a bad connection. Letting a
      // timeout overwrite it would put "cannot reach Siparu" on the screen of a boat whose
      // real problem is that the shore holds another vessel's identity for her - and she
      // would go on being unreachable after the network came back.
      if (this.state !== 'mismatch') {
        this.state = 'failing'
        this.lastError = 'Cannot reach Siparu. Is the boat online?'
      }
      // Offline is the normal state of a boat, not an incident.
      this.deps.debug(`keysync unreachable: ${String(e)}`)
    } finally {
      clearTimeout(timeout)
      this.inFlight = null
    }
  }
}

/**
 * The device list off the wire, rebuilt from a whitelist.
 *
 * This arrives over the internet and is fed straight into a key agreement, so it is checked
 * by shape rather than trusted: an id and exactly the 43 characters a raw 32-byte X25519 key
 * spells in base64url. A malformed entry is dropped here and the rest of the list still
 * stands, for the same reason the sealing code names a bad key instead of refusing to send -
 * the list is assembled ashore, and one bad row in it must never take a vessel off the air.
 */
function readDevices(raw: unknown): DevicePublicKey[] {
  if (!Array.isArray(raw)) return []
  const out: DevicePublicKey[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { kid, pub } = entry as { kid?: unknown; pub?: unknown }
    if (typeof kid !== 'string' || !kid || kid.length > 64) continue
    if (typeof pub !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pub)) continue
    out.push({ kid, pub })
  }
  return out
}
