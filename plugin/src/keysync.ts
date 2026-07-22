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
 * Publishing is write-once ashore, so this sends and stops. It does not remember
 * across a restart whether it succeeded, and it does not need to: repeating the same
 * pair is not a change, and the shore answers 'ok' either way. What it does keep
 * knocking about is failure - a boat is offline for days at a time, and the attempt
 * that matters is the one made when she comes back.
 *
 * Read-only, like everything else here: this talks outbound to the relay and never to
 * Signal K. Nothing in this file emits a delta or a PUT.
 */
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
}

export interface KeySyncDeps {
  relayUrl: string
  getRemote: () => RemoteLink | undefined
  keys: BoatKeyStore
  debug: (msg: string) => void
  /** Retry interval. Minutes in production; tests need it shorter. */
  intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 60_000
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
    return { state: this.state, lastError: this.lastError }
  }

  /** A new pairing is a new life ashore: the previous link's verdict is not hers. */
  reset(): void {
    this.failures = 0
    this.state = 'idle'
    this.lastError = null
  }

  /** Published or mismatched: two answers that no further attempt can improve on. */
  private settled(): boolean {
    return this.state === 'published' || this.state === 'mismatch'
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

    // Settled, either way. 'published' has nothing left to say, and 'mismatch' cannot be
    // fixed by asking again - the cure runs on this boat, not on the wire.
    if (this.settled()) return

    await this.publish(remote)

    // stop() may have landed while the request was in the air; rescheduling here would
    // resurrect a stopped instance on a token that may already be stale.
    if (this.stopped) return
    if (this.settled()) return

    this.schedule(Math.min(this.intervalMs * 2 ** Math.max(0, this.failures - 1), MAX_BACKOFF_MS))
  }

  private async publish(remote: RemoteLink): Promise<void> {
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
      const res = await fetch(`${this.deps.relayUrl}/keys`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${remote.boatToken}`
        },
        body: JSON.stringify({ identity: pub.identity, inbox: pub.inbox }),
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

      const answer = (await res.json()) as { keys?: unknown }
      if (answer?.keys === 'ok') {
        this.failures = 0
        this.state = 'published'
        this.lastError = null
        return
      }

      if (answer?.keys === 'mismatch') {
        this.state = 'mismatch'
        this.lastError =
          'Siparu already holds different keys for this boat. Unlink her and pair again.'
        this.deps.debug(`keysync: ${this.lastError}`)
        return
      }

      // A 200 that answered something else: an older relay that does not know about keys yet,
      // or a newer one speaking a word this build has not learned. Treated as a failure and
      // retried rather than assumed good, because the consequence of being wrong is a boat
      // that believes she is published and seals to nobody.
      this.failures++
      this.state = 'failing'
      this.lastError = 'Siparu did not confirm the keys for this boat.'
      this.deps.debug('keysync: no verdict in the relay answer')
    } catch (e) {
      this.failures++
      this.state = 'failing'
      this.lastError = 'Cannot reach Siparu. Is the boat online?'
      // Offline is the normal state of a boat, not an incident.
      this.deps.debug(`keysync unreachable: ${String(e)}`)
    } finally {
      clearTimeout(timeout)
      this.inFlight = null
    }
  }
}
